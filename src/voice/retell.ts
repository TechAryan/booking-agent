// Retell AI. Indian numbers come in over SIP (Plivo). Webhooks and tool calls are signed with the API key.
import crypto from "node:crypto";
import { base, call, digits } from "../wa/http.js";
import { AgentSpec, RawHook, Report, ToolCall, Values, VoiceProvider } from "./types.js";

const API = () => base("VOICE_BASE_RETELL", "https://api.retellai.com");
const auth = (v: Values) => ({ Authorization: `Bearer ${v.api_key}` });
const VARS = { purpose: "", customer_name: "", service: "", booking_when: "", booking_ref: "", call_key: "" };

/** x-retell-signature: "v=<ms>,d=<hex HMAC-SHA256(apiKey, body + ms)>", within 5 minutes. */
export function retellSign(apiKey: string, body: string, ts = Date.now()) {
  return `v=${ts},d=${crypto.createHmac("sha256", apiKey).update(body + ts).digest("hex")}`;
}

export const retell: VoiceProvider = {
  id: "retell",
  name: "Retell AI",
  blurb: "Polished US voice-agent platform, simple API, $10 free credit. Indian numbers connect through Plivo.",
  pricingUrl: "https://www.retellai.com/pricing",
  note: "Retell doesn't say calls stay in India. Indian rules may require that; check with Retell before real customers.",
  india: "Calls are processed on Retell's servers outside India.",
  fields: [
    { key: "api_key", label: "Retell API key", secret: true, hint: "the key with the webhook badge" },
    { key: "number", label: "Your number imported in Retell", placeholder: "+91 80 1234 5678", pattern: /^\+?[\d\s-]{10,18}$/, patternMsg: "Enter the number with country code." },
    { key: "voice_id", label: "Voice id", optional: true, placeholder: "11labs-Anika", hint: "optional; from Retell's voice list" },
  ],
  steps: [
    "Sign up at [retellai.com](https://www.retellai.com) and open **API keys**; copy the key marked with the **webhook** badge.",
    "Rent an Indian number from Plivo (KYC with GST, company registration or Udyam) ([Plivo](https://www.plivo.com/docs/numbers/rent-india-numbers.md)).",
    "In Plivo, point the number at Retell, then import it in Retell ([Plivo guide](https://docs.plivo.com/docs/voice-agents/sip-trunking/integration-guides/retell)).",
    "Paste the key and the number below and press **Connect**. We create the agent and link it to your number.",
  ],
  async check(v) {
    const j = await call("Retell", `${API()}/list-phone-numbers`, { headers: auth(v) });
    const list = (Array.isArray(j) ? j : []).map((n: any) => ({ id: String(n.phone_number), number: String(n.phone_number) }));
    if (!list.some((n) => digits(n.number) === digits(v.number))) throw new Error(`Retell has no number ${v.number}. Import it first (Phone numbers → Import).`);
    return { numbers: list };
  },
  async provision(v, spec: AgentSpec) {
    const llm = {
      general_prompt: spec.prompt, begin_message: spec.firstMessage, start_speaker: "agent", default_dynamic_variables: VARS,
      general_tools: spec.tools.map((t) => ({ type: "custom", name: t.name, description: t.description, url: spec.toolUrl(t.name), method: "POST", parameters: t.parameters, speak_during_execution: false, timeout_ms: 20000, args_at_root: false })),
    };
    let llmId = v.llm_id;
    if (llmId) await call("Retell", `${API()}/update-retell-llm/${encodeURIComponent(llmId)}`, { method: "PATCH", headers: auth(v), json: llm });
    else llmId = String((await call("Retell", `${API()}/create-retell-llm`, { headers: auth(v), json: llm }))?.llm_id ?? "");
    const agent = {
      response_engine: { type: "retell-llm", llm_id: llmId }, agent_name: spec.name, voice_id: v.voice_id || (spec.voice === "male" ? "11labs-Raju" : "11labs-Anika"),
      language: spec.language === "en" ? "en-IN" : spec.language === "hi" ? "hi-IN" : ["hi-IN", "en-IN"],
      webhook_url: spec.webhookUrl, webhook_events: ["call_ended", "call_analyzed"],
      post_call_analysis_data: [{ type: "system-presets", name: "call_summary" }], timezone: "Asia/Kolkata",
    };
    let agentId = v.agent_id;
    if (agentId) await call("Retell", `${API()}/update-agent/${encodeURIComponent(agentId)}`, { method: "PATCH", headers: auth(v), json: agent });
    else agentId = String((await call("Retell", `${API()}/create-agent`, { headers: auth(v), json: agent }))?.agent_id ?? "");
    if (!llmId || !agentId) throw new Error("Retell didn't return the agent ids.");
    const e164 = `+${digits(v.number)}`;
    await call("Retell", `${API()}/update-phone-number/${encodeURIComponent(e164)}`, {
      method: "PATCH", headers: auth(v),
      json: { inbound_agents: spec.inbound ? [{ agent_id: agentId, weight: 1 }] : [], outbound_agents: [{ agent_id: agentId, weight: 1 }] },
    });
    return { ...v, llm_id: llmId, agent_id: agentId };
  },
  async call(v, req) {
    const j = await call("Retell", `${API()}/v2/create-phone-call`, {
      headers: auth(v),
      json: { from_number: `+${digits(v.number)}`, to_number: `+${digits(req.to)}`, override_agent_id: v.agent_id, retell_llm_dynamic_variables: req.vars, metadata: { call_key: req.callKey } },
    });
    if (!j?.call_id) throw new Error("Retell didn't start the call.");
    return { providerCallId: String(j.call_id) };
  },
  verify(v, raw) {
    const m = /v=(\d+),d=([a-f0-9]+)/.exec(raw.headers["x-retell-signature"] || "");
    if (!m || !v.api_key) return false;
    if (Math.abs(Date.now() - Number(m[1])) > 5 * 60_000) return false;
    const want = crypto.createHmac("sha256", v.api_key).update(raw.body + m[1]).digest("hex");
    return want.length === m[2]!.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(m[2]!));
  },
  parseTool(raw): ToolCall {
    let j: any = {};
    try { j = JSON.parse(raw.body || "{}"); } catch { /* empty */ }
    const c = j.call ?? {};
    // Signed by Retell, so the numbers in the call object can be trusted.
    const caller = digits(c.direction === "inbound" ? c.from_number : c.to_number) || undefined;
    return { args: j.args ?? {}, callKey: c.metadata?.call_key || c.retell_llm_dynamic_variables?.call_key || undefined, providerCallId: c.call_id, caller };
  },
  parseReport(raw): Report | null {
    let j: any;
    try { j = JSON.parse(raw.body); } catch { return null; }
    const c = j?.call;
    if (!c?.call_id || !["call_ended", "call_analyzed"].includes(j.event)) return null;
    const r = String(c.disconnection_reason || "");
    const status: Report["status"] = r === "dial_no_answer" ? "no_answer" : r === "dial_busy" ? "busy" : r === "voicemail_reached" ? "voicemail" : /dial_failed|error/.test(r) || c.call_status === "not_connected" || c.call_status === "error" ? "failed" : "completed";
    return {
      providerCallId: String(c.call_id), callKey: c.metadata?.call_key, status,
      final: j.event === "call_analyzed" || status !== "completed",
      seconds: c.duration_ms ? Math.round(c.duration_ms / 1000) : undefined,
      summary: c.call_analysis?.call_summary || undefined, transcript: c.transcript || undefined,
      from: digits(c.from_number) || undefined, to: digits(c.to_number) || undefined, direction: c.direction === "inbound" ? "in" : "out",
    };
  },
};
