// ElevenLabs Agents: best voices and a Hinglish mode. Numbers come from Twilio, Exotel or a SIP trunk (Plivo).
import crypto from "node:crypto";
import { base, call, digits } from "../wa/http.js";
import { AgentSpec, Report, ToolCall, Values, VoiceProvider } from "./types.js";

const API = () => base("VOICE_BASE_ELEVENLABS", "https://api.elevenlabs.io");
const auth = (v: Values) => ({ "xi-api-key": v.api_key! });
const VARS = { purpose: "", customer_name: "", service: "", booking_when: "", booking_ref: "", call_key: "" };

/** ElevenLabs-Signature: "t=<secs>,v0=<hex HMAC-SHA256(secret, t + "." + body)>". */
export function elevenSign(secret: string, body: string, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v0=${crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}

async function phoneNumbers(v: Values) {
  const j = await call("ElevenLabs", `${API()}/v1/convai/phone-numbers`, { headers: auth(v) });
  return (Array.isArray(j) ? j : j?.phone_numbers ?? []).map((n: any) => ({ id: String(n.phone_number_id), number: String(n.phone_number), provider: String(n.provider || "sip_trunk") }));
}

export const elevenlabs: VoiceProvider = {
  id: "elevenlabs",
  name: "ElevenLabs",
  blurb: "Most natural voices, with a real Hinglish mode. Works with Exotel, Twilio or a Plivo SIP number.",
  pricingUrl: "https://elevenlabs.io/pricing",
  note: "Keeping calls in India needs ElevenLabs' Enterprise India region. Our connection also sets your account's post-call webhook.",
  india: "Calls are processed on ElevenLabs' servers outside India unless you're on their India (Enterprise) region.",
  fields: [
    { key: "api_key", label: "ElevenLabs API key", secret: true, hint: "Profile → API keys" },
    { key: "number", label: "Your number in ElevenLabs", placeholder: "+91 80 1234 5678", pattern: /^\+?[\d\s-]{10,18}$/, patternMsg: "Enter the number with country code." },
    { key: "voice_id", label: "Voice id", optional: true, hint: "optional; from the Voice Library" },
  ],
  steps: [
    "Sign up at [elevenlabs.io](https://elevenlabs.io) and create an **API key** under your profile.",
    "Add your number under **Agents → Phone numbers**: Exotel (native), Twilio, or a Plivo number over SIP ([Exotel guide](https://elevenlabs.io/docs/eleven-agents/phone-numbers/telephony/exotel)).",
    "Paste the key and the number below and press **Connect**. We create the agent, its booking tools and the post-call webhook.",
  ],
  async check(v) {
    const list = await phoneNumbers(v);
    if (!list.some((n: any) => digits(n.number) === digits(v.number))) throw new Error(`ElevenLabs has no number ${v.number}. Add it under Agents → Phone numbers.`);
    return { numbers: list.map((n: any) => ({ id: n.id, number: n.number })) };
  },
  async provision(v, spec: AgentSpec) {
    const out: Values = { ...v };
    const toolIds: string[] = [];
    for (const t of spec.tools) {
      const tool_config = {
        type: "webhook", name: t.name, description: t.description, response_timeout_secs: 20,
        api_schema: {
          url: spec.toolUrl(t.name), method: "POST", content_type: "application/json",
          request_body_schema: {
            type: "object",
            properties: {
              ...t.parameters.properties,
              // Filled by ElevenLabs itself, never by the AI:
              call_key: { type: "string", description: "call id", dynamic_variable: "call_key" },
              caller: { type: "string", description: "caller", dynamic_variable: "system__caller_id" },
              conversation_id: { type: "string", description: "conversation", dynamic_variable: "system__conversation_id" },
            },
            required: t.parameters.required ?? [],
          },
        },
      };
      const key = `tool_${t.name}`;
      if (out[key]) await call("ElevenLabs", `${API()}/v1/convai/tools/${encodeURIComponent(out[key]!)}`, { method: "PATCH", headers: auth(v), json: { tool_config } });
      else out[key] = String((await call("ElevenLabs", `${API()}/v1/convai/tools`, { headers: auth(v), json: { tool_config } }))?.id ?? "");
      toolIds.push(out[key]!);
    }
    const agent = {
      name: spec.name,
      conversation_config: {
        agent: {
          first_message: spec.firstMessage, language: spec.language === "en" ? "en" : "hi", hinglish_mode: spec.language === "hinglish",
          dynamic_variables: { dynamic_variable_placeholders: VARS },
          prompt: { prompt: spec.prompt, tool_ids: toolIds, timezone: "Asia/Kolkata" },
        },
        ...(v.voice_id ? { tts: { voice_id: v.voice_id } } : {}),
      },
    };
    if (out.agent_id) await call("ElevenLabs", `${API()}/v1/convai/agents/${encodeURIComponent(out.agent_id)}`, { method: "PATCH", headers: auth(v), json: agent });
    else out.agent_id = String((await call("ElevenLabs", `${API()}/v1/convai/agents/create`, { headers: auth(v), json: agent }))?.agent_id ?? "");
    if (!out.agent_id) throw new Error("ElevenLabs didn't return an agent id.");
    if (!out.webhook_secret) {
      const w = await call("ElevenLabs", `${API()}/v1/workspace/webhooks`, { headers: auth(v), json: { settings: { auth_type: "hmac", name: "Booking assistant calls", webhook_url: spec.webhookUrl } } });
      out.webhook_id = String(w?.webhook_id ?? ""); out.webhook_secret = String(w?.webhook_secret ?? "");
      await call("ElevenLabs", `${API()}/v1/convai/settings`, { method: "PATCH", headers: auth(v), json: { webhooks: { post_call_webhook_id: out.webhook_id, events: ["transcript", "call_initiation_failure"] } } });
    }
    const n = (await phoneNumbers(v)).find((x: any) => digits(x.number) === digits(v.number));
    if (!n) throw new Error("Number not found in ElevenLabs.");
    out.number_id = n.id; out.number_provider = n.provider;
    await call("ElevenLabs", `${API()}/v1/convai/phone-numbers/${encodeURIComponent(n.id)}`, { method: "PATCH", headers: auth(v), json: { agent_id: spec.inbound ? out.agent_id : null } });
    return out;
  },
  async call(v, req) {
    const path = v.number_provider === "twilio" ? "twilio/outbound-call" : v.number_provider === "exotel" ? "exotel/outbound-call" : "sip-trunk/outbound-call";
    const j = await call("ElevenLabs", `${API()}/v1/convai/${path}`, {
      headers: auth(v),
      json: { agent_id: v.agent_id, agent_phone_number_id: v.number_id, to_number: `+${digits(req.to)}`, conversation_initiation_client_data: { dynamic_variables: req.vars } },
    });
    if (!j?.conversation_id) throw new Error(j?.message || "ElevenLabs didn't start the call.");
    return { providerCallId: String(j.conversation_id) };
  },
  verify(v, raw) {
    if (raw.url.includes("/voice/tool/")) return true; // tool calls aren't signed: the secret address protects them
    const h = raw.headers["elevenlabs-signature"];
    if (!h) return false;
    const t = /t=(\d+)/.exec(h)?.[1], sig = /v0=([a-f0-9]+)/.exec(h)?.[1];
    if (!t || !sig || !v.webhook_secret || Math.abs(Date.now() / 1000 - Number(t)) > 30 * 60) return false;
    const want = crypto.createHmac("sha256", v.webhook_secret).update(`${t}.${raw.body}`).digest("hex");
    return want.length === sig.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig));
  },
  parseTool(raw): ToolCall {
    let j: any = {};
    try { j = JSON.parse(raw.body || "{}"); } catch { /* empty */ }
    const { call_key, caller, conversation_id, ...args } = j ?? {};
    const key = typeof call_key === "string" && call_key ? call_key : undefined;
    // Outgoing calls are identified by our call key; on incoming calls ElevenLabs fills the caller's number.
    return { args, callKey: key, providerCallId: conversation_id, caller: key ? undefined : digits(caller) || undefined };
  },
  parseReport(raw): Report | null {
    let j: any;
    try { j = JSON.parse(raw.body); } catch { return null; }
    const d = j?.data ?? {};
    if (j?.type === "call_initiation_failure") {
      const r = String(d.failure_reason || "");
      return { providerCallId: String(d.conversation_id ?? ""), status: r === "busy" ? "busy" : r === "no-answer" ? "no_answer" : "failed", final: true, callKey: d.conversation_initiation_client_data?.dynamic_variables?.call_key };
    }
    if (j?.type !== "post_call_transcription" || !d.conversation_id) return null;
    const pc = d.metadata?.phone_call ?? {};
    return {
      providerCallId: String(d.conversation_id), callKey: d.conversation_initiation_client_data?.dynamic_variables?.call_key || undefined,
      status: d.status === "failed" ? "failed" : "completed", final: true,
      seconds: Number(d.metadata?.call_duration_secs) || undefined, summary: d.analysis?.transcript_summary || undefined,
      transcript: Array.isArray(d.transcript) ? d.transcript.map((x: any) => `${x.role}: ${x.message ?? ""}`).join("\n") : undefined,
      from: digits(pc.direction === "inbound" ? pc.external_number : pc.agent_number) || undefined, to: digits(pc.direction === "inbound" ? pc.agent_number : pc.external_number) || undefined,
      direction: pc.direction === "inbound" ? "in" : "out",
    };
  },
};
