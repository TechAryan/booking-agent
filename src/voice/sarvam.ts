// Sarvam Voice Agents (Indian). Agents and tools are built in Sarvam's dashboard (no public API for that yet):
// we give the owner the exact prompt and tool addresses to paste, then place calls and read reports by API.
import { base, call, digits } from "../wa/http.js";
import { Report, ToolCall, Values, VoiceProvider } from "./types.js";

const API = () => base("VOICE_BASE_SARVAM", "https://apps.sarvam.ai");
const auth = (v: Values) => ({ "X-API-Key": v.api_key! });

export const sarvam: VoiceProvider = {
  id: "sarvam",
  name: "Sarvam",
  tag: "Beta",
  manual: true,
  blurb: "Indian company, best for Indian languages. Agent set up in Sarvam's dashboard with our step-by-step text.",
  pricingUrl: "https://docs.sarvam.ai/api/pricing",
  note: "Sarvam uses its own AI on calls (not your chosen AI); our booking rules still apply through the tools.",
  india: "Sarvam is an Indian company; it hasn't published where call data is stored.",
  fields: [
    { key: "api_key", label: "Sarvam API key", secret: true, hint: "Settings → API Key" },
    { key: "org_id", label: "Org ID", hint: "from the dashboard address bar", pattern: /^[\w-]{3,64}$/, patternMsg: "Copy the org id from the address bar." },
    { key: "workspace_id", label: "Workspace ID", pattern: /^[\w-]{3,64}$/, patternMsg: "Copy the workspace id from the address bar." },
    { key: "app_id", label: "Agent (app) ID", pattern: /^[\w-]{3,64}$/, patternMsg: "Copy the agent id after you create it (step 3)." },
    { key: "app_version", label: "Agent version", placeholder: "1", pattern: /^\d{1,4}$/, patternMsg: "The version is a number, e.g. 1." },
    { key: "connection_id", label: "Phone connection ID", pattern: /^[\w-]{3,64}$/, patternMsg: "Copy the connection id from Deploy → Phone numbers." },
    { key: "number", label: "Your number", placeholder: "+91 80 1234 5678", pattern: /^\+?[\d\s-]{10,18}$/, patternMsg: "Enter the number with country code." },
  ],
  steps: [
    "Sign up at [dashboard.sarvam.ai](https://dashboard.sarvam.ai); ₹100 free credit ([pricing](https://docs.sarvam.ai/api/pricing)).",
    "Connect a number under **Deploy → Phone numbers → Add connection** (Plivo, Exotel or Vobiz) ([quickstart](https://docs.sarvam.ai/conversations/quickstart.md)).",
    "Create a voice agent and paste the **instructions** and **tools** we show after you connect (each tool: method POST, the address shown, body as listed).",
    "Copy the API key, org and workspace ids (from the address bar), agent id and version, and connection id; paste them below and press **Connect**.",
  ],
  async check(v) {
    return { numbers: [{ id: v.connection_id!, number: v.number! }], note: "Sarvam has no quick check: use Test call to my phone to confirm everything." };
  },
  async provision(v, spec) { return { ...v, webhook_url: spec.webhookUrl }; },
  async call(v, req) {
    const j = await call("Sarvam", `${API()}/api/outbounds/v1/orgs/${encodeURIComponent(v.org_id!)}/workspaces/${encodeURIComponent(v.workspace_id!)}/outbounds`, {
      headers: auth(v),
      json: {
        app_config: { app_id: v.app_id, app_version: Number(v.app_version || 1), connection_config: { connection_id: v.connection_id, agent_phone_number: `+${digits(v.number)}` }, agent_variables: req.vars },
        user_config: { user_phone_number: `+${digits(req.to)}` },
        webhook_config: { url: v.webhook_url, metadata: { call_key: req.callKey } },
      },
    });
    if (!j?.attempt_id) throw new Error("Sarvam didn't start the call.");
    return { providerCallId: String(j.attempt_id) };
  },
  parseTool(raw): ToolCall {
    let j: any = {};
    try { j = JSON.parse(raw.body || "{}"); } catch { /* empty */ }
    const { call_key, caller, ...args } = j ?? {};
    const key = typeof call_key === "string" && call_key && !call_key.startsWith("@") ? call_key : undefined;
    return { args, callKey: key, caller: key ? undefined : digits(caller) || undefined };
  },
  parseReport(raw): Report | null {
    let j: any;
    try { j = JSON.parse(raw.body); } catch { return null; }
    const id = j?.attempt_id ?? j?.interaction_id;
    if (!id) return null;
    const st = String(j.status || "connected");
    return {
      providerCallId: String(id), callKey: j.webhook_config?.metadata?.call_key ?? j.metadata?.call_key,
      status: st === "connected" ? "completed" : st === "no_answer" ? "no_answer" : st === "busy" ? "busy" : "failed", final: true,
      seconds: Number(j.duration) || undefined,
      transcript: Array.isArray(j.interaction_transcript) ? j.interaction_transcript.map((x: any) => `${x.role}: ${x.en_text ?? x.indic_text ?? ""}`).join("\n") : undefined,
      from: digits(j.user_phone_number) || undefined, direction: j.attempt_id ? "out" : "in",
    };
  },
};
