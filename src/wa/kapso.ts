// Kapso behind the same interface. Connecting stays on its own page section (webhook created through Kapso's API).
import { downloadMedia, markRead, sendText } from "../kapso.js";
import { Inbound, WaProvider } from "./types.js";
import { digits } from "./http.js";

export const kapso: WaProvider = {
  id: "kapso",
  name: "Kapso",
  tag: "Recommended",
  blurb: "Official WhatsApp partner. Free to start, simplest setup, and a free sandbox number for testing.",
  pricingUrl: "https://kapso.ai/pricing",
  fields: [],
  steps: [],
  async check() { return { display: "" }; },
  parse(raw): Inbound[] {
    let payload: any;
    try { payload = JSON.parse(raw.body); } catch { return []; }
    const items: any[] = payload?.batch && Array.isArray(payload.data) ? payload.data : [payload];
    const out: Inbound[] = [];
    for (const item of items) {
      const msg = item?.message;
      if (!msg?.id || msg?.kapso?.direction === "outbound") continue;
      const phone = digits(msg.from ?? item?.conversation?.phone_number);
      if (!phone) continue;
      const m: Inbound = { id: String(msg.id), phone, name: item?.conversation?.kapso?.contact_name };
      const text = msg.text?.body ?? (msg.type === "text" ? msg.kapso?.content : undefined);
      if (text) m.text = String(text);
      else if (msg.type === "image" && msg.image?.id) m.image = { ref: String(msg.image.id), mime: String(msg.image.mime_type || "image/jpeg"), caption: String(msg.image.caption || "") };
      else m.other = true;
      out.push(m);
    }
    return out;
  },
  sendText: (v, to, text) => sendText(v.api_key!, v.phone_number_id!, to.phone!, text),
  media: async (v, ref) => ({ bytes: await downloadMedia(v.api_key!, v.phone_number_id!, ref), mime: "" }),
  markRead: async (v, id) => { await markRead(v.api_key!, v.phone_number_id!, id); },
};
