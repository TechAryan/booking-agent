// Gupshup (self-serve). Inbound comes in Gupshup's own v2 format or Meta's (v3); we read both.
import { base, call, digits, download } from "./http.js";
import { parseCloud } from "./cloud.js";
import { Inbound, Values, WaProvider } from "./types.js";

const API = () => base("WA_BASE_GUPSHUP", "https://api.gupshup.io");
const auth = (v: Values) => ({ apikey: v.api_key! });

export const gupshup: WaProvider = {
  id: "gupshup",
  name: "Gupshup",
  blurb: "Large Indian WhatsApp partner, prepaid wallet in rupees.",
  pricingUrl: "https://www.gupshup.io/pricing",
  fields: [
    { key: "api_key", label: "API key", secret: true, hint: "Top-right profile menu in Gupshup" },
    { key: "app_id", label: "App ID", placeholder: "e.g. 9f3c…-…", pattern: /^[\w-]{6,64}$/, patternMsg: "Copy the App ID from your app's Settings tab." },
    { key: "app_name", label: "App name", placeholder: "GlowSalonBot", pattern: /^[\w-]{2,64}$/, patternMsg: "The App name is the short name of your Gupshup app (no spaces)." },
    { key: "number", label: "Your WhatsApp number", placeholder: "+91 98765 43210", pattern: /^\+?[\d\s-]{10,18}$/, patternMsg: "Enter the WhatsApp number with country code." },
  ],
  steps: [
    "Sign up at [gupshup.io](https://www.gupshup.io), create a **WhatsApp app** and connect your number.",
    "Open the app's **Settings** tab and copy the **App ID** and **App name**. Your **API key** is under the profile menu (top right).",
    "Paste them below with your number and press **Connect**. We add our webhook to your app.",
  ],
  manualWebhook: [
    "If messages don't arrive: in Gupshup open your app → **Webhooks**, paste this URL as the callback and save: {url}",
  ],
  async check(v) {
    await call("Gupshup", `${API()}/wa/app/${encodeURIComponent(v.app_id!)}/template?pageSize=1`, { headers: auth(v) });
    return { display: `+${digits(v.number)}` };
  },
  async connectWebhook(v, url) {
    await call("Gupshup", `${API()}/wa/app/${encodeURIComponent(v.app_id!)}/subscription`, {
      headers: auth(v), form: { url, tag: "booking-assistant", modes: "MESSAGE", version: "2", doCheck: "true" },
    });
  },
  parse(raw): Inbound[] {
    let j: any;
    try { j = JSON.parse(raw.body); } catch { return []; }
    if (j?.entry) return parseCloud(raw.body); // v3 (Meta format)
    if (j?.type !== "message") return [];
    const p = j.payload ?? {};
    const phone = digits(p.sender?.phone ?? p.source);
    if (!p.id || !phone) return [];
    const m: Inbound = { id: String(p.id), phone, name: p.sender?.name };
    const inner = p.payload ?? {};
    if (p.type === "text") m.text = String(inner.text ?? "");
    else if (p.type === "image") m.image = { ref: String(inner.url ?? ""), mime: String(inner.contentType || "image/jpeg"), caption: String(inner.caption ?? "") };
    else if (p.type === "button_reply" || p.type === "quick_reply" || p.type === "list_reply") m.text = String(inner.title ?? inner.text ?? "");
    else m.other = true;
    return [m];
  },
  async sendText(v, to, text) {
    await call("Gupshup", `${API()}/wa/api/v1/msg`, {
      headers: auth(v),
      form: { channel: "whatsapp", source: digits(v.number), destination: to.phone!, "src.name": v.app_name!, message: JSON.stringify({ type: "text", text: text.slice(0, 4096), previewUrl: false }) },
    });
  },
  // Gupshup's media links work without login; the API key is sent in case that changes.
  media: (v, ref) => download("Gupshup", ref, auth(v)),
};
