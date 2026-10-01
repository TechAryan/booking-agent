import crypto from "node:crypto";
import { env } from "./env.js";
import type { Workspace } from "./db.js";
import { decrypt, safeEqual } from "./security.js";

// ============================================================ Razorpay (each business uses its own account)

function auth(keyId: string, secret: string) {
  return `Basic ${Buffer.from(`${keyId}:${secret}`).toString("base64")}`;
}

async function rz(keyId: string, secret: string, path: string, init: RequestInit = {}) {
  let res: Response;
  try {
    res = await fetch(`${env.razorpayApiBase}${path}`, {
      ...init,
      headers: { Authorization: auth(keyId, secret), "Content-Type": "application/json", ...(init.headers || {}) },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e: any) {
    throw new Error(`Couldn't reach Razorpay (${e?.message || "network error"}).`);
  }
  const text = await res.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch {}
  if (!res.ok) {
    if (res.status === 401) throw new Error("Razorpay rejected these keys. Copy the Key ID and Key Secret again from Razorpay → Account & Settings → API Keys.");
    throw new Error(`Razorpay error ${res.status}: ${body?.error?.description || text.slice(0, 200)}`);
  }
  return body;
}

export function razorpayReady(ws: Workspace) {
  return !!(ws.razorpay_key_id && ws.razorpay_secret_enc);
}

function keysOf(ws: Workspace) {
  const secret = decrypt(ws.razorpay_secret_enc);
  if (!ws.razorpay_key_id || !secret) throw new Error("Razorpay is not connected.");
  return { keyId: ws.razorpay_key_id, secret };
}

/** Cheap authenticated call to confirm the keys work. Tells test keys from live keys. */
export async function verifyRazorpay(keyId: string, secret: string): Promise<{ mode: "test" | "live" }> {
  if (!/^rzp_(test|live)_\w+$/.test(keyId)) throw new Error("The Key ID should look like rzp_live_… or rzp_test_…");
  await rz(keyId, secret, "/v1/payment_links?count=1");
  return { mode: keyId.startsWith("rzp_test_") ? "test" : "live" };
}

export interface LinkInput {
  amount: number; // rupees
  ref: string;
  description: string;
  customer: { name: string; phone?: string; email?: string };
  expiresInMinutes: number;
  callbackUrl: string;
}

export async function createPaymentLink(ws: Workspace, i: LinkInput): Promise<{ id: string; url: string }> {
  const { keyId, secret } = keysOf(ws);
  const phone = (i.customer.phone || "").replace(/\D/g, "");
  const body = {
    amount: Math.round(i.amount * 100), // paise
    currency: "INR",
    accept_partial: false,
    // Razorpay needs at least ~15 minutes; add a minute of margin.
    expire_by: Math.floor(Date.now() / 1000) + Math.max(16, i.expiresInMinutes) * 60,
    reference_id: i.ref,
    description: i.description.slice(0, 2000),
    customer: { name: i.customer.name.slice(0, 60), ...(phone ? { contact: `+${phone}` } : {}), ...(i.customer.email ? { email: i.customer.email } : {}) },
    notify: { sms: false, email: false }, // we send the link ourselves in the chat
    reminder_enable: false,
    notes: { booking_ref: i.ref, business: ws.business_name.slice(0, 200) },
    callback_url: i.callbackUrl,
    callback_method: "get",
  };
  const r = await rz(keyId, secret, "/v1/payment_links", { method: "POST", body: JSON.stringify(body) });
  return { id: r.id, url: r.short_url };
}

export type LinkStatus = "created" | "partially_paid" | "paid" | "expired" | "cancelled";

export async function fetchPaymentLink(ws: Workspace, id: string): Promise<{ status: LinkStatus; paymentId: string | null; amountPaid: number }> {
  const { keyId, secret } = keysOf(ws);
  const r = await rz(keyId, secret, `/v1/payment_links/${encodeURIComponent(id)}`);
  const pay = (r.payments || []).find((p: any) => p.status === "captured") || (r.payments || [])[0];
  return { status: r.status, paymentId: pay?.payment_id || null, amountPaid: Number(r.amount_paid || 0) / 100 };
}

export async function cancelPaymentLink(ws: Workspace, id: string) {
  const { keyId, secret } = keysOf(ws);
  await rz(keyId, secret, `/v1/payment_links/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" }).catch(() => undefined);
}

/** Webhook signature: HMAC-SHA256 of the raw body with the webhook secret. */
export function verifyWebhookSignature(secret: string, raw: Buffer, signature: string) {
  const expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  return !!signature && safeEqual(expected, signature);
}

/** Redirect after paying: HMAC-SHA256 of "link_id|reference_id|status|payment_id" with the key secret. */
export function verifyCallbackSignature(ws: Workspace, q: Record<string, string>) {
  const secret = decrypt(ws.razorpay_secret_enc);
  if (!secret) return false;
  const payload = `${q.razorpay_payment_link_id}|${q.razorpay_payment_link_reference_id}|${q.razorpay_payment_link_status}|${q.razorpay_payment_id}`;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return !!q.razorpay_signature && safeEqual(expected, q.razorpay_signature);
}

// ============================================================ UPI (manual confirmation)

export function upiReady(ws: Workspace) {
  return /^[\w.\-]{2,}@[a-zA-Z][\w.]{1,}$/.test(ws.upi_id || "");
}

export function upiUri(ws: Workspace, amount: number, ref: string) {
  const p = new URLSearchParams({ pa: ws.upi_id, pn: (ws.upi_name || ws.business_name).slice(0, 50), am: amount.toFixed(2), cu: "INR", tn: `Booking ${ref}` });
  return `upi://pay?${p.toString().replace(/\+/g, "%20")}`;
}
