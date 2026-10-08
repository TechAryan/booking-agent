import crypto from "node:crypto";
import { DateTime } from "luxon";
import { db, logActivity, TxQ, Workspace } from "./db.js";
import { env } from "./env.js";
import { canInvite, WorkspaceCalendar } from "./calendar.js";
import { findService, inr, listServices, mapsLink, ownerPhones, quote, Quote, Service } from "./catalog.js";
import { cancelPaymentLink, createPaymentLink, fetchPaymentLink, razorpayReady, upiReady } from "./payments.js";
import { sendText } from "./kapso.js";
import { decrypt, hmacHex } from "./security.js";
import { enqueue, onJob } from "./jobs.js";

export const HOLD_MINUTES = 20; // how long a slot waits for an online payment

export interface Booking {
  id: number; workspace_id: number; ref: string; owner: string; channel: string;
  customer_name: string; customer_phone: string; customer_email: string;
  service_id: number | null; service_name: string; start_at: string; end_at: string; mode: "online" | "offline";
  list_price: number; amount: number; pay_method: "free" | "online" | "venue" | "upi";
  pay_status: "none" | "awaiting" | "paid" | "expired" | "failed" | "refund_due" | "pending_manual";
  status: "held" | "confirmed" | "cancelled" | "paid_unbooked";
  hold_expires_at: number | null; payment_link_id: string | null; pay_url: string | null; payment_id: string | null;
  event_id: string | null; meet_link: string | null; note: string; created_at: string; updated_at: string;
}

const REF_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function newRef() {
  const b = crypto.randomBytes(5);
  return "BK-" + Array.from(b, (x) => REF_CHARS[x % REF_CHARS.length]).join("");
}

export function getBooking(ws: Workspace, ref: string) {
  return db.get<Booking>("SELECT * FROM bookings WHERE workspace_id=? AND ref=? COLLATE NOCASE", ws.id, String(ref || "").trim().toUpperCase());
}

async function setBooking(id: number, fields: Partial<Booking>) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  await db.run(`UPDATE bookings SET ${keys.map((k) => `${k}=?`).join(", ")}, updated_at=datetime('now') WHERE id=?`, ...keys.map((k) => (fields as any)[k] ?? null), id);
}

/** Pay/status pages carry a signed token so booking refs can't be guessed. */
export function payToken(ws: Workspace, ref: string) {
  return hmacHex(env.appSecret, `pay:${ws.id}:${ref.toUpperCase()}`).slice(0, 20);
}
/** A short link the owner taps to send the booking details from their own WhatsApp (no 24-hour limit there). */
export function forwardUrl(ws: Workspace, ref: string) {
  return `${env.publicUrl}/f/${ws.public_id}/${ref}/${payToken(ws, ref)}`;
}
export function forwardText(ws: Workspace, b: Booking) {
  const first = (b.customer_name || "").trim().split(/\s+/)[0] || "there";
  const owes = b.status !== "cancelled" && b.pay_status !== "paid" && (b.pay_status === "awaiting" || b.pay_status === "pending_manual");
  return [
    `Hi ${first}, you're booked at ${ws.business_name}: ${b.service_name}, ${whenText(ws, b.start_at)}. Ref ${b.ref}.`,
    owes ? `Please pay ${inr(b.amount)} here: ${b.pay_status === "awaiting" && b.pay_url ? b.pay_url : payPageUrl(ws, b.ref)}` : "",
    b.mode === "online" && b.meet_link ? `Join online: ${b.meet_link}` : "",
    b.mode !== "online" && ws.address ? `Address: ${ws.address}${mapsLink(ws) ? `\nMap: ${mapsLink(ws)}` : ""}` : "",
  ].filter(Boolean).join("\n");
}

export function payPageUrl(ws: Workspace, ref: string) {
  return `${env.publicUrl}/pay/${ws.public_id}/${ref}/${payToken(ws, ref)}`;
}

// One booking change at a time per business, so two people can't grab the same slot (single-process server).
const locks = new Map<number, Promise<unknown>>();
async function withLock<T>(wsId: number, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(wsId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const chain = prev.then(() => mine);
  locks.set(wsId, chain);
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(wsId) === chain) locks.delete(wsId);
  }
}

export function whenText(ws: Workspace, iso: string) {
  return DateTime.fromISO(iso).setZone(ws.timezone).toFormat("ccc d LLL, h:mm a");
}

function modeFor(svc: Service | undefined, asked?: string): "online" | "offline" {
  if (!svc) return asked === "online" ? "online" : "offline";
  if (svc.mode === "both") return asked === "online" ? "online" : "offline";
  return svc.mode;
}

/** The facts the assistant needs to tell the customer what it costs. */
export async function priceInfo(ws: Workspace, svc: Service | undefined, phone: string) {
  const q = await quote(ws, svc, phone);
  return {
    ...q,
    canPayOnline: !q.free && (razorpayReady(ws) || upiReady(ws)),
    canPayAtVenue: !q.free && !!ws.pay_at_venue,
    onlineMethod: razorpayReady(ws) ? "card/UPI link (confirmed automatically)" : upiReady(ws) ? "UPI (the business confirms it)" : null,
  };
}

// ---------------------------------------------------------------- create

export interface BookInput {
  start: string;
  serviceName?: string;
  customerName: string;
  phone: string;
  email?: string;
  mode?: string;          // online | offline (only matters when the service offers both)
  payment?: string;       // online | venue | paid (paid = the owner already took the money)
  channel: string;
  owner: string;
  phoneVerified?: boolean; // true only for WhatsApp, where the number comes from WhatsApp itself
  paidInPerson?: boolean;  // owner added it and already took the money (cash/UPI)
  byOwner?: boolean;       // the owner is booking for someone: their choice of payment wins over the usual rules
  paidHow?: "cash" | "upi"; // with payment "paid"
  amountPaid?: number;     // with payment "paid", if different from the price
}

export type BookResult =
  | { ok: false; message: string; slots?: string[] }
  | { ok: true; status: "confirmed" | "awaiting_payment" | "pending_manual"; ref: string; when: string; message: string; payUrl?: string; amount?: number; meetLink?: string; location?: string; mapsLink?: string; invite?: string; expiresInMinutes?: number };

/**
 * The double-booking guard: checks no active booking overlaps [start, end) and writes, in ONE database
 * transaction. Works across several app servers (the in-memory lock only covers one). Returns null on a clash.
 * Times are ISO strings in the business's own zone, so they compare correctly as text within one business.
 */
export async function guardedWrite<T>(wsId: number, start: string, end: string, excludeId: number | null, write: (q: TxQ) => Promise<T>): Promise<T | null> {
  return db.tx(async (q) => {
    const clash = await q.get(
      "SELECT 1 FROM bookings WHERE workspace_id=? AND status IN ('held','confirmed') AND start_at < ? AND end_at > ? AND id IS NOT ? LIMIT 1",
      wsId, end, start, excludeId
    );
    return clash ? null : write(q);
  });
}
const SLOT_TAKEN = (cal: WorkspaceCalendar, start: DateTime): BookResult => ({ ok: false, message: `Sorry, ${cal.fmt(start)} was just taken by someone else. Please pick another time.` });

export function book(ws: Workspace, i: BookInput): Promise<BookResult> {
  return withLock(ws.id, () => bookLocked(ws, i));
}

async function bookLocked(ws: Workspace, i: BookInput): Promise<BookResult> {
  const services = await listServices(ws);
  const svc = findService(services, i.serviceName);
  if (services.length && !svc) return { ok: false, message: `Unknown service. Choose one of: ${services.map((s) => s.name).join(", ")}.` };
  const serviceName = svc?.name || i.serviceName || "Appointment";
  const minutes = svc?.duration_minutes || ws.slot_minutes;
  const cal = new WorkspaceCalendar(ws);
  const free = await cal.isFree(i.start, minutes);
  if (!free.ok) {
    const alt = free.result.slots.slice(0, 4);
    return { ok: false, message: `${cal.fmt(free.start)} is not available${free.result.closed ? ` (${free.result.note})` : ""}.${alt.length ? " Free that day: " + alt.join(", ") : ""}`, slots: alt };
  }
  const mode = modeFor(svc, i.mode);
  const email = normEmail(i.email);
  // Personal offers only apply when we know the number is really theirs.
  const q = await quote(ws, svc, i.phoneVerified ? i.phone : "");

  // A payment that came in after its slot was taken can be used for a new time.
  const credit = await db.get<Booking>(
    "SELECT * FROM bookings WHERE workspace_id=? AND owner=? AND status='paid_unbooked' AND (service_id IS ? OR service_name=?) ORDER BY id LIMIT 1",
    ws.id, i.owner, svc?.id ?? null, serviceName
  );

  let method: Booking["pay_method"] = "free";
  let amount = 0;
  if (credit) {
    method = "online"; amount = credit.amount;
  } else if (!q.free && (i.payment === "paid" || i.paidInPerson)) {
    // The owner already has the money.
    method = i.paidHow === "upi" ? "upi" : "venue";
    const given = Number(i.amountPaid);
    amount = isFinite(given) && given > 0 ? Math.round(given) : method === "upi" ? q.online : q.venue;
  } else if (!q.free) {
    // Paying at the venue only if the business allows it (the owner can always choose it).
    const wantOnline = i.payment === "online" || (!ws.pay_at_venue && !i.byOwner);
    if (wantOnline) {
      if (razorpayReady(ws)) method = "online";
      else if (upiReady(ws)) method = "upi";
      else if (ws.pay_at_venue || i.byOwner) return { ok: false, message: "Online payment isn't set up (Payments page). The customer can pay at the venue / later instead." };
      else return { ok: false, message: "This business hasn't set up payments yet. Tell the customer the team will contact them to confirm." };
      amount = q.online;
    } else {
      const canOnline = razorpayReady(ws) || upiReady(ws);
      if (!i.payment && canOnline) return { ok: false, message: `Ask how they want to pay: online now ${inr(q.online)}${q.onlineDiscountPct ? ` (${q.onlineDiscountPct}% off)` : ""} or ${mode === "online" ? "later" : "at the venue"} ${inr(q.venue)}.` };
      method = "venue"; amount = q.venue;
    }
  }

  const base = {
    workspace_id: ws.id, owner: i.owner, channel: i.channel, customer_name: i.customerName.slice(0, 80), customer_phone: i.phone,
    customer_email: email, service_id: svc?.id ?? null, service_name: serviceName, start_at: free.start.toISO()!, end_at: free.end.toISO()!,
    mode, list_price: q.list, amount, pay_method: method,
  };

  // --- Online via Razorpay: hold the slot, send a link, confirm when paid.
  if (method === "online" && !credit) {
    const ref = newRef();
    // The owner has to forward the link first, so give those a bit longer.
    const hold = i.byOwner ? 60 : HOLD_MINUTES;
    const res = await guardedWrite(ws.id, base.start_at, base.end_at, null, (q) => q.run(
      `INSERT INTO bookings (workspace_id, ref, owner, channel, customer_name, customer_phone, customer_email, service_id, service_name, start_at, end_at, mode, list_price, amount, pay_method, pay_status, status, hold_expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'awaiting','held',?)`,
      base.workspace_id, ref, base.owner, base.channel, base.customer_name, base.customer_phone, base.customer_email, base.service_id, base.service_name,
      base.start_at, base.end_at, base.mode, base.list_price, base.amount, base.pay_method, Date.now() + hold * 60_000
    ));
    if (!res) return SLOT_TAKEN(cal, free.start);
    try {
      const link = await createPaymentLink(ws, {
        amount, ref, expiresInMinutes: hold,
        description: `${serviceName} · ${cal.fmt(free.start)} · ${ws.business_name}`,
        customer: { name: i.customerName, phone: i.phone, email },
        callbackUrl: payPageUrl(ws, ref),
      });
      await setBooking(res.lastId, { payment_link_id: link.id, pay_url: link.url });
      await enqueue(ws.id, "payment_check", ref, Date.now() + PAYMENT_POLL_MS);
      await logActivity(ws.id, "payment", i.channel, `Payment link sent · ${ref} · ${inr(amount)} · ${i.customerName}`);
      return {
        ok: true, status: "awaiting_payment", ref, when: cal.fmt(free.start), payUrl: link.url, amount, expiresInMinutes: hold,
        message: `Slot held for ${hold} minutes. Send this link to pay ${inr(amount)}: ${link.url} . The booking is confirmed automatically once paid. Ref ${ref}.`,
      };
    } catch (e: any) {
      await setBooking(res.lastId, { status: "cancelled", pay_status: "failed", note: `Link failed: ${e.message}`.slice(0, 300) });
      await logActivity(ws.id, "error", i.channel, `Payment link failed: ${e.message}`);
      return { ok: false, message: `Couldn't create a payment link right now.${ws.pay_at_venue ? " Offer to pay at the venue instead, or try again in a minute." : " Ask them to try again in a few minutes."}` };
    }
  }

  // --- Everything else is booked right away (UPI stays "payment pending" until the owner confirms).
  const paidNow = !q.free && !credit && (i.payment === "paid" || !!i.paidInPerson);
  const pending = method === "upi" && !paidNow;
  const ref = credit?.ref || newRef();
  let bookingId: number;
  if (credit) {
    const claimed = await guardedWrite(ws.id, base.start_at, base.end_at, credit.id, (q) => q.run("UPDATE bookings SET status='confirmed', start_at=?, end_at=?, mode=?, customer_email=?, updated_at=datetime('now') WHERE id=? AND status='paid_unbooked'",
      base.start_at, base.end_at, mode, email || credit.customer_email, credit.id));
    if (!claimed) return SLOT_TAKEN(cal, free.start);
    if (!claimed.changes) return { ok: false, message: "That earlier payment was just used for another booking. Check list_my_appointments." };
    bookingId = credit.id;
  } else {
    const r = await guardedWrite(ws.id, base.start_at, base.end_at, null, (q) => q.run(
      `INSERT INTO bookings (workspace_id, ref, owner, channel, customer_name, customer_phone, customer_email, service_id, service_name, start_at, end_at, mode, list_price, amount, pay_method, pay_status, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'confirmed')`,
      base.workspace_id, ref, base.owner, base.channel, base.customer_name, base.customer_phone, base.customer_email, base.service_id, base.service_name,
      base.start_at, base.end_at, base.mode, base.list_price, base.amount, base.pay_method, pending ? "pending_manual" : paidNow ? "paid" : "none"
    ));
    if (!r) return SLOT_TAKEN(cal, free.start);
    bookingId = r.lastId;
  }
  const b = (await db.get<Booking>("SELECT * FROM bookings WHERE id=?", bookingId))!;
  let ev;
  try {
    ev = await placeEvent(ws, cal, b);
  } catch (e: any) {
    // Don't leave a confirmed booking that isn't in the calendar.
    if (credit) await setBooking(b.id, { status: "paid_unbooked" });
    else await setBooking(b.id, { status: "cancelled", note: `Calendar error: ${e?.message}`.slice(0, 300) });
    await logActivity(ws.id, "error", i.channel, `Calendar write failed: ${e?.message}`);
    return { ok: false, message: "Couldn't save the booking in the calendar right now. Please try again in a minute." };
  }
  const out = confirmation(ws, { ...b, ...ev });
  const payNote = !amount ? "" : paidNow ? `${inr(amount)} paid${method === "upi" ? " by UPI" : " in person"}` : method === "venue" ? `${inr(amount)} to pay ${mode === "online" ? "later" : "at venue"}` : method === "upi" ? `${inr(amount)} UPI to confirm` : `${inr(amount)} paid`;
  await logActivity(ws.id, "booking", i.channel, `${b.customer_name} · ${serviceName} · ${cal.fmt(free.start)} · ${b.customer_phone}${payNote ? ` · ${payNote}` : ""} · ${ref}`);
  if (!i.byOwner) await notifyOwners(ws, `New booking ${ref}: ${b.customer_name}, ${serviceName}, ${cal.fmt(free.start)}${payNote ? `, ${payNote}` : ""}.`);
  if (pending) {
    return { ...out, status: "pending_manual", payUrl: payPageUrl(ws, ref), amount,
      message: `Booked, payment pending. Ask them to pay ${inr(amount)} by UPI here: ${payPageUrl(ws, ref)} and send the payment screenshot. The team confirms it. Ref ${ref}.` };
  }
  return out;
}

function normEmail(e?: string) {
  const v = String(e || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? v : "";
}

/** Adds the calendar event for a booking (with invite + Meet link when possible). */
async function placeEvent(ws: Workspace, cal: WorkspaceCalendar, b: Booking) {
  const online = b.mode === "online";
  const loc = online ? "" : [ws.address, mapsLink(ws)].filter(Boolean).join(" · ");
  const payLine = b.pay_method === "free" ? "Free" : b.pay_method === "venue" ? (b.pay_status === "paid" ? `${inr(b.amount)} paid in person` : `${inr(b.amount)} to pay ${online ? "later (not paid yet)" : "at the venue"}`) : b.pay_status === "paid" ? `${inr(b.amount)} paid${b.pay_method === "upi" ? " by UPI" : " online"}` : `${inr(b.amount)} UPI payment pending`;
  const description = [
    `Booking ${b.ref} ${b.channel === "manual" ? "added by the business" : `via ${b.channel === "whatsapp" ? "WhatsApp" : b.channel === "widget" ? "website chat" : b.channel}`}`,
    `Name: ${b.customer_name}`, b.customer_phone ? `Phone: +${b.customer_phone}` : "", b.customer_email ? `Email: ${b.customer_email}` : "",
    `Service: ${b.service_name} (${online ? "online" : "in person"})`, `Payment: ${payLine}`,
    online && ws.meeting_link && !canInvite(ws) ? `Join: ${ws.meeting_link}` : "",
    !online && ws.address ? `Address: ${ws.address}` : "", !online && mapsLink(ws) ? `Map: ${mapsLink(ws)}` : "",
  ].filter(Boolean).join("\n");
  const ev = await cal.createEvent({
    start: DateTime.fromISO(b.start_at), end: DateTime.fromISO(b.end_at),
    summary: `${b.pay_status === "pending_manual" ? "⏳ " : ""}${b.service_name} – ${b.customer_name}`,
    description, location: loc,
    attendee: b.customer_email ? { email: b.customer_email, name: b.customer_name } : undefined,
    meet: online,
    privateProps: { bookingOwner: b.owner, bookingRef: b.ref, bookingPhone: b.customer_phone, customerName: b.customer_name, service: b.service_name },
  });
  const meet = ev.meetLink || (online ? ws.meeting_link : "");
  await setBooking(b.id, { event_id: ev.eventId, meet_link: meet || null });
  return { event_id: ev.eventId, meet_link: meet, invited: ev.invited };
}

function confirmation(ws: Workspace, b: Booking & { invited?: boolean }): BookResult & { ok: true } {
  const online = b.mode === "online";
  const when = whenText(ws, b.start_at);
  const parts = [`Booked ${b.service_name} for ${b.customer_name} on ${when}. Ref ${b.ref}.`];
  if (online) parts.push(b.meet_link ? `Online session link: ${b.meet_link}` : "It's online; the business will share the joining link.");
  else if (ws.address) parts.push(`Address: ${ws.address}${mapsLink(ws) ? ` · Map: ${mapsLink(ws)}` : ""}`);
  if (b.pay_method === "venue" && b.pay_status !== "paid") parts.push(online ? `Pay ${inr(b.amount)} later; ${ws.business_name} will share how.` : `Pay ${inr(b.amount)} at the venue.`);
  if (b.invited) parts.push(`A calendar invite was emailed to ${b.customer_email}.`);
  else if (b.customer_email && !canInvite(ws)) parts.push("(Email invites aren't switched on for this business.)");
  return {
    ok: true, status: "confirmed", ref: b.ref, when, message: parts.join(" "),
    meetLink: b.meet_link || undefined, location: online ? undefined : ws.address || undefined, mapsLink: online ? undefined : mapsLink(ws) || undefined,
    invite: b.invited ? b.customer_email : undefined,
  };
}

// ---------------------------------------------------------------- payments coming in

/**
 * Called from the webhook, the redirect page, the poller and the "I've paid" check. Safe to call many times.
 * Handles the awkward case where money arrives after the hold ran out and someone else took the slot.
 */
export function markPaid(ws: Workspace, b: Booking, paymentId: string | null, via: string): Promise<{ state: "confirmed" | "paid_unbooked" | "already"; message: string }> {
  return withLock(ws.id, () => markPaidLocked(ws, b, paymentId, via));
}

async function markPaidLocked(ws: Workspace, b: Booking, paymentId: string | null, via: string): Promise<{ state: "confirmed" | "paid_unbooked" | "already"; message: string }> {
  const fresh = (await db.get<Booking>("SELECT * FROM bookings WHERE id=?", b.id))!;
  if (fresh.pay_status === "paid" && (fresh.status === "confirmed" || fresh.status === "paid_unbooked")) {
    return { state: "already", message: fresh.status === "confirmed" ? `Payment already received. ${whenText(ws, fresh.start_at)} is confirmed (ref ${fresh.ref}).` : `Payment received earlier (ref ${fresh.ref}); pick a new time to use it.` };
  }
  // Claim the booking so two callers can't both place an event.
  // Only a link that was waiting (or expired just before the money arrived) can become paid. Never a refunded/cancelled-by-owner one.
  const claim = await db.run("UPDATE bookings SET pay_status='paid', payment_id=COALESCE(?, payment_id), updated_at=datetime('now') WHERE id=? AND pay_method='online' AND pay_status IN ('awaiting','expired','failed')", paymentId, b.id);
  if (!claim.changes) return { state: "already", message: "Payment already recorded." };

  const cal = new WorkspaceCalendar(ws);
  const minutes = Math.round(DateTime.fromISO(fresh.end_at).diff(DateTime.fromISO(fresh.start_at), "minutes").minutes);
  const stillFree = fresh.status === "held" && (await cal.isFree(fresh.start_at, minutes, fresh.id).catch(() => ({ ok: false }))).ok;
  // A cancelled/expired booking that gets paid also lands here: rebook if the time is still free.
  const cancelledButFree = fresh.status === "cancelled" && (await cal.isFree(fresh.start_at, minutes).catch(() => ({ ok: false }))).ok;
  if (stillFree || cancelledButFree) {
    await setBooking(fresh.id, { status: "confirmed", hold_expires_at: null });
    const ready = (await db.get<Booking>("SELECT * FROM bookings WHERE id=?", fresh.id))!;
    let ev: { event_id: string; meet_link: string; invited: boolean };
    try {
      ev = await placeEvent(ws, cal, ready);
    } catch (e: any) {
      // The money is in: keep the booking (it still blocks the slot) and ask the owner to add it by hand.
      ev = { event_id: "", meet_link: ws.meeting_link, invited: false };
      await logActivity(ws.id, "error", fresh.channel, `Paid booking ${fresh.ref} couldn't be added to the calendar: ${e?.message}`);
      await notifyOwners(ws, `⚠️ Booking ${fresh.ref} is paid and confirmed, but it couldn't be added to your Google Calendar (${e?.message}). Please add it by hand.`);
    }
    const c = confirmation(ws, { ...ready, ...ev });
    await logActivity(ws.id, "booking", fresh.channel, `Paid ${inr(fresh.amount)} online (${via}) · ${fresh.customer_name} · ${fresh.service_name} · ${whenText(ws, fresh.start_at)} · ${fresh.ref}`);
    await notifyOwners(ws, `💰 ${inr(fresh.amount)} received · booking ${fresh.ref} confirmed: ${fresh.customer_name}, ${fresh.service_name}, ${whenText(ws, fresh.start_at)}.`);
    const msg = `✅ Payment of ${inr(fresh.amount)} received. ${c.message}`;
    await notifyCustomer(ws, fresh, msg);
    return { state: "confirmed", message: msg };
  }
  await setBooking(fresh.id, { status: "paid_unbooked", hold_expires_at: null });
  await logActivity(ws.id, "payment", fresh.channel, `Paid late, slot gone · ${fresh.ref} · ${inr(fresh.amount)} · ${fresh.customer_name}`);
  await notifyOwners(ws, `⚠️ ${fresh.customer_name} paid ${inr(fresh.amount)} for ${fresh.ref}, but the ${whenText(ws, fresh.start_at)} slot was taken meanwhile. They've been asked to pick another time (no extra payment).`);
  const msg = `✅ Payment of ${inr(fresh.amount)} received (ref ${fresh.ref}). Sorry, the ${whenText(ws, fresh.start_at)} slot was taken while the payment was going through. Reply with another day or time and I'll book it at no extra cost.`;
  await notifyCustomer(ws, fresh, msg);
  return { state: "paid_unbooked", message: msg };
}

/** Asks Razorpay what happened to a booking's link. Used by the poller and when a customer says "I paid". */
export async function checkPayment(ws: Workspace, b: Booking): Promise<{ status: string; message: string }> {
  if (b.pay_status === "refund_due") return { status: "refund_due", message: `This booking (ref ${b.ref}) was cancelled after payment; the business handles the refund.` };
  if (b.status === "cancelled" && b.pay_status !== "expired" && b.pay_status !== "awaiting") return { status: "cancelled", message: `Booking ${b.ref} was cancelled.` };
  if (b.pay_status === "paid") return { status: "paid", message: b.status === "confirmed" ? `Paid and confirmed for ${whenText(ws, b.start_at)} (ref ${b.ref}).` : `Paid (ref ${b.ref}); needs a new time.` };
  if (b.pay_method === "upi") return { status: b.pay_status, message: "UPI payments are confirmed by the team. Ask the customer to send the payment screenshot; they'll confirm shortly." };
  if (!b.payment_link_id) return { status: b.pay_status, message: "No online payment for this booking." };
  const link = await fetchPaymentLink(ws, b.payment_link_id);
  if (link.status === "paid") {
    const r = await markPaid(ws, b, link.paymentId, "check");
    return { status: "paid", message: r.message };
  }
  if (link.status === "expired" || link.status === "cancelled") {
    await expireBooking(ws, b, false);
    return { status: "expired", message: "The payment link expired and no payment reached us. If money was taken from their account, it's usually refunded automatically by the bank within 5–7 days. Offer a new link or pay at the venue." };
  }
  return { status: "not_paid_yet", message: `No payment received yet. The link is still open${b.hold_expires_at ? ` for about ${Math.max(1, Math.round((b.hold_expires_at - Date.now()) / 60000))} more minutes` : ""}: ${b.pay_url}. If they paid and it still shows pending, bank confirmations can take a few minutes.` };
}

async function expireBooking(ws: Workspace, b: Booking, tell: boolean) {
  const r = await db.run("UPDATE bookings SET status='cancelled', pay_status='expired', hold_expires_at=NULL, updated_at=datetime('now') WHERE id=? AND status='held' AND pay_status!='paid'", b.id);
  if (!r.changes) return;
  if (b.payment_link_id) await cancelPaymentLink(ws, b.payment_link_id);
  await logActivity(ws.id, "payment", b.channel, `Payment link expired · ${b.ref} · ${b.customer_name}`);
  if (tell) await notifyCustomer(ws, b, `The payment link for ${b.service_name} on ${whenText(ws, b.start_at)} expired, so the slot was released. Reply if you'd like a new link${ws.pay_at_venue ? " or to pay at the venue" : ""}.`);
}

/** How often an unpaid link is checked with Razorpay, in case its webhook never reached us. */
const PAYMENT_POLL_MS = Number(process.env.PAYMENT_POLL_MS || process.env.PAYMENT_SWEEP_MS || 60_000);

/**
 * One job per held booking: confirms a payment whose webhook we missed, and releases the slot once the link
 * has run out (plus 2 minutes' grace for a slow bank). Keeps polling until one of those happens.
 */
onJob("payment_check", async (job) => {
  const b = await getBooking({ id: job.workspace_id } as Workspace, job.ref);
  if (!b || b.status !== "held" || b.pay_status !== "awaiting") return;
  const ws = await db.get<Workspace>("SELECT * FROM workspaces WHERE id=?", job.workspace_id);
  if (!ws) return;
  if (b.payment_link_id && razorpayReady(ws)) {
    const link = await fetchPaymentLink(ws, b.payment_link_id);
    if (link.status === "paid") { await markPaid(ws, b, link.paymentId, "poll"); return; }
    if (link.status === "expired" || link.status === "cancelled") { await expireBooking(ws, b, true); return; }
  }
  if (b.hold_expires_at && Date.now() > b.hold_expires_at + 2 * 60_000) { await expireBooking(ws, b, true); return; }
  return { again: PAYMENT_POLL_MS };
});

/** Bookings held before jobs existed get their check job (runs once at startup; no-op afterwards). */
export async function backfillPaymentChecks() {
  const rows = await db.all<Booking>("SELECT workspace_id, ref FROM bookings WHERE status='held' AND pay_status='awaiting'");
  for (const b of rows) {
    await db.run("INSERT OR IGNORE INTO jobs (workspace_id, kind, ref, due_at, created_at) VALUES (?, 'payment_check', ?, ?, ?)", b.workspace_id, b.ref, Date.now(), Date.now());
  }
}

// ---------------------------------------------------------------- change / cancel

export async function listForOwner(ws: Workspace, owner: string) {
  const rows = await db.all<Booking>(
    "SELECT * FROM bookings WHERE workspace_id=? AND owner=? AND status IN ('confirmed','held','paid_unbooked') AND (end_at >= ? OR status='paid_unbooked') ORDER BY start_at LIMIT 10",
    ws.id, owner, DateTime.now().toISO()!
  );
  return rows.map((b) => ({
    ref: b.ref, name: b.customer_name, service: b.service_name, when: whenText(ws, b.start_at), mode: b.mode,
    status: b.status === "held" ? "waiting for payment" : b.status === "paid_unbooked" ? "paid, needs a new time" : b.pay_status === "pending_manual" ? "booked, UPI payment being confirmed" : "confirmed",
    amount: b.amount || undefined, meetLink: b.meet_link || undefined, payUrl: b.status === "held" ? b.pay_url : undefined,
  }));
}

/** Paid bookings are never cancelled (no refunds): they can only be moved to another time. */
export function isPaidLocked(b: Booking) {
  return b.pay_status === "paid" && b.amount > 0;
}

export async function cancelBooking(ws: Workspace, b: Booking, by: "customer" | "owner", reason = "") {
  if (b.status === "cancelled") return { ok: false, message: "Already cancelled." };
  if (isPaidLocked(b)) {
    return { ok: false, message: `Booking ${b.ref} is already paid, and paid bookings can't be cancelled. It can be moved to another day or time instead (reschedule).` };
  }
  const cal = new WorkspaceCalendar(ws);
  if (b.event_id) await cal.deleteEvent(b.event_id);
  if (b.status === "held" && b.payment_link_id) await cancelPaymentLink(ws, b.payment_link_id);
  const refund = b.pay_status === "paid" && b.amount > 0;
  await setBooking(b.id, { status: "cancelled", hold_expires_at: null, pay_status: refund ? "refund_due" : b.pay_status, note: `${b.note}${b.note ? " · " : ""}Cancelled by ${by}${reason ? `: ${reason}` : ""}`.slice(0, 500) });
  await logActivity(ws.id, "cancel", b.channel, `${b.ref} · ${b.customer_name} · ${b.service_name} · ${whenText(ws, b.start_at)} (by ${by})${refund ? ` · refund ${inr(b.amount)} due` : ""}`);
  if (by === "customer") await notifyOwners(ws, `❌ ${b.customer_name} cancelled ${b.ref} (${b.service_name}, ${whenText(ws, b.start_at)}).${refund ? ` They paid ${inr(b.amount)} online: refund it from your Razorpay dashboard if your policy allows.` : ""}`);
  else await notifyCustomer(ws, b, `Your ${b.service_name} booking on ${whenText(ws, b.start_at)} (ref ${b.ref}) was cancelled by ${ws.business_name}.${reason ? ` Reason: ${reason}.` : ""}${refund ? " Your payment will be refunded." : ""} Reply here to book another time.`);
  return { ok: true, message: `Cancelled ${b.ref}.${refund ? ` ${inr(b.amount)} was paid online; the business handles the refund.` : ""}` };
}

export function reschedule(ws: Workspace, b: Booking, newStart: string) {
  return withLock(ws.id, () => rescheduleLocked(ws, b, newStart));
}

async function rescheduleLocked(ws: Workspace, b: Booking, newStart: string) {
  if (b.status === "paid_unbooked") return { ok: false, message: "This payment has no time yet: book a new time with book_appointment and it will be used." };
  if (b.status !== "confirmed") return { ok: false, message: b.status === "held" ? "Finish the payment first, or book a different time." : "This booking was cancelled; make a new booking instead." };
  if (DateTime.fromISO(b.end_at) < DateTime.now()) return { ok: false, message: "That appointment is already over." };
  const cal = new WorkspaceCalendar(ws);
  const minutes = Math.round(DateTime.fromISO(b.end_at).diff(DateTime.fromISO(b.start_at), "minutes").minutes);
  const f = await cal.isFree(newStart, minutes, b.id);
  if (!f.ok) return { ok: false, message: `${cal.fmt(f.start)} isn't free.${f.result.slots.length ? " Free that day: " + f.result.slots.slice(0, 4).join(", ") : ""}` };
  // Claim the new time in the database first (safe across servers), then move the calendar event.
  const moved = await guardedWrite(ws.id, f.start.toISO()!, f.end.toISO()!, b.id, (q) =>
    q.run("UPDATE bookings SET start_at=?, end_at=?, updated_at=datetime('now') WHERE id=?", f.start.toISO()!, f.end.toISO()!, b.id));
  if (!moved) return { ok: false, message: `${cal.fmt(f.start)} was just taken. Pick another time.` };
  if (b.event_id) {
    try {
      await cal.updateEvent(b.event_id, { start: f.start, end: f.end });
    } catch (e) {
      await setBooking(b.id, { start_at: b.start_at, end_at: b.end_at });
      throw e;
    }
  }
  await logActivity(ws.id, "reschedule", b.channel, `Moved ${b.ref} to ${cal.fmt(f.start)} · ${b.customer_name}`);
  await notifyOwners(ws, `🔁 ${b.customer_name} moved ${b.ref} (${b.service_name}) to ${cal.fmt(f.start)}.`);
  return { ok: true, message: `Moved to ${cal.fmt(f.start)}. Ref ${b.ref}.${b.customer_email && canInvite(ws) ? " The calendar invite was updated." : ""}` };
}

/** Owner confirms (or rejects) a UPI payment they checked in their bank app. */
export async function confirmManualPayment(ws: Workspace, b: Booking, received: boolean, opts: { quiet?: boolean } = {}) {
  if (b.pay_status !== "pending_manual") return { ok: false, message: "This booking isn't waiting for a UPI confirmation." };
  if (!received) {
    await cancelBooking(ws, b, "owner", "payment not received");
    return { ok: true, message: `Marked as not paid and cancelled ${b.ref}. The customer was told.` };
  }
  await setBooking(b.id, { pay_status: "paid" });
  if (b.event_id) await new WorkspaceCalendar(ws).updateEvent(b.event_id, { summary: `${b.service_name} – ${b.customer_name}` }).catch(() => undefined);
  await logActivity(ws.id, "payment", b.channel, `UPI ${inr(b.amount)} confirmed · ${b.ref} · ${b.customer_name}`);
  if (!opts.quiet) await notifyCustomer(ws, b, `✅ Payment of ${inr(b.amount)} confirmed. See you on ${whenText(ws, b.start_at)}! (ref ${b.ref})`);
  return { ok: true, message: `Payment confirmed for ${b.ref}.` };
}

export type BookingFilter = "upcoming" | "pending" | "past" | "cancelled" | "all";

export async function listBookings(ws: Workspace, filter: BookingFilter = "upcoming", limit = 100) {
  const now = DateTime.now().toISO()!;
  const q: Record<BookingFilter, [string, any[], string]> = {
    upcoming: ["status IN ('confirmed','held','paid_unbooked') AND (end_at >= ? OR status='paid_unbooked')", [now], "start_at"],
    pending: ["(status != 'cancelled' AND (pay_status IN ('pending_manual','awaiting') OR status='paid_unbooked')) OR pay_status='refund_due'", [], "start_at"],
    past: ["status='confirmed' AND end_at < ?", [now], "start_at DESC"],
    cancelled: ["status='cancelled'", [], "start_at DESC"],
    all: ["1=1", [], "start_at DESC"],
  };
  const [where, args, order] = q[filter];
  return db.all<Booking>(`SELECT * FROM bookings WHERE workspace_id=? AND (${where}) ORDER BY ${order} LIMIT ?`, ws.id, ...args, limit);
}

export async function countPending(ws: Workspace) {
  const r = await db.get("SELECT COUNT(*) AS c FROM bookings WHERE workspace_id=? AND ((status != 'cancelled' AND (pay_status='pending_manual' OR status='paid_unbooked')) OR pay_status='refund_due')", ws.id);
  return Number(r?.c ?? 0);
}

// ---------------------------------------------------------------- messages out

async function sendWhatsApp(ws: Workspace, phone: string, text: string) {
  const key = decrypt(ws.kapso_key_enc);
  if (!key || !ws.kapso_phone_number_id || !phone) return false;
  try {
    await sendText(key, ws.kapso_phone_number_id, phone, text);
    return true;
  } catch (e: any) {
    // Usually: more than 24h since they last wrote, so WhatsApp only allows approved templates.
    console.warn(`[notify ${ws.public_id}] ${e?.message}`);
    return false;
  }
}

/** WhatsApp only allows free-form messages within 24h of the person's last message. Returns false if it didn't go. */
export function tryWhatsApp(ws: Workspace, phone: string, text: string) {
  return ws.whatsapp_enabled ? sendWhatsApp(ws, phone, text) : Promise.resolve(false);
}

/** Tells the customer in their chat (WhatsApp). Website-chat customers see it on the payment page instead. */
export async function notifyCustomer(ws: Workspace, b: Booking, text: string) {
  // Bookings the owner added (phone/walk-in) are tied to the customer's number, so WhatsApp works for them too.
  if (["whatsapp", "phone", "manual"].includes(b.channel) && ws.whatsapp_enabled && b.customer_phone) {
    const ok = await sendWhatsApp(ws, b.customer_phone, text);
    await appendToChat(ws.id, "whatsapp", b.customer_phone, text);
    return ok;
  }
  if (b.channel === "widget") await appendToChat(ws.id, "widget", b.owner.replace(/^widget:/, ""), text);
  if (b.channel === "test") await appendToChat(ws.id, "test", b.owner.replace(/^test:/, ""), text);
  return false;
}

/** Owner alerts on WhatsApp (only reach them if they messaged the business number in the last 24h). */
export async function notifyOwners(ws: Workspace, text: string) {
  if (!ws.whatsapp_enabled) return;
  for (const p of ownerPhones(ws)) await sendWhatsApp(ws, p, text);
}

/** Keeps the assistant's memory in step with messages we sent outside a reply. */
async function appendToChat(wsId: number, channel: string, ext: string, text: string) {
  const row = await db.get<{ history: string }>("SELECT history FROM conversations WHERE workspace_id=? AND channel=? AND external_id=?", wsId, channel, ext);
  if (!row) return;
  const h = JSON.parse(row.history);
  const last = h[h.length - 1];
  // Keep user/assistant turns alternating.
  if (last?.role === "assistant") h.push({ role: "user", content: "(system: automatic update below)" });
  h.push({ role: "assistant", content: text });
  await db.run("UPDATE conversations SET history=?, updated_at=datetime('now') WHERE workspace_id=? AND channel=? AND external_id=?", JSON.stringify(h), wsId, channel, ext);
}

export { findService, listServices };
export type { Quote };
