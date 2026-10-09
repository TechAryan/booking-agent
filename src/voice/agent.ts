// The calling agent's brain-side: settings, the prompt and tool list given to the provider's AI, and the tools
// themselves. Booking rules (paid bookings can't be cancelled, owner's switches, calling hours) are enforced here.
import { DateTime } from "luxon";
import crypto from "node:crypto";
import { db, logActivity, Workspace } from "../db.js";
import { findService, inr, listServices, mapsLink, normIndian, quote } from "../catalog.js";
import { WorkspaceCalendar } from "../calendar.js";
import { appendToChat, book, Booking, cancelBooking, isPaidLocked, notifyOwners, reschedule, whenText } from "../bookings.js";
import { cancelJob } from "../jobs.js";
import { hoursText } from "../sites/render.js";
import type { AgentSpec, ToolSpec } from "./types.js";

export interface VoiceSettings {
  enabled: boolean;
  confirm: boolean;                        // call to confirm soon after booking
  remind: "off" | "30m" | "1h" | "3h" | "1d";
  canReschedule: boolean;
  canCancel: boolean;
  inbound: boolean;                        // answer calls to the business number
  start: number; end: number;              // calling hours (local)
  language: "hinglish" | "hi" | "en";
  voice: "female" | "male";
  dailyCap: number;
}
export const DEFAULT_SETTINGS: VoiceSettings = { enabled: false, confirm: true, remind: "3h", canReschedule: true, canCancel: true, inbound: false, start: 9, end: 21, language: "hinglish", voice: "female", dailyCap: 100 };

export function voiceSettings(ws: Pick<Workspace, "voice_settings">): VoiceSettings {
  let x: any = {};
  try { x = JSON.parse(ws.voice_settings || "{}"); } catch { /* defaults */ }
  const s = { ...DEFAULT_SETTINGS, ...x };
  const hr = (n: unknown, d: number) => (Number.isInteger(Number(n)) && Number(n) >= 0 && Number(n) <= 23 ? Number(n) : d);
  return {
    enabled: !!s.enabled, confirm: !!s.confirm, remind: ["off", "30m", "1h", "3h", "1d"].includes(s.remind) ? s.remind : "3h",
    canReschedule: !!s.canReschedule, canCancel: !!s.canCancel, inbound: !!s.inbound,
    // TRAI: service calls between 9 am and 9 pm; owners can only narrow this.
    start: Math.max(9, hr(s.start, 9)), end: Math.min(21, hr(s.end, 21)),
    language: ["hinglish", "hi", "en"].includes(s.language) ? s.language : "hinglish",
    voice: s.voice === "male" ? "male" : "female",
    dailyCap: Math.max(1, Math.min(500, Number(s.dailyCap) || 100)),
  };
}

export const REMIND_MINUTES: Record<VoiceSettings["remind"], number> = { off: 0, "30m": 30, "1h": 60, "3h": 180, "1d": 1440 };

// ------------------------------------------------------------------ prompt and tools for the provider's AI

export const VOICE_TOOLS: ToolSpec[] = [
  { name: "booking_details", description: "Get the booking this call is about (outgoing calls) or the caller's upcoming bookings (incoming calls). Call this first.", parameters: { type: "object", properties: {} } },
  { name: "confirm_attendance", description: "The customer says they will come as booked.", parameters: { type: "object", properties: { ref: { type: "string", description: "Booking ref like BK-7Q2XA (optional on outgoing calls)" } } } },
  { name: "check_availability", description: "Free start times on a date. Always call before offering a new time.", parameters: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD" }, service: { type: "string", description: "Service name (optional)" } }, required: ["date"] } },
  { name: "reschedule_booking", description: "Move the booking to a new free time the customer agreed to.", parameters: { type: "object", properties: { ref: { type: "string", description: "Booking ref (optional on outgoing calls)" }, new_start: { type: "string", description: "YYYY-MM-DDTHH:mm" } }, required: ["new_start"] } },
  { name: "cancel_booking", description: "Cancel the booking after the customer clearly asks to. Paid bookings can't be cancelled, only moved.", parameters: { type: "object", properties: { ref: { type: "string", description: "Booking ref (optional on outgoing calls)" }, reason: { type: "string", description: "Short reason, if given" } } } },
  { name: "book_appointment", description: "Incoming calls only: book a new appointment once the caller agreed to service, date and time and gave their name.", parameters: { type: "object", properties: { service: { type: "string", description: "Service name" }, start: { type: "string", description: "YYYY-MM-DDTHH:mm" }, customer_name: { type: "string", description: "Caller's name" } }, required: ["service", "start", "customer_name"] } },
  { name: "business_info", description: "Services with prices, opening hours, address. Use to answer questions; never guess.", parameters: { type: "object", properties: {} } },
  { name: "stop_calls", description: "The customer doesn't want calls from us any more.", parameters: { type: "object", properties: {} } },
];

const LANG_RULE: Record<VoiceSettings["language"], string> = {
  hinglish: "Speak natural Hinglish (Hindi and English mixed, the way people talk in Indian cities). If the customer speaks pure English or pure Hindi, follow them.",
  hi: "Speak simple Hindi. Switch to English only if the customer does.",
  en: "Speak simple Indian English. Switch to Hindi if the customer does.",
};

/** The agent definition for one business. Call variables use {{name}}; adapters convert to their own style. */
export async function agentSpec(ws: Workspace, s: VoiceSettings, urls: { tool: (t: string) => string; webhook: string }): Promise<AgentSpec> {
  const services = await listServices(ws);
  const lines = await Promise.all(services.map(async (x) => {
    const q = await quote(ws, x);
    return `- ${x.name}: ${x.price > 0 ? (q.online < q.venue ? `${inr(q.venue)} (online ${inr(q.online)})` : inr(q.venue)) : "free"}`;
  }));
  const name = ws.business_name || "the business";
  const prompt = [
    `You are the phone assistant for ${name}. You make short, polite calls about appointments and answer calls to the business.`,
    LANG_RULE[s.language],
    "Keep every reply to one or two short sentences. Say dates and times clearly (\"Saturday, 12 October, 4 pm\"). Never make up facts, prices or free times: use the tools.",
    "",
    "THIS CALL",
    "Purpose: {{purpose}}. Customer: {{customer_name}}. Booking: {{service}} on {{booking_when}} (ref {{booking_ref}}).",
    "If the purpose is 'confirm' or 'reminder': say who you are and why you're calling, then ask if they'll come. If yes, use confirm_attendance. If they want another time, check_availability then reschedule_booking. If they want to cancel, use cancel_booking.",
    "If the purpose is empty or looks like a placeholder, someone is calling the business: greet them, call booking_details to see their bookings, and help them (questions, new booking, changes).",
    "",
    "RULES",
    s.canReschedule ? "You may move bookings to another free time." : "You can't move bookings on a call: say the team will help on WhatsApp.",
    s.canCancel ? "You may cancel unpaid bookings when asked. Paid bookings can't be cancelled, only moved." : "You can't cancel bookings on a call: say the team will help on WhatsApp.",
    s.inbound ? "New bookings on a call are only for free services or pay-at-venue. For online payment, tell them they'll get a WhatsApp link from the team." : "",
    "Never ask for card, UPI PIN, OTP or bank details. If they ask to stop getting calls, use stop_calls and apologise.",
    "End the call politely once things are settled.",
    "",
    "BUSINESS",
    `Name: ${name}${ws.business_type ? ` (${ws.business_type})` : ""}`,
    `Hours: ${hoursText(ws)}`,
    ws.address ? `Address: ${ws.address.replace(/\n/g, ", ")}` : "",
    lines.length ? `Services:\n${lines.join("\n")}` : "",
  ].filter((x) => x !== "").join("\n");
  const firstMessage = s.language === "en" ? `Hello! This is the assistant from ${name}.` : `Namaste! Main ${name} se bol rahi hoon.`;
  return {
    name: `${name} · booking calls`.slice(0, 60),
    prompt, firstMessage: s.voice === "male" ? firstMessage.replace("bol rahi", "bol raha") : firstMessage,
    language: s.language, voice: s.voice,
    tools: VOICE_TOOLS.filter((t) => s.inbound || t.name !== "book_appointment"),
    toolUrl: urls.tool, webhookUrl: urls.webhook, inbound: s.inbound, startHour: s.start, endHour: s.end,
  };
}

/** Variables for one outgoing call (filled into the prompt's {{…}}). */
export function callVars(ws: Workspace, b: Booking, purpose: string, callKey: string) {
  return { purpose, customer_name: b.customer_name, service: b.service_name, booking_when: whenText(ws, b.start_at), booking_ref: b.ref, business_name: ws.business_name, call_key: callKey };
}

export const newCallKey = () => crypto.randomBytes(18).toString("base64url");

// ------------------------------------------------------------------ the tools

export interface CallRow {
  id: number; workspace_id: number; booking_id: number | null; customer_key: string; direction: string; purpose: string;
  provider: string; provider_call_id: string | null; status: string; seconds: number | null; summary: string | null;
  call_key: string | null; attempt: number; outcome: string | null; created_at: number;
}

export interface ToolContext { caller: string | null; direction: "in" | "out"; call: CallRow | null }

const upcomingFor = (ws: Workspace, phone: string) => db.all<Booking>(
  "SELECT * FROM bookings WHERE workspace_id=? AND customer_phone=? AND status IN ('confirmed','held') AND end_at >= ? ORDER BY start_at LIMIT 5",
  ws.id, phone, DateTime.now().toISO()!);

/** The booking a tool acts on: the call's own booking, or one of the caller's (never someone else's). */
async function pickBooking(ws: Workspace, ctx: ToolContext, ref: unknown): Promise<Booking | null> {
  if (!ctx.caller) return null;
  const r = String(ref || "").trim().toUpperCase();
  if (ctx.call?.booking_id && (!r || r === "")) return (await db.get<Booking>("SELECT * FROM bookings WHERE id=? AND workspace_id=?", ctx.call.booking_id, ws.id)) ?? null;
  const mine = await upcomingFor(ws, ctx.caller);
  if (r) return mine.find((b) => b.ref === r) ?? null;
  return mine.length === 1 ? mine[0]! : null;
}

const brief = (ws: Workspace, b: Booking) => ({ ref: b.ref, service: b.service_name, when: whenText(ws, b.start_at), status: b.status === "held" ? "waiting for payment" : "confirmed", paid: b.pay_status === "paid", amount: b.amount || 0 });

export async function runVoiceTool(ws: Workspace, s: VoiceSettings, ctx: ToolContext, name: string, a: Record<string, any>): Promise<Record<string, unknown>> {
  const personal = ["booking_details", "confirm_attendance", "reschedule_booking", "cancel_booking", "book_appointment", "stop_calls"];
  if (personal.includes(name) && !ctx.caller) return { error: "I can't see the caller's number on this call, so I can't look up bookings. Ask them to message the business on WhatsApp." };
  switch (name) {
    case "business_info": {
      const services = await listServices(ws);
      return {
        name: ws.business_name, hours: hoursText(ws), address: ws.address || undefined, map: mapsLink(ws) || undefined,
        services: await Promise.all(services.map(async (x) => { const q = await quote(ws, x); return { name: x.name, price: x.price > 0 ? q.venue : 0, online_price: x.price > 0 ? q.online : 0, mode: x.mode }; })),
      };
    }
    case "check_availability": {
      const svc = a.service ? findService(await listServices(ws), a.service) : undefined;
      return new WorkspaceCalendar(ws).availableSlots(String(a.date || ""), svc?.duration_minutes || ws.slot_minutes) as any;
    }
    case "booking_details": {
      if (ctx.call?.booking_id) {
        const b = await db.get<Booking>("SELECT * FROM bookings WHERE id=?", ctx.call.booking_id);
        if (b) return { booking: brief(ws, b), status_now: b.status };
      }
      const mine = await upcomingFor(ws, ctx.caller!);
      return mine.length ? { bookings: mine.map((b) => brief(ws, b)) } : { bookings: [], note: "No upcoming bookings for this number." };
    }
    case "confirm_attendance": {
      const b = await pickBooking(ws, ctx, a.ref);
      if (!b || b.status === "cancelled") return { error: "Couldn't find an active booking for this caller." };
      if (ctx.call) await db.run("UPDATE calls SET outcome='confirmed', updated_at=? WHERE id=?", Date.now(), ctx.call.id);
      await logActivity(ws.id, "booking", "phone", `${b.customer_name} confirmed ${b.ref} on a call (${whenText(ws, b.start_at)})`);
      return { ok: true, message: `Confirmed. See you on ${whenText(ws, b.start_at)}.` };
    }
    case "reschedule_booking": {
      if (!s.canReschedule) return { error: "Moving bookings on a call is switched off. Say the team will help on WhatsApp." };
      const b = await pickBooking(ws, ctx, a.ref);
      if (!b) return { error: "Couldn't find that booking for this caller. Ask for the booking ref." };
      const r = await reschedule(ws, b, String(a.new_start || ""));
      if (r.ok && ctx.call) await db.run("UPDATE calls SET outcome='rescheduled', updated_at=? WHERE id=?", Date.now(), ctx.call.id);
      return r;
    }
    case "cancel_booking": {
      if (!s.canCancel) return { error: "Cancelling on a call is switched off. Say the team will help on WhatsApp." };
      const b = await pickBooking(ws, ctx, a.ref);
      if (!b) return { error: "Couldn't find that booking for this caller. Ask for the booking ref." };
      if (isPaidLocked(b)) return { ok: false, message: "This booking is paid, so it can't be cancelled. Offer to move it to another time." };
      const r = await cancelBooking(ws, b, "customer", String(a.reason || "on a call").slice(0, 120));
      if (r.ok && ctx.call) await db.run("UPDATE calls SET outcome='cancelled', updated_at=? WHERE id=?", Date.now(), ctx.call.id);
      return r;
    }
    case "book_appointment": {
      if (!s.inbound || ctx.direction !== "in") return { error: "New bookings are only taken on incoming calls." };
      const svc = findService(await listServices(ws), a.service);
      if (!svc) return { error: "Unknown service. Use business_info for the list." };
      if (svc.price > 0 && !ws.pay_at_venue) return { ok: false, message: "This service is paid online. Tell them the team will send a WhatsApp payment link, and they can book there." };
      const phone = ctx.caller!;
      return book(ws, {
        start: String(a.start || ""), serviceName: svc.name, customerName: String(a.customer_name || "").trim() || "Caller",
        phone, payment: svc.price > 0 ? "venue" : undefined, channel: "phone", owner: `wa:${phone}`, phoneVerified: true, callConsent: true,
      }) as any;
    }
    case "stop_calls": {
      await db.run("INSERT OR IGNORE INTO do_not_call (workspace_id, customer_key, created_at) VALUES (?,?,?)", ws.id, ctx.caller!, Date.now());
      const pending = await db.all<{ id: number }>("SELECT id FROM bookings WHERE workspace_id=? AND customer_phone=? AND status='confirmed' AND start_at >= ?", ws.id, ctx.caller!, DateTime.now().toISO()!);
      for (const b of pending) for (const p of ["confirm", "remind"]) { await cancelJob("voice_call", `${p}:${b.id}`); await cancelJob("voice_call", `${p}:${b.id}:2`); }
      await logActivity(ws.id, "call", "phone", `+${ctx.caller} asked not to be called again`);
      return { ok: true, message: "Done. We won't call this number again. Apologise and end the call." };
    }
  }
  return { error: `Unknown tool ${name}` };
}

/** After a call: note it in the customer's WhatsApp chat (so the assistant knows) and in the activity feed. */
export async function noteCallOutcome(ws: Workspace, phone: string, text: string) {
  await appendToChat(ws.id, "whatsapp", phone, text).catch(() => undefined);
}

export { normIndian, notifyOwners };
