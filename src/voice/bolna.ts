// Bolna (Indian voice-AI platform). India routing needs: Plivo numbers, Azure OpenAI on Bolna's keys, Indian
// speech providers, and no custom LLM or own keys. That's exactly the setup we create.
import { base, call, digits } from "../wa/http.js";
import { AgentSpec, RawHook, Report, ToolCall, Values, VoiceProvider } from "./types.js";

const API = () => base("VOICE_BASE_BOLNA", "https://api.bolna.ai");
const auth = (v: Values) => ({ Authorization: `Bearer ${v.api_key}` });
const toBolnaVars = (s: string) => s.replace(/\{\{(\w+)\}\}/g, "{$1}");
const FINAL: Record<string, Report["status"]> = { completed: "completed", "no-answer": "no_answer", busy: "busy", failed: "failed", canceled: "failed", stopped: "failed", error: "failed", "balance-low": "failed" };

async function numbers(v: Values) {
  const j = await call("Bolna", `${API()}/phone-numbers/all`, { headers: auth(v) });
  return (Array.isArray(j) ? j : j?.data ?? []).map((n: any) => ({ id: String(n.id), number: String(n.phone_number), provider: String(n.telephony_provider || "plivo") }));
}

function toolsConfig(spec: AgentSpec) {
  const tools = spec.tools.map((t) => ({
    name: t.name, key: "custom_task", description: t.description,
    parameters: { type: "object", properties: { ...t.parameters.properties, call_key: { type: "string", description: "Filled automatically, never ask" }, execution_id: { type: "string", description: "Filled automatically, never ask" } }, required: t.parameters.required ?? [] },
  }));
  const tools_params = Object.fromEntries(spec.tools.map((t) => [t.name, {
    method: "POST", url: spec.toolUrl(t.name), api_token: null,
    param: JSON.stringify({ ...Object.fromEntries(Object.keys(t.parameters.properties).map((k) => [k, `%(${k})s`])), call_key: "%(call_key)s", execution_id: "%(execution_id)s" }),
  }]));
  return { tools, tools_params };
}

export const bolna: VoiceProvider = {
  id: "bolna",
  name: "Bolna",
  tag: "Recommended",
  blurb: "Indian voice-AI platform with Indian numbers and voices. Calls can stay in India. $5 free credit.",
  pricingUrl: "https://www.bolna.ai/pricing",
  india: "Calls run on Bolna's India servers (Plivo number, Azure OpenAI, Sarvam voice). Recordings and logs are kept by Bolna.",
  fields: [
    { key: "api_key", label: "Bolna API key", secret: true, hint: "Developers → API Keys" },
    { key: "number", label: "Your Bolna phone number", placeholder: "+91 80 1234 5678", pattern: /^\+?[\d\s-]{10,18}$/, patternMsg: "Enter the number you bought in Bolna, with country code." },
  ],
  steps: [
    "Sign up at [platform.bolna.ai](https://platform.bolna.ai); you get $5 free credit ([pricing](https://www.bolna.ai/pricing)).",
    "Submit the **India compliance form** once: name, company, CIN and GST certificates ([Bolna KYC](https://www.bolna.ai/docs/compliance-application/introduction)). Approval takes 1–2 working days.",
    "Buy a number under **Deploy → My numbers**: pick a Mumbai (022) or Bengaluru (080) **Plivo** number, about $5 a month ([numbers](https://www.bolna.ai/docs/guides/buying-phone-numbers)).",
    "Open **Developers → API Keys**, create a key and copy it.",
    "Paste it below with your number and press **Connect**. We create the agent, its booking tools and the call reports for you.",
  ],
  async check(v) {
    await call("Bolna", `${API()}/user/me`, { headers: auth(v) });
    const list = await numbers(v);
    const mine = list.find((n: any) => digits(n.number) === digits(v.number));
    if (!mine) throw new Error(`Bolna has no number ${v.number} on this account. Buy it under Deploy → My numbers, or check the number.`);
    return { numbers: list.map((n: any) => ({ id: n.id, number: n.number })) };
  },
  async provision(v, spec) {
    const list = await numbers(v);
    const mine = list.find((n: any) => digits(n.number) === digits(v.number))!;
    const tel = { provider: mine?.provider || "plivo", format: "wav" };
    const lang = spec.language === "en" ? "en" : "hi";
    const body = {
      agent_config: {
        agent_name: spec.name,
        agent_welcome_message: spec.firstMessage,
        webhook_url: spec.webhookUrl,
        call_summary_enabled: true,
        calling_guardrails: { call_start_hour: spec.startHour, call_end_hour: spec.endHour },
        tasks: [{
          task_type: "conversation",
          toolchain: { execution: "parallel", pipelines: [["transcriber", "llm", "synthesizer"]] },
          tools_config: {
            llm_agent: { agent_type: "simple_llm_agent", agent_flow_type: "streaming", llm_config: { provider: "azure-openai", model: "gpt-4.1-mini", max_tokens: 200, temperature: 0.2 } },
            synthesizer: { provider: "sarvam", provider_config: { voice: spec.voice === "male" ? "Rahul" : "Suhani", voice_id: spec.voice === "male" ? "rahul" : "suhani", model: "bulbul:v3", language: lang }, stream: true, buffer_size: 150, audio_format: "wav" },
            transcriber: { provider: "sarvam", model: "saaras:v4", language: lang, stream: true, endpointing: 500 },
            input: tel, output: tel,
            api_tools: toolsConfig(spec),
          },
          task_config: { call_terminate: 300, hangup_after_silence: 12, voicemail: true },
        }],
      },
      agent_prompts: { task_1: { system_prompt: toBolnaVars(spec.prompt) } },
    };
    let agentId = v.agent_id;
    if (agentId) await call("Bolna", `${API()}/v2/agent/${encodeURIComponent(agentId)}`, { method: "PUT", headers: auth(v), json: body });
    else agentId = String((await call("Bolna", `${API()}/v2/agent`, { headers: auth(v), json: body }))?.agent_id ?? "");
    if (!agentId) throw new Error("Bolna didn't return an agent id.");
    if (spec.inbound) await call("Bolna", `${API()}/inbound/setup`, { headers: auth(v), json: { agent_id: agentId, phone_number_id: mine.id } });
    else if (v.inbound_on === "1") await call("Bolna", `${API()}/inbound/unlink`, { headers: auth(v), json: { phone_number_id: mine.id } }).catch(() => undefined);
    return { ...v, agent_id: agentId, number_id: mine.id, inbound_on: spec.inbound ? "1" : "" };
  },
  async call(v, req) {
    const j = await call("Bolna", `${API()}/call`, {
      headers: auth(v),
      json: { agent_id: v.agent_id, recipient_phone_number: `+${digits(req.to)}`, from_phone_number: `+${digits(v.number)}`, user_data: req.vars },
    });
    if (!j?.execution_id) throw new Error("Bolna didn't start the call.");
    return { providerCallId: String(j.execution_id) };
  },
  parseTool(raw: RawHook): ToolCall {
    let j: any = {};
    try { j = JSON.parse(raw.body || "{}"); } catch { /* empty */ }
    const { call_key, execution_id, ...args } = j ?? {};
    const real = (x: unknown) => (typeof x === "string" && x && !/^%\(|^\{/.test(x) ? x : undefined); // unfilled templates stay as text
    return { args, callKey: real(call_key), providerCallId: real(execution_id) };
  },
  // Tool calls aren't signed, so the caller's number comes from Bolna's own call record.
  async lookupCall(v, id) {
    const j = await call("Bolna", `${API()}/executions/${encodeURIComponent(id)}`, { headers: auth(v) });
    const t = j?.telephony_data ?? {};
    const inbound = t.call_type === "inbound";
    return { caller: digits(inbound ? t.from_number : t.to_number) || undefined, direction: inbound ? "in" : "out", callKey: j?.context_details?.recipient_data?.call_key ?? j?.context_details?.call_key };
  },
  parseReport(raw): Report | null {
    let j: any;
    try { j = JSON.parse(raw.body); } catch { return null; }
    if (!j?.id) return null;
    const t = j.telephony_data ?? {};
    const st = String(j.status || "");
    const final = st in FINAL;
    return {
      providerCallId: String(j.id), callKey: j.context_details?.recipient_data?.call_key,
      status: final ? (j.answered_by_voice_mail ? "voicemail" : FINAL[st]!) : "in_progress", final,
      seconds: Math.round(Number(t.duration ?? j.conversation_duration ?? 0)) || undefined,
      summary: j.summary || undefined, transcript: j.transcript || undefined,
      from: digits(t.from_number) || undefined, to: digits(t.to_number) || undefined, direction: t.call_type === "inbound" ? "in" : t.call_type ? "out" : undefined,
    };
  },
};
