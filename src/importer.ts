import dns from "node:dns/promises";
import net from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { aiChat } from "./ai/registry.js";
import type { ToolUseBlock } from "./ai/types.js";
import type { Workspace } from "./db.js";
import { env } from "./env.js";
import { htmlToText } from "./catalog.js";

// ============================================================ Safe fetching of public web pages

/** Expands any IPv6 text form (incl. embedded IPv4) into 8 numbers. */
function ipv6Parts(ip: string): number[] | null {
  let x = ip.toLowerCase().split("%")[0]!;
  const v4 = x.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const o = v4[1]!.split(".").map(Number);
    x = x.slice(0, -v4[1]!.length) + ((o[0]! << 8) | o[1]!).toString(16) + ":" + ((o[2]! << 8) | o[3]!).toString(16);
  }
  const [head, tail] = x.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : null;
  const parts = t === null ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  if (parts.length !== 8) return null;
  const nums = parts.map((p) => parseInt(p || "0", 16));
  return nums.some((n) => !(n >= 0 && n <= 0xffff)) ? null : nums;
}

function privateV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

export function privateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return privateV4(ip);
  const p = ipv6Parts(ip);
  if (!p) return true; // can't parse: refuse
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (p.slice(0, 5).every((n) => n === 0) && (p[5] === 0xffff || p[5] === 0)) return privateV4(v4(p[6]!, p[7]!)); // ::ffff:a.b.c.d, ::a.b.c.d
  if (p[0] === 0x64 && p[1] === 0xff9b) return privateV4(v4(p[6]!, p[7]!)); // NAT64
  if (p[0] === 0x2002) return privateV4(v4(p[1]!, p[2]!));                   // 6to4
  if (p.every((n) => n === 0) || (p.slice(0, 7).every((n) => n === 0) && p[7] === 1)) return true; // :: and ::1
  const first = p[0]!;
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00; // ULA, link-local, multicast
}

const allowPrivate = () => process.env.ALLOW_PRIVATE_FETCH === "1"; // tests only

async function assertPublic(u: URL) {
  if (!/^https?:$/.test(u.protocol)) throw new Error("Only http(s) links can be imported.");
  if (u.port && !["80", "443"].includes(u.port) && !allowPrivate()) throw new Error("That link uses an unusual port.");
  if (allowPrivate()) return;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((r) => r.address);
  if (!ips.length) throw new Error(`Couldn't find ${u.hostname}. Check the link.`);
  if (ips.some(privateIp)) throw new Error("That address isn't a public website.");
}

// The connection itself re-checks every address it resolves, so DNS can't switch to a private IP after the check.
const safeAgent = new Agent({
  connect: {
    lookup: (hostname: string, options: any, cb: any) => {
      dns.lookup(hostname, { ...options, all: true }).then((found) => {
        const list = found as unknown as { address: string; family: number }[];
        const bad = !allowPrivate() && list.some((a) => privateIp(a.address));
        if (bad || !list.length) return cb(new Error("That address isn't a public website."));
        if (options?.all) cb(null, list);
        else cb(null, list[0]!.address, list[0]!.family);
      }, (e) => cb(e));
    },
  },
});

/** Fetches a public page (no internal addresses, follows up to 4 redirects, 2 MB max). */
export async function fetchPublic(url: string): Promise<{ url: string; html: string; type: string }> {
  let u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  for (let hop = 0; hop < 5; hop++) {
    await assertPublic(u);
    const res = await undiciFetch(u, {
      dispatcher: safeAgent,
      redirect: "manual",
      headers: { "User-Agent": `Mozilla/5.0 (compatible; ${env.appName.replace(/\s/g, "")}Bot/1.0)`, Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5", "Accept-Language": "en-IN,en;q=0.9,hi;q=0.8" },
      signal: AbortSignal.timeout(12_000),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      u = new URL(res.headers.get("location")!, u);
      continue;
    }
    if (!res.ok) throw new Error(`The page answered with error ${res.status}.`);
    const type = res.headers.get("content-type") || "";
    const reader = res.body?.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2_000_000) { await reader.cancel(); break; }
        chunks.push(value);
      }
    }
    return { url: u.toString(), html: Buffer.concat(chunks).toString("utf8"), type };
  }
  throw new Error("Too many redirects.");
}

function meta(html: string, name: string) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`, "i");
  const m = html.match(re);
  return (m?.[1] || m?.[2] || "").trim();
}

const USEFUL = /about|service|pricing|price|rate|contact|menu|faq|treatment|product|package|course|class|team|doctor|location|timing|hours|book/i;

/** Reads the homepage plus a few useful pages on the same site. */
export async function crawlSite(start: string, maxPages = 6) {
  const first = await fetchPublic(start);
  const origin = new URL(first.url);
  const pages: { url: string; title: string; text: string }[] = [];
  const add = (url: string, html: string) => {
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim();
    const desc = meta(html, "description") || meta(html, "og:description");
    const text = htmlToText(html).slice(0, 12_000);
    pages.push({ url, title, text: [desc, text].filter(Boolean).join("\n") });
  };
  add(first.url, first.html);
  const links = [...first.html.matchAll(/<a[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map((m) => { try { return { url: new URL(m[1]!, origin).toString().replace(/\/$/, ""), label: htmlToText(m[2]!) }; } catch { return null; } })
    .filter((l): l is { url: string; label: string } => !!l && new URL(l.url).host === origin.host && /^https?:/.test(l.url))
    .filter((l) => USEFUL.test(l.url) || USEFUL.test(l.label));
  const seen = new Set([first.url.replace(/\/$/, "")]);
  for (const l of links) {
    if (pages.length >= maxPages) break;
    if (seen.has(l.url) || /\.(pdf|jpg|jpeg|png|gif|webp|zip|mp4)$/i.test(l.url)) continue;
    seen.add(l.url);
    try {
      const p = await fetchPublic(l.url);
      if (/html|text/.test(p.type)) add(p.url, p.html);
    } catch {}
  }
  return pages;
}

/** Social pages mostly need a login, but many still expose a public title and bio in their preview tags. */
export async function socialPreview(url: string): Promise<string> {
  try {
    const p = await fetchPublic(url);
    const t = meta(p.html, "og:title") || (p.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").trim();
    const d = meta(p.html, "og:description") || meta(p.html, "description");
    const out = [t, d].filter(Boolean).join(" — ").replace(/\s+/g, " ").slice(0, 600);
    return /log ?in|sign ?up|page not found/i.test(out) && out.length < 60 ? "" : out;
  } catch {
    return "";
  }
}

// ============================================================ Turn pages into a business profile with Claude

export interface ImportResult {
  summary: string;
  services: { name: string; price: number | null; details: string; mode: "online" | "offline" | "both" }[];
  contact: { phone?: string; email?: string; address?: string };
  pages: number;
}

export async function summarizeBusiness(ws: Workspace, pages: { url: string; title: string; text: string }[], socials: string[]): Promise<ImportResult> {
  const material = pages.map((p) => `=== ${p.title || p.url}\n${p.url}\n${p.text}`).join("\n\n").slice(0, 60_000);
  const social = socials.filter(Boolean).join("\n");
  const res = await aiChat(ws, {
    system: { stable: "You turn business websites into clean notes for a booking assistant." },
    maxTokens: 4000,
    tools: [{
      name: "save_business_profile",
      description: "Save what you learned about the business.",
      input_schema: {
        type: "object",
        properties: {
          summary_markdown: { type: "string", description: "Markdown notes a booking assistant can use: what they do, services and prices, timings, location, policies, FAQs. Only facts from the pages. Keep the original language for names; write the notes in English." },
          services: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                price: { type: ["number", "null"], description: "Price in rupees if clearly stated, else null" },
                details: { type: "string" },
                mode: { type: "string", enum: ["online", "offline", "both"] },
              },
              required: ["name", "price", "details", "mode"],
            },
          },
          contact: { type: "object", properties: { phone: { type: "string" }, email: { type: "string" }, address: { type: "string" } } },
        },
        required: ["summary_markdown", "services", "contact"],
      },
    }],
    forceTool: "save_business_profile",
    messages: [{
      role: "user",
      content: `These are pages from the website of "${ws.business_name || "a business"}"${social ? " and previews of its social profiles" : ""}. Extract a clean profile for its booking assistant. Ignore navigation, cookie banners and unrelated text. Don't invent anything.\n\n${material}${social ? `\n\n=== Social profiles\n${social}` : ""}`,
    }],
  });
  const t = res.content.find((b) => b.type === "tool_use") as ToolUseBlock | undefined;
  const out = (t?.input || {}) as any;
  return {
    summary: String(out.summary_markdown || "").trim(),
    services: Array.isArray(out.services) ? out.services.slice(0, 40).map((s: any) => ({ name: String(s.name || "").slice(0, 80), price: typeof s.price === "number" ? s.price : null, details: String(s.details || "").slice(0, 500), mode: ["online", "offline", "both"].includes(s.mode) ? s.mode : "offline" })).filter((s: any) => s.name) : [],
    contact: out.contact && typeof out.contact === "object" ? out.contact : {},
    pages: pages.length,
  };
}
