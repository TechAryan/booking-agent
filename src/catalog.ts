import { DateTime } from "luxon";
import { db, Workspace } from "./db.js";
import { markSiteDirty } from "./jobs.js";

// ============================================================ Services

export interface Service {
  id: number;
  workspace_id: number;
  name: string;
  details: string;
  price: number;
  mode: "online" | "offline" | "both";
  duration_minutes: number | null;
  sort: number;
}

export type ServiceInput = { name: string; details?: string; price?: number | string | null; mode?: string; duration_minutes?: number | string | null };

export function cleanService(s: ServiceInput): Omit<Service, "id" | "workspace_id" | "sort"> | null {
  const name = String(s.name ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!name) return null;
  const price = Math.max(0, Math.round(Number(String(s.price ?? "").replace(/[^\d.]/g, "")) * 100) / 100 || 0);
  const mode = s.mode === "online" || s.mode === "both" ? s.mode : "offline";
  const d = Number(s.duration_minutes);
  return {
    name,
    details: String(s.details ?? "").trim().slice(0, 1000),
    price,
    mode,
    duration_minutes: Number.isFinite(d) && d >= 5 && d <= 600 ? Math.round(d) : null,
  };
}

/** Moves the old comma-separated services text into real service rows, once. */
export async function ensureServices(ws: Workspace) {
  if (ws.services_migrated) return;
  const n = Number((await db.get("SELECT COUNT(*) AS c FROM services WHERE workspace_id=?", ws.id))?.c ?? 0);
  if (!n && ws.services.trim()) {
    const names = ws.services.split(",").map((x) => x.trim()).filter(Boolean);
    let i = 0;
    for (const name of names) await db.run("INSERT INTO services (workspace_id, name, sort) VALUES (?,?,?)", ws.id, name.slice(0, 80), i++);
  }
  await db.run("UPDATE workspaces SET services_migrated=1 WHERE id=?", ws.id);
  ws.services_migrated = 1;
}

export async function listServices(ws: Workspace): Promise<Service[]> {
  await ensureServices(ws);
  return db.all<Service>("SELECT * FROM services WHERE workspace_id=? ORDER BY sort, id", ws.id);
}

/** Replaces the whole list (used by the setup form). Keeps ids of rows that still exist so bookings/offers keep pointing right. */
export async function saveServices(ws: Workspace, rows: (ServiceInput & { id?: number | string })[]) {
  void markSiteDirty(ws.id);
  const existing = await listServices(ws);
  const keep = new Set<number>();
  let sort = 0;
  for (const r of rows) {
    const c = cleanService(r);
    if (!c) continue;
    const id = Number(r.id);
    if (id && existing.some((e) => e.id === id)) {
      await db.run("UPDATE services SET name=?, details=?, price=?, mode=?, duration_minutes=?, sort=? WHERE id=?", c.name, c.details, c.price, c.mode, c.duration_minutes, sort++, id);
      keep.add(id);
    } else {
      const res = await db.run("INSERT INTO services (workspace_id, name, details, price, mode, duration_minutes, sort) VALUES (?,?,?,?,?,?,?)", ws.id, c.name, c.details, c.price, c.mode, c.duration_minutes, sort++);
      keep.add(res.lastId);
    }
  }
  for (const e of existing) if (!keep.has(e.id)) await db.run("DELETE FROM services WHERE id=?", e.id);
  await syncServiceNames(ws);
}

export async function addService(ws: Workspace, input: ServiceInput) {
  void markSiteDirty(ws.id);
  const c = cleanService(input);
  if (!c) throw new Error("A service needs a name.");
  const all = await listServices(ws);
  if (all.some((s) => s.name.toLowerCase() === c.name.toLowerCase())) throw new Error(`"${c.name}" already exists. Update it instead.`);
  const r = await db.run("INSERT INTO services (workspace_id, name, details, price, mode, duration_minutes, sort) VALUES (?,?,?,?,?,?,?)", ws.id, c.name, c.details, c.price, c.mode, c.duration_minutes, all.length);
  await syncServiceNames(ws);
  return { id: r.lastId, ...c };
}

export async function updateService(ws: Workspace, id: number, patch: Partial<ServiceInput>) {
  void markSiteDirty(ws.id);
  const cur = (await listServices(ws)).find((s) => s.id === id);
  if (!cur) throw new Error("No service with that id.");
  const c = cleanService({ ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as ServiceInput);
  if (!c) throw new Error("A service needs a name.");
  await db.run("UPDATE services SET name=?, details=?, price=?, mode=?, duration_minutes=? WHERE id=?", c.name, c.details, c.price, c.mode, c.duration_minutes, id);
  await syncServiceNames(ws);
  return { id, ...c };
}

export async function deleteService(ws: Workspace, id: number) {
  void markSiteDirty(ws.id);
  const r = await db.run("DELETE FROM services WHERE id=? AND workspace_id=?", id, ws.id);
  if (!r.changes) throw new Error("No service with that id.");
  await syncServiceNames(ws);
}

async function syncServiceNames(ws: Workspace) {
  const rows = await db.all<{ name: string }>("SELECT name FROM services WHERE workspace_id=? ORDER BY sort, id", ws.id);
  const text = rows.map((r) => r.name).join(", ");
  await db.run("UPDATE workspaces SET services=? WHERE id=?", text, ws.id);
  ws.services = text;
}

export function findService(list: Service[], nameOrId: string | number | undefined): Service | undefined {
  if (nameOrId === undefined || nameOrId === null || nameOrId === "") return undefined;
  const id = Number(nameOrId);
  if (id) { const s = list.find((x) => x.id === id); if (s) return s; }
  const q = String(nameOrId).trim().toLowerCase();
  return list.find((s) => s.name.toLowerCase() === q) ?? list.find((s) => s.name.toLowerCase().includes(q) || q.includes(s.name.toLowerCase()));
}

// ============================================================ Offers + prices

export interface Offer {
  id: number; workspace_id: number; label: string; percent: number; service_id: number | null;
  customer_phone: string | null; starts_on: string | null; ends_on: string | null;
}

export function listOffers(ws: Workspace) {
  return db.all<Offer>("SELECT * FROM offers WHERE workspace_id=? ORDER BY id", ws.id);
}

export async function addOffer(ws: Workspace, o: { label?: string; percent: number; service_id?: number | null; customer_phone?: string | null; starts_on?: string | null; ends_on?: string | null }) {
  void markSiteDirty(ws.id);
  const pct = Number(o.percent);
  if (!(pct > 0 && pct <= 100)) throw new Error("Discount must be between 1 and 100 percent.");
  const d = (x?: string | null) => (x && /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : null);
  const phone = o.customer_phone ? String(o.customer_phone).replace(/\D/g, "") : null;
  const r = await db.run(
    "INSERT INTO offers (workspace_id, label, percent, service_id, customer_phone, starts_on, ends_on) VALUES (?,?,?,?,?,?,?)",
    ws.id, String(o.label || `${pct}% off`).slice(0, 80), pct, o.service_id || null, phone ? normIndian(phone) : null, d(o.starts_on), d(o.ends_on)
  );
  return r.lastId;
}

export async function deleteOffer(ws: Workspace, id: number) {
  void markSiteDirty(ws.id);
  const r = await db.run("DELETE FROM offers WHERE id=? AND workspace_id=?", id, ws.id);
  if (!r.changes) throw new Error("No offer with that id.");
}

/** 10-digit Indian numbers get the 91 prefix so they match WhatsApp numbers. */
export function normIndian(digits: string) {
  const d = digits.replace(/\D/g, "");
  return d.length === 10 ? `91${d}` : d;
}

export interface Quote {
  free: boolean;
  list: number;          // price before any discount
  offer?: { label: string; percent: number };
  venue: number;         // pay at the venue / offline
  online: number;        // pay online now
  onlineDiscountPct: number;
}

const round = (n: number) => Math.round(n);

/** What a service costs this customer today. "Paid" with price 0 counts as free. */
export async function quote(ws: Workspace, svc: Service | undefined, customerPhone = "", on = todayIn(ws)): Promise<Quote> {
  const list = svc?.price ?? 0;
  if (!svc || list <= 0) return { free: true, list: 0, venue: 0, online: 0, onlineDiscountPct: 0 };
  const phone = normIndian(customerPhone);
  const offers = (await listOffers(ws)).filter(
    (o) => (!o.service_id || o.service_id === svc.id) && (!o.customer_phone || (phone && o.customer_phone === phone)) &&
      (!o.starts_on || o.starts_on <= on) && (!o.ends_on || o.ends_on >= on)
  );
  const best = offers.sort((a, b) => b.percent - a.percent)[0];
  const venue = round(list * (1 - (best?.percent ?? 0) / 100));
  const od = Math.max(0, Math.min(100, Number(ws.online_discount_pct) || 0));
  if (venue <= 0) return { free: true, list, offer: best ? { label: best.label, percent: best.percent } : undefined, venue: 0, online: 0, onlineDiscountPct: 0 };
  const online = Math.max(1, round(venue * (1 - od / 100)));
  return { free: false, list, offer: best ? { label: best.label, percent: best.percent } : undefined, venue, online, onlineDiscountPct: od };
}

export function todayIn(ws: Workspace) {
  return DateTime.now().setZone(ws.timezone || "Asia/Kolkata").toISODate()!;
}

export const inr = (n: number) => `₹${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

// ============================================================ Holidays

export interface Holiday { id: number; date: string; end_date: string | null; label: string; source: string }

export function listHolidays(ws: Workspace, fromDate?: string) {
  return fromDate
    ? db.all<Holiday>("SELECT * FROM holidays WHERE workspace_id=? AND COALESCE(end_date, date) >= ? ORDER BY date", ws.id, fromDate)
    : db.all<Holiday>("SELECT * FROM holidays WHERE workspace_id=? ORDER BY date", ws.id);
}

export async function addHoliday(ws: Workspace, date: string, label = "Holiday", endDate: string | null = null, source = "manual") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Use a date like 2026-10-20.");
  if (endDate && (!/^\d{4}-\d{2}-\d{2}$/.test(endDate) || endDate < date)) endDate = null;
  if (endDate === date) endDate = null;
  const r = await db.run("INSERT OR IGNORE INTO holidays (workspace_id, date, end_date, label, source) VALUES (?,?,?,?,?)", ws.id, date, endDate, (label || "Holiday").slice(0, 80), source);
  return r.changes > 0;
}

export async function deleteHoliday(ws: Workspace, id: number) {
  const r = await db.run("DELETE FROM holidays WHERE id=? AND workspace_id=?", id, ws.id);
  if (!r.changes) throw new Error("No holiday with that id.");
}

export async function holidayOn(ws: Workspace, date: string): Promise<string | null> {
  const h = await db.get<{ label: string }>(
    "SELECT label FROM holidays WHERE workspace_id=? AND date <= ? AND COALESCE(end_date, date) >= ? LIMIT 1", ws.id, date, date
  );
  return h?.label ?? null;
}

const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december";
const DATE_RES: RegExp[] = [
  /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/,                                   // 2026-10-20
  /\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})\b/,                         // 20/10/2026, 20-10-2026
  new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTHS})\\.?,?\\s*(\\d{4})?\\b`, "i"), // 20 Oct 2026
  new RegExp(`\\b(${MONTHS})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s*(\\d{4})?\\b`, "i"), // Oct 20, 2026
];

function parseOneDate(s: string, defaultYear: number): { iso: string; rest: string } | null {
  for (let i = 0; i < DATE_RES.length; i++) {
    const m = s.match(DATE_RES[i]!);
    if (!m) continue;
    let dt: DateTime;
    if (i === 0) dt = DateTime.fromObject({ year: +m[1]!, month: +m[2]!, day: +m[3]! });
    else if (i === 1) dt = DateTime.fromObject({ year: +m[3]!, month: +m[2]!, day: +m[1]! });
    else {
      const [day, mon, yr] = i === 2 ? [m[1], m[2], m[3]] : [m[2], m[1], m[3]];
      dt = DateTime.fromFormat(`${+day!} ${mon!.slice(0, 3)} ${yr || defaultYear}`, "d LLL yyyy", { locale: "en" });
    }
    if (!dt.isValid) continue;
    return { iso: dt.toISODate()!, rest: s.replace(m[0], " ") };
  }
  return null;
}

/** Reads holidays from free text / CSV: one per line, any common date format, the rest of the line is the name. */
export function parseHolidays(text: string, defaultYear = DateTime.now().year) {
  const out: { date: string; end_date: string | null; label: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s*[-*•]\s*/, "").trim();
    if (!line) continue;
    const a = parseOneDate(line, defaultYear);
    if (!a) continue;
    let rest = a.rest;
    let end: string | null = null;
    const toPart = rest.match(/^\s*(?:to|till|until|–|—|-)\s*/i);
    if (toPart) {
      const b = parseOneDate(rest, defaultYear);
      if (b) { end = b.iso > a.iso ? b.iso : null; rest = b.rest; }
    }
    const label = rest.replace(/^[\s,;:|\-–—]+|[\s,;:|\-–—]+$/g, "").replace(/\s{2,}/g, " ").replace(/^(to|till|until)\b/i, "").trim() || "Holiday";
    out.push({ date: a.iso, end_date: end, label: label.slice(0, 80) });
  }
  return out;
}

// ============================================================ Knowledge

export interface Knowledge { id: number; kind: string; title: string; source_url: string | null; content: string; updated_at: string }

export const KNOWLEDGE_MAX_CHARS = 200_000;   // per item stored
const PROMPT_BUDGET = 40_000;                  // total characters of knowledge sent to Claude

export function listKnowledge(ws: Workspace) {
  return db.all<Knowledge>("SELECT id, kind, title, source_url, content, updated_at FROM knowledge WHERE workspace_id=? ORDER BY kind, id", ws.id);
}

export async function addKnowledge(ws: Workspace, kind: string, title: string, content: string, sourceUrl: string | null = null) {
  const text = content.replace(/\u0000/g, "").trim().slice(0, KNOWLEDGE_MAX_CHARS);
  if (!text) throw new Error("That file is empty.");
  const r = await db.run("INSERT INTO knowledge (workspace_id, kind, title, source_url, content) VALUES (?,?,?,?,?)", ws.id, kind, title.slice(0, 120), sourceUrl, text);
  return r.lastId;
}

export async function updateKnowledge(ws: Workspace, id: number, content: string, title?: string) {
  await db.run("UPDATE knowledge SET content=?, title=COALESCE(?, title), updated_at=datetime('now') WHERE id=? AND workspace_id=?", content.trim().slice(0, KNOWLEDGE_MAX_CHARS), title ?? null, id, ws.id);
}

export async function deleteKnowledge(ws: Workspace, id: number) {
  await db.run("DELETE FROM knowledge WHERE id=? AND workspace_id=?", id, ws.id);
}

/** Turns an uploaded file into plain text. Handles .md/.txt/.csv, HTML, and JSON chat exports (e.g. from Claude or ChatGPT). */
export function fileToText(name: string, buf: Buffer): string {
  let text = buf.toString("utf8");
  const lower = name.toLowerCase();
  if (lower.endsWith(".json")) {
    try {
      const parts: string[] = [];
      const walk = (v: any, key = "") => {
        if (typeof v === "string") { if (["text", "content", "value", "body", "message"].includes(key) && v.trim().length > 1) parts.push(v.trim()); }
        else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
        else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
      };
      walk(JSON.parse(text));
      text = parts.join("\n\n");
    } catch {
      /* not JSON after all: keep raw text */
    }
  } else if (lower.endsWith(".html") || lower.endsWith(".htm")) {
    text = htmlToText(text);
  }
  return text;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** All knowledge in one block for the prompt, owner notes first, trimmed to a budget. */
export async function knowledgeForPrompt(ws: Workspace): Promise<string> {
  const items = await listKnowledge(ws);
  if (!items.length) return "";
  const order = { note: 0, website: 1, file: 2 } as Record<string, number>;
  items.sort((a, b) => (order[a.kind] ?? 3) - (order[b.kind] ?? 3));
  const per = Math.max(2000, Math.floor(PROMPT_BUDGET / items.length));
  let out = "";
  for (const k of items) {
    const body = k.content.length > per ? `${k.content.slice(0, per)}\n[…trimmed]` : k.content;
    out += `\n### ${k.title || k.kind}${k.source_url ? ` (${k.source_url})` : ""}\n${body}\n`;
    if (out.length > PROMPT_BUDGET) break;
  }
  return out.slice(0, PROMPT_BUDGET + 500);
}

// ============================================================ Profile

export const SOCIALS: [string, string][] = [
  ["instagram", "Instagram"], ["facebook", "Facebook"], ["youtube", "YouTube"], ["linkedin", "LinkedIn"], ["x", "X / Twitter"], ["whatsapp", "WhatsApp link"], ["other", "Other"],
];

export function socialsOf(ws: Workspace): Record<string, string> {
  try {
    const o = JSON.parse(ws.socials || "{}");
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

/** A Google Maps link: the one they gave, or a search for their address. */
export function mapsLink(ws: Workspace): string {
  if (ws.maps_url) return ws.maps_url;
  if (ws.address.trim()) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${ws.business_name} ${ws.address}`.trim())}`;
  return "";
}

export function ownerPhones(ws: Workspace): string[] {
  return (ws.owner_phones || "").split(",").map((p) => normIndian(p)).filter((p) => p.length >= 10);
}
