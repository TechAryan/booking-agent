// Twilio WhatsApp. Inbound is form-encoded and signed with X-Twilio-Signature (HMAC-SHA1 of URL + sorted params).
import crypto from "node:crypto";
import { base, call, digits, download } from "./http.js";
import { Inbound, Values, WaProvider } from "./types.js";

const API = () => base("WA_BASE_TWILIO", "https://api.twilio.com");
const MSG = () => base("WA_BASE_TWILIO_MSG", "https://messaging.twilio.com");
const auth = (v: Values) => ({ Authorization: `Basic ${Buffer.from(`${v.account_sid}:${v.auth_token}`).toString("base64")}` });
const waAddr = (n: string) => `whatsapp:+${digits(n)}`;

/** Twilio's signature: base64(HMAC-SHA1(authToken, url + each param name+value, names sorted)). */
export function twilioSignature(authToken: string, url: string, params: URLSearchParams) {
  const keys = [...new Set([...params.keys()])].sort();
  let data = url;
  for (const k of keys) for (const val of params.getAll(k).sort()) data += k + val;
  return crypto.createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

export const twilio: WaProvider = {
  id: "twilio",
  name: "Twilio",
  blurb: "Global messaging company. Pay-as-you-go: Twilio's small per-message fee plus Meta's price.",
  pricingUrl: "https://www.twilio.com/en-us/whatsapp/pricing",
  fields: [
    { key: "account_sid", label: "Account SID", placeholder: "AC…", pattern: /^AC[a-f0-9]{32}$/i, patternMsg: "The Account SID starts with AC and has 34 characters." },
    { key: "auth_token", label: "Auth Token", secret: true, pattern: /^[a-f0-9]{32}$/i, patternMsg: "The Auth Token is 32 letters and numbers." },
    { key: "number", label: "Your WhatsApp number on Twilio", placeholder: "+91 98765 43210", pattern: /^\+?[\d\s-]{10,18}$/, patternMsg: "Enter the WhatsApp number with country code." },
  ],
  steps: [
    "Sign up at [twilio.com](https://www.twilio.com) and register a **WhatsApp sender** with your number (Messaging → Senders → WhatsApp senders).",
    "Copy the **Account SID** and **Auth Token** from the Twilio Console home page.",
    "Paste them below with your WhatsApp number and press **Connect**. We set the webhook on your sender for you.",
  ],
  ackBody: { type: "text/xml", body: '<?xml version="1.0" encoding="UTF-8"?><Response/>' },
  async check(v) {
    await call("Twilio", `${API()}/2010-04-01/Accounts/${encodeURIComponent(v.account_sid!)}.json`, { headers: auth(v) });
    return { display: `+${digits(v.number)}` };
  },
  async connectWebhook(v, url) {
    const j = await call("Twilio", `${MSG()}/v2/Channels/Senders?Channel=whatsapp&PageSize=50`, { headers: auth(v) });
    const list: any[] = j?.senders ?? j?.data ?? [];
    const s = list.find((x) => digits(x.sender_id) === digits(v.number));
    if (!s) throw new Error(`Twilio has no WhatsApp sender for +${digits(v.number)} on this account. Check the number, or finish registering the sender first.`);
    await call("Twilio", `${MSG()}/v2/Channels/Senders/${encodeURIComponent(s.sid)}`, { headers: auth(v), json: { webhook: { callback_url: url, callback_method: "POST" } } });
  },
  verify(v, raw) {
    const sig = raw.headers["x-twilio-signature"] || "";
    if (!sig || !v.auth_token) return false;
    const params = new URLSearchParams(raw.body);
    const urls = [raw.url, raw.url.replace(/^(https:\/\/[^/]+):443/, "$1")];
    return urls.some((u) => {
      const want = twilioSignature(v.auth_token!, u, params);
      return want.length === sig.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig));
    });
  },
  parse(raw): Inbound[] {
    const p = new URLSearchParams(raw.body);
    const id = p.get("MessageSid") || p.get("SmsMessageSid") || "";
    const phone = digits(p.get("WaId") || p.get("From"));
    if (!id || !phone) return [];
    const m: Inbound = { id, phone, name: p.get("ProfileName") || undefined };
    const n = Number(p.get("NumMedia") || 0);
    const type = p.get("MediaContentType0") || "";
    if (n > 0 && type.startsWith("image/")) m.image = { ref: p.get("MediaUrl0")!, mime: type, caption: p.get("Body") || "" };
    else if (n > 0) m.other = true;
    else m.text = p.get("ButtonText") || p.get("Body") || "";
    return [m];
  },
  async sendText(v, to, text) {
    await call("Twilio", `${API()}/2010-04-01/Accounts/${encodeURIComponent(v.account_sid!)}/Messages.json`, {
      headers: auth(v), form: { From: waAddr(v.number!), To: waAddr(to.phone!), Body: text.slice(0, 1600) },
    });
  },
  media: (v, ref) => download("Twilio", ref, auth(v)),
};
