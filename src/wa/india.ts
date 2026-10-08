// Indian WhatsApp platforms: WATI, Gallabox, Exotel. Their webhook formats are partly undocumented, so parsing is
// deliberately forgiving; they are marked Beta until confirmed with real accounts.
import crypto from "node:crypto";
import { base, call, digits, download } from "./http.js";
import { Inbound, Values, WaError, WaProvider } from "./types.js";

const httpsOnly = (u: string) => (process.env.NODE_ENV === "test" ? /^https?:\/\//.test(u) : /^https:\/\//.test(u));

// ------------------------------------------------------------------ WATI

const watiBase = (v: Values) => String(v.endpoint || "").trim().replace(/\/+$/, "").replace(/\/api\/v\d.*$/, "");
const watiAuth = (v: Values) => ({ Authorization: `Bearer ${String(v.token || "").trim().replace(/^Bearer\s+/i, "")}` });

export const wati: WaProvider = {
  id: "wati",
  name: "WATI",
  tag: "Beta",
  blurb: "Popular Indian WhatsApp inbox. Needs the Pro plan or higher (lower plans have no webhooks).",
  pricingUrl: "https://www.wati.io/pricing/",
  note: "WATI's Growth plan has no webhooks, so the assistant can't receive messages on it. Use Pro or Business.",
  fields: [
    { key: "endpoint", label: "API endpoint", placeholder: "https://live-mt-server.wati.io/123456", pattern: /^https?:\/\/[^\s/]+(\/[\w.-]+)*\/?$/, patternMsg: "Copy the API Endpoint exactly as WATI shows it (starts with https://)." },
    { key: "token", label: "Access token", secret: true },
  ],
  steps: [
    "In WATI, open **API Docs** (left menu) and copy the **API Endpoint** and **Access Token**.",
    "Paste both below and press **Connect**. We add the webhook for you.",
  ],
  manualWebhook: [
    "If messages don't arrive: in WATI open **Connectors → Webhooks → Add Webhook**, paste {url}, set Status to **Enabled**, tick **Message Received**, and save.",
  ],
  async check(v) {
    if (!httpsOnly(watiBase(v))) throw new WaError("The API endpoint must start with https://");
    const j = await call("WATI", `${watiBase(v)}/api/v1/whatsApp/phoneNumbers`, { headers: watiAuth(v) });
    const n = (j?.result ?? j?.phoneNumbers ?? [])[0];
    return { display: n?.displayPhoneNumber || "" };
  },
  async connectWebhook(v, url) {
    await call("WATI", `${watiBase(v)}/api/v2/webhookEndpoints`, { headers: watiAuth(v), json: [{ url, status: 1, eventTypes: ["message"] }] });
  },
  parse(raw): Inbound[] {
    let j: any;
    try { j = JSON.parse(raw.body); } catch { return []; }
    if (j?.eventType && j.eventType !== "message") return [];
    if (j?.owner === true) return []; // our own outgoing messages
    const phone = digits(j?.waId);
    const id = String(j?.whatsappMessageId ?? j?.id ?? "");
    if (!id || !phone) return [];
    const m: Inbound = { id, phone, name: j.senderName || undefined };
    if (j.type === "text" || (!j.type && j.text)) m.text = String(j.text ?? "");
    else if (j.type === "image" && j.data) m.image = { ref: String(j.data), mime: "image/jpeg", caption: String(j.text ?? "") };
    else if (j.listReply || j.buttonReply) m.text = String(j.listReply?.title ?? j.buttonReply?.text ?? "");
    else m.other = true;
    return [m];
  },
  async sendText(v, to, text) {
    const j = await call("WATI", `${watiBase(v)}/api/v1/sendSessionMessage/${to.phone}?messageText=${encodeURIComponent(text.slice(0, 4096))}`, { method: "POST", headers: watiAuth(v) });
    if (j && (j.result === false || j.ok === false)) throw new WaError(`WATI: ${j.info || j.message || "message not sent"}`);
  },
  async media(v, ref) {
    // `data` is either a full link or a file name like data/images/….jpg.
    const fileName = /fileName=([^&]+)/.exec(ref)?.[1] ?? (/^https?:/.test(ref) ? "" : ref);
    const url = fileName ? `${watiBase(v)}/api/v1/getMedia?fileName=${fileName}` : ref;
    return download("WATI", url, watiAuth(v));
  },
};

// ------------------------------------------------------------------ Gallabox

const GB = () => base("WA_BASE_GALLABOX", "https://server.gallabox.com");
const gbAuth = (v: Values) => ({ apiKey: v.api_key!, apiSecret: v.api_secret! });

export const gallabox: WaProvider = {
  id: "gallabox",
  name: "Gallabox",
  tag: "Beta",
  blurb: "Indian WhatsApp platform with shared inbox. Webhooks need the Essential plan or higher.",
  pricingUrl: "https://gallabox.com/pricing",
  fields: [
    { key: "api_key", label: "API key", placeholder: "From Settings → Developer → API Keys" },
    { key: "api_secret", label: "API secret", secret: true },
    { key: "channel_id", label: "Channel ID", placeholder: "Settings → WhatsApp channel → Copy ID", pattern: /^[\w-]{6,64}$/, patternMsg: "Copy the Channel ID from Settings → WhatsApp channel." },
    { key: "number", label: "Your WhatsApp number", placeholder: "+91 98765 43210", pattern: /^\+?[\d\s-]{10,18}$/, patternMsg: "Enter the WhatsApp number with country code." },
  ],
  steps: [
    "In Gallabox open **Settings → Developer → API Keys → Add new**, and copy the **API key** and **API secret** (shown once).",
    "Open **Settings → WhatsApp channel** and copy the **Channel ID**.",
    "Paste them below with your number and press **Connect**.",
  ],
  manualWebhook: [
    "In Gallabox open **Settings → Webhooks → Add Webhook**.",
    "Request URL: {url} · Method **POST** · Secret: {secret}",
    "Tick the event **Message.Received** and save.",
  ],
  async check(v) {
    await call("Gallabox", `${GB()}/devapi/test`, { headers: gbAuth(v) });
    return { display: `+${digits(v.number)}` };
  },
  verify(_v, raw, secret) {
    // Signed with the secret we gave them (when they filled it in); the secret in the URL is checked anyway.
    const sig = raw.headers["x-gallabox-signature"];
    if (!sig) return true;
    const want = crypto.createHmac("sha256", secret).update(raw.body, "utf8").digest("base64");
    return want.length === sig.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig));
  },
  parse(raw): Inbound[] {
    let j: any;
    try { j = JSON.parse(raw.body); } catch { return []; }
    const ev = raw.headers["x-event-name"] || j?.event || "";
    if (ev && !/message\.received/i.test(ev)) return [];
    const d = j?.data ?? j;
    const w = d?.whatsapp ?? d?.message?.whatsapp ?? d?.message ?? {};
    const phone = digits(d?.sender?.phone ?? d?.contact?.phone ?? d?.from ?? w?.from);
    const id = String(d?.id ?? d?.messageId ?? w?.id ?? "");
    if (!id || !phone) return [];
    const m: Inbound = { id, phone, name: d?.contact?.name ?? d?.sender?.name };
    const type = w?.type ?? d?.type;
    if (type === "text") m.text = String(w?.text?.body ?? w?.text ?? "");
    else if (type === "image") m.image = { ref: String(w?.image?.link ?? w?.image?.url ?? w?.image?.id ?? ""), mime: String(w?.image?.mime_type ?? w?.image?.mimeType ?? "image/jpeg"), caption: String(w?.image?.caption ?? "") };
    else if (type === "interactive" || type === "button") m.text = String(w?.interactive?.button_reply?.title ?? w?.interactive?.list_reply?.title ?? w?.button?.text ?? "");
    else m.other = true;
    return [m];
  },
  async sendText(v, to, text) {
    await call("Gallabox", `${GB()}/devapi/messages/whatsapp`, {
      headers: gbAuth(v), json: { channelId: v.channel_id, channelType: "whatsapp", recipient: { phone: to.phone }, whatsapp: { type: "text", text: { body: text.slice(0, 4096) } } },
    });
  },
  media: (v, ref) => download("Gallabox", ref, gbAuth(v)),
};

// ------------------------------------------------------------------ Exotel

const exBase = (v: Values) => process.env.WA_BASE_EXOTEL || `https://${String(v.subdomain || "api.exotel.com").replace(/^https?:\/\//, "").replace(/\/.*$/, "")}`;
const exAuth = (v: Values) => ({ Authorization: `Basic ${Buffer.from(`${v.api_key}:${v.api_token}`).toString("base64")}` });

export const exotel: WaProvider = {
  id: "exotel",
  name: "Exotel",
  tag: "Beta",
  blurb: "Indian cloud telephony company with WhatsApp. Good if you already use Exotel for calls.",
  pricingUrl: "https://exotel.com/pricing/",
  note: "Exotel's team sets the webhook for messages customers start: you'll ask their support once (we give you the exact text).",
  fields: [
    { key: "account_sid", label: "Account SID", placeholder: "yourcompany1" },
    { key: "api_key", label: "API key" },
    { key: "api_token", label: "API token", secret: true },
    { key: "subdomain", label: "API subdomain", placeholder: "api.in.exotel.com", hint: "Mumbai: api.in.exotel.com · Singapore: api.exotel.com", pattern: /^(https?:\/\/)?api(\.in)?\.exotel\.com\/?$/, patternMsg: "Use api.in.exotel.com (Mumbai) or api.exotel.com (Singapore), as shown in Exotel's API settings." },
    { key: "number", label: "Your WhatsApp number", placeholder: "+91 80 1234 5678", pattern: /^\+?[\d\s-]{10,18}$/, patternMsg: "Enter the WhatsApp number with country code." },
  ],
  steps: [
    "In your Exotel account, enable **WhatsApp** and connect your number.",
    "Open **API settings** and copy the **Account SID**, **API key**, **API token** and **subdomain**.",
    "Paste them below with your number and press **Connect**.",
  ],
  manualWebhook: [
    "Email Exotel support: \"Please set the WhatsApp incoming message callback URL for +{number} to {url}\".",
    "Replies to messages we send already come back on their own, so you only need this once.",
  ],
  async check(v) {
    await call("Exotel", `${exBase(v)}/v1/Accounts/${encodeURIComponent(v.account_sid!)}/Balance.json`, { headers: exAuth(v) });
    return { display: `+${digits(v.number)}` };
  },
  parse(raw): Inbound[] {
    let j: any;
    try { j = JSON.parse(raw.body); } catch { return []; }
    const out: Inbound[] = [];
    const list: any[] = j?.whatsapp?.messages ?? (j?.message ? [j] : []);
    for (const it of list) {
      const m = it.message ?? it; // newer docs: { event, message: {...}, contact }; older: whatsapp.messages[]
      if (it.callback_type && it.callback_type !== "incoming_message") continue;
      if (j?.event && !/incoming|message/i.test(j.event)) continue;
      const phone = digits(m.from);
      const c = m.content ?? m;
      const text = c.text?.body ?? (typeof c.text === "string" ? c.text : undefined);
      // Older payloads may lack an id: fall back to sender + time + content.
      const id = String(m.sid ?? m.id ?? crypto.createHash("sha256").update(`${phone}|${m.timestamp}|${JSON.stringify(c)}`).digest("hex").slice(0, 32));
      if (!phone) continue;
      const msg: Inbound = { id, phone, name: m.profile_name ?? it.contact?.profile?.name ?? j?.contact?.profile?.name };
      if (c.type === "text" || (!c.type && text)) msg.text = String(text ?? "");
      else if (c.type === "image") msg.image = { ref: String(c.image?.url ?? c.image?.id ?? ""), mime: String(c.image?.mime_type ?? "image/jpeg"), caption: String(c.image?.caption ?? "") };
      else msg.other = true;
      out.push(msg);
    }
    return out;
  },
  async sendText(v, to, text) {
    const j = await call("Exotel", `${exBase(v)}/v2/accounts/${encodeURIComponent(v.account_sid!)}/messages`, {
      headers: exAuth(v),
      json: { whatsapp: { messages: [{ from: `+${digits(v.number)}`, to: `+${to.phone}`, content: { recepient_type: "individual", type: "text", text: { body: text.slice(0, 4096), preview_url: false } } }] } },
    });
    const r = j?.response?.whatsapp?.messages?.[0];
    if (r && r.status && r.status !== "success") throw new WaError(`Exotel: ${r.error_data?.message || "message not sent"}`);
  },
  async media(v, ref) {
    const url = /^https?:/.test(ref) ? ref : `${exBase(v)}/v2/accounts/${encodeURIComponent(v.account_sid!)}/media/${encodeURIComponent(ref)}`;
    return download("Exotel", url, exAuth(v));
  },
};
