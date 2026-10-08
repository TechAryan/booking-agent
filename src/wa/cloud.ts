// Meta's WhatsApp Cloud API: used directly ("Meta direct") and through 360dialog, which speaks the same format.
import crypto from "node:crypto";
import { base, call, digits, download } from "./http.js";
import { Inbound, RawWebhook, Recipient, Values, WaError, WaProvider } from "./types.js";

const GRAPH = () => base("WA_BASE_META", "https://graph.facebook.com") + "/" + (process.env.META_GRAPH_VERSION || "v25.0");
const D360 = () => base("WA_BASE_D360", "https://waba-v2.360dialog.io");

/** Meta's webhook envelope → our messages. Same for 360dialog and Gupshup v3. */
export function parseCloud(body: string): Inbound[] {
  let j: any;
  try { j = JSON.parse(body); } catch { return []; }
  const out: Inbound[] = [];
  for (const entry of j?.entry ?? []) {
    for (const ch of entry?.changes ?? []) {
      if (ch?.field && ch.field !== "messages") continue;
      const v = ch?.value ?? {};
      const contacts: any[] = v.contacts ?? [];
      for (const m of v.messages ?? []) {
        const c = contacts.find((x) => (m.from && x.wa_id === m.from) || (m.from_user_id && x.user_id === m.from_user_id)) ?? contacts[0] ?? {};
        const phone = digits(m.from ?? c.wa_id);
        const msg: Inbound = { id: String(m.id ?? ""), phone: phone || undefined, user: m.from_user_id ?? c.user_id ?? undefined, name: c.profile?.name };
        if (m.type === "text") msg.text = String(m.text?.body ?? "");
        else if (m.type === "image" && m.image) msg.image = { ref: String(m.image.id ?? m.image.url ?? ""), mime: String(m.image.mime_type || "image/jpeg"), caption: String(m.image.caption ?? "") };
        else if (m.type === "button") msg.text = String(m.button?.text ?? m.button?.payload ?? "");
        else if (m.type === "interactive") msg.text = String(m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? "");
        else msg.other = true;
        if (msg.id && (msg.phone || msg.user)) out.push(msg);
      }
    }
  }
  return out;
}

const textBody = (to: Recipient, text: string) => ({
  messaging_product: "whatsapp", recipient_type: "individual",
  ...(to.phone ? { to: to.phone } : { recipient: to.user }),
  type: "text", text: { preview_url: false, body: text.slice(0, 4096) },
});

// ------------------------------------------------------------------ Meta direct

const metaAuth = (v: Values) => ({ Authorization: `Bearer ${v.token}` });

export const meta: WaProvider = {
  id: "meta",
  name: "Meta direct",
  tag: "Cheapest",
  blurb: "WhatsApp's own Cloud API. No platform fee, you pay Meta only. Setup is technical (about 30 minutes).",
  pricingUrl: "https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing",
  note: "Best for technical owners. You need a Meta business portfolio, a developer app and a permanent token.",
  fields: [
    { key: "phone_number_id", label: "Phone number ID", placeholder: "106540352242922", pattern: /^\d{6,25}$/, patternMsg: "The Phone number ID is a long number." },
    { key: "waba_id", label: "WhatsApp Business Account ID", placeholder: "102290129340398", pattern: /^\d{6,25}$/, patternMsg: "The WhatsApp Business Account ID is a long number." },
    { key: "token", label: "Permanent access token", secret: true, placeholder: "EAAG…" },
    { key: "app_secret", label: "App secret", secret: true, hint: "App settings → Basic", pattern: /^[a-f0-9]{32}$/i, patternMsg: "The App secret is 32 letters and numbers (App settings → Basic → Show)." },
  ],
  steps: [
    "In [developers.facebook.com](https://developers.facebook.com), create an app with the **WhatsApp** use case, linked to your business portfolio.",
    "Under **WhatsApp → API setup**, add and verify your phone number, and add a payment card in WhatsApp Manager.",
    "In **Business settings → System users**, create an admin system user, assign it the app and your WhatsApp account, and generate a **permanent token** with `whatsapp_business_messaging` and `whatsapp_business_management`.",
    "Copy the **Phone number ID** and **WhatsApp Business Account ID** (WhatsApp → API setup) and the **App secret** (App settings → Basic).",
    "Paste all four below and press **Connect**. We point your number's webhook at us.",
  ],
  async check(v) {
    const j = await call("Meta", `${GRAPH()}/${encodeURIComponent(v.phone_number_id!)}?fields=display_phone_number,verified_name`, { headers: metaAuth(v) });
    return { display: j?.display_phone_number || j?.verified_name || "" };
  },
  async connectWebhook(v, url, secret) {
    // The app must be subscribed to the WhatsApp account; then a per-number override sends this number's messages to us.
    await call("Meta", `${GRAPH()}/${encodeURIComponent(v.waba_id!)}/subscribed_apps`, { method: "POST", headers: metaAuth(v), json: {} });
    await call("Meta", `${GRAPH()}/${encodeURIComponent(v.phone_number_id!)}`, { headers: metaAuth(v), json: { webhook_configuration: { override_callback_uri: url, verify_token: secret } } });
  },
  async disconnectWebhook(v) {
    await call("Meta", `${GRAPH()}/${encodeURIComponent(v.phone_number_id!)}`, { headers: metaAuth(v), json: { webhook_configuration: { override_callback_uri: "" } } });
  },
  verify(v, raw) {
    const sig = String(raw.headers["x-hub-signature-256"] || "").replace(/^sha256=/, "");
    if (!sig || !v.app_secret) return false;
    const want = crypto.createHmac("sha256", v.app_secret).update(raw.body, "utf8").digest("hex");
    return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
  },
  parse: (raw) => parseCloud(raw.body),
  async sendText(v, to, text) {
    await call("Meta", `${GRAPH()}/${encodeURIComponent(v.phone_number_id!)}/messages`, { headers: metaAuth(v), json: textBody(to, text) });
  },
  async media(v, ref) {
    const j = await call("Meta", `${GRAPH()}/${encodeURIComponent(ref)}`, { headers: metaAuth(v) });
    if (!j?.url) throw new WaError("Meta: photo link missing");
    return download("Meta", j.url, metaAuth(v));
  },
  async markRead(v, id) {
    await call("Meta", `${GRAPH()}/${encodeURIComponent(v.phone_number_id!)}/messages`, { headers: metaAuth(v), json: { messaging_product: "whatsapp", status: "read", message_id: id, typing_indicator: { type: "text" } } });
  },
};

// ------------------------------------------------------------------ 360dialog

const dAuth = (v: Values) => ({ "D360-API-KEY": v.api_key! });

export const d360: WaProvider = {
  id: "d360",
  name: "360dialog",
  blurb: "Official WhatsApp partner with a flat monthly fee and Meta's prices passed through. One API key per number.",
  pricingUrl: "https://www.360dialog.com/pricing",
  fields: [{ key: "api_key", label: "360dialog API key", secret: true, placeholder: "Your channel's API key" }],
  steps: [
    "Sign up at [360dialog.com](https://www.360dialog.com) and connect your number in the **360dialog Hub** (log in with Facebook when asked).",
    "In the Hub, open your number and press **Generate API key**. Copy it; it's shown once.",
    "Paste it below and press **Connect**. We set the webhook for you.",
  ],
  async check(v) {
    const j = await call("360dialog", `${D360()}/health_status?fields=display_phone_number`, { headers: dAuth(v) });
    return { display: j?.display_phone_number || "" };
  },
  async connectWebhook(v, url, secret) {
    await call("360dialog", `${D360()}/v1/configs/webhook`, { headers: dAuth(v), json: { url, headers: { "X-Webhook-Secret": secret } } });
  },
  parse: (raw) => parseCloud(raw.body),
  async sendText(v, to, text) {
    await call("360dialog", `${D360()}/messages`, { headers: dAuth(v), json: textBody(to, text) });
  },
  async media(v, ref) {
    const j = await call("360dialog", `${D360()}/${encodeURIComponent(ref)}`, { headers: dAuth(v) });
    if (!j?.url) throw new WaError("360dialog: photo link missing");
    // Media links point at Meta's CDN; 360dialog serves the same path on its own host.
    const u = new URL(String(j.url));
    return download("360dialog", `${D360()}${u.pathname}${u.search}`, dAuth(v));
  },
  async markRead(v, id) {
    await call("360dialog", `${D360()}/messages`, { headers: dAuth(v), json: { messaging_product: "whatsapp", status: "read", message_id: id, typing_indicator: { type: "text" } } });
  },
};
