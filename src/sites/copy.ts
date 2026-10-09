// Website words, written by the business's own AI as JSON (never HTML). Every field is length-checked here and
// escaped again by the renderer, so nothing the AI says can inject markup.
import { aiChat } from "../ai/registry.js";
import type { Workspace } from "../db.js";
import { knowledgeForPrompt, listServices, mapsLink, inr } from "../catalog.js";
import { hoursText } from "./render.js";

export interface SiteCopy {
  headline: string;
  subheadline: string;
  about: string;
  services: { name: string; blurb: string }[];
  faqs: { q: string; a: string }[];
  seo_title: string;
  seo_description: string;
  cta: string;
}

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const clipPara = (s: unknown, n: number) => String(s ?? "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, n);

/** Keeps only what we expect, at sane lengths. Exported for tests and for the owner's own edits. */
export function cleanCopy(x: any, serviceNames: string[]): SiteCopy {
  const names = new Set(serviceNames.map((n) => n.toLowerCase()));
  return {
    headline: clip(x?.headline, 80),
    subheadline: clip(x?.subheadline, 160),
    about: clipPara(x?.about, 900),
    services: (Array.isArray(x?.services) ? x.services : [])
      .map((s: any) => ({ name: clip(s?.name, 80), blurb: clip(s?.blurb, 200) }))
      .filter((s: { name: string }) => s.name && names.has(s.name.toLowerCase()))
      .slice(0, 40),
    faqs: (Array.isArray(x?.faqs) ? x.faqs : []).map((f: any) => ({ q: clip(f?.q, 140), a: clipPara(f?.a, 500) })).filter((f: { q: string; a: string }) => f.q && f.a).slice(0, 8),
    seo_title: clip(x?.seo_title, 65),
    seo_description: clip(x?.seo_description, 160),
    cta: clip(x?.cta, 30),
  };
}

export async function writeCopy(ws: Workspace, tone = ""): Promise<SiteCopy> {
  const services = await listServices(ws);
  const facts = [
    `Business: ${ws.business_name}${ws.business_type ? ` (${ws.business_type})` : ""}`,
    ws.address ? `Address: ${ws.address}` : "",
    `Opening hours: ${hoursText(ws)}`,
    services.length ? `Services:\n${services.map((s) => `- ${s.name}${s.price > 0 ? ` (${inr(s.price)})` : " (free)"}${s.details ? `: ${s.details}` : ""}`).join("\n")}` : "",
    ws.extra_info ? `Owner's notes: ${ws.extra_info}` : "",
    mapsLink(ws) ? "Has a map location." : "",
  ].filter(Boolean).join("\n");
  const notes = (await knowledgeForPrompt(ws)).slice(0, 6000);
  const res = await aiChat(ws, {
    system: { stable: "You write warm, clear, honest website copy for small Indian businesses. Only use facts you are given; never invent awards, years, reviews, staff names or prices. Simple English a customer understands at a glance." },
    maxTokens: 2000,
    forceTool: "landing_copy",
    tools: [{
      name: "landing_copy",
      description: "The words for the business's one-page website.",
      input_schema: {
        type: "object",
        properties: {
          headline: { type: "string", description: "Hero headline, max 8 words, says what they do and where" },
          subheadline: { type: "string", description: "One sentence under the headline, max 25 words" },
          about: { type: "string", description: "About section, 2 short paragraphs, max 120 words, only given facts" },
          services: { type: "array", items: { type: "object", properties: { name: { type: "string", description: "Exact service name as given" }, blurb: { type: "string", description: "One line, max 20 words" } }, required: ["name", "blurb"] } },
          faqs: { type: "array", description: "4 to 6 useful questions customers ask, answered only from the facts (booking, timings, payment, location)", items: { type: "object", properties: { q: { type: "string" }, a: { type: "string" } }, required: ["q", "a"] } },
          seo_title: { type: "string", description: "Page title for Google, max 60 characters, include business name and area" },
          seo_description: { type: "string", description: "Meta description, max 155 characters" },
          cta: { type: "string", description: "Booking button text, max 3 words, e.g. 'Book now'" },
        },
        required: ["headline", "subheadline", "about", "services", "faqs", "seo_title", "seo_description", "cta"],
      },
    }],
    messages: [{ role: "user", content: `Write the website copy.${tone ? ` Tone: ${tone.slice(0, 100)}.` : ""}\n\nFACTS\n${facts}${notes ? `\n\nMORE NOTES FROM THE OWNER (may include website text)\n${notes}` : ""}` }],
  });
  const t = res.content.find((b) => b.type === "tool_use") as any;
  const c = cleanCopy(t?.input ?? {}, services.map((s) => s.name));
  if (!c.headline) throw new Error("The AI didn't return website text. Try again.");
  return c;
}
