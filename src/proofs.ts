// Payment screenshots. Customers send them for UPI payments (WhatsApp photo or the pay page); owners attach them to
// bookings they took money for. Claude reads the screenshot; we then check the amount, who was paid, and that the
// transaction ID (UTR) hasn't been used before. A screenshot can be faked, so auto-confirming is opt-in per business.
import { DateTime } from "luxon";
import { db, logActivity, Workspace } from "./db.js";
import { aiChat } from "./ai/registry.js";
import { Booking, confirmManualPayment, notifyOwners } from "./bookings.js";
import { inr } from "./catalog.js";
import { randomBytes } from "node:crypto";
import { deleteFile, getFile, putFile, storageReady } from "./storage.js";

export const MAX_PROOF_BYTES = 3 * 1024 * 1024;
const MIMES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

export interface Proof {
  id: number; workspace_id: number; booking_id: number | null; sender: string; mime: string; caption: string;
  verdict: "unchecked" | "ok" | "mismatch" | "unreadable" | "owner"; amount: number | null; utr: string; payee: string; detail: string; created_at: string; purged: number;
}

export function cleanMime(m: string) {
  const v = String(m || "").split(";")[0]!.trim().toLowerCase();
  return MIMES.includes(v) ? v : v === "image/jpg" ? "image/jpeg" : "";
}

export async function saveProofImage(ws: Workspace, sender: string, buf: Buffer, mime: string, caption = ""): Promise<number> {
  const m = cleanMime(mime);
  if (!m) throw new Error("Please send a photo (JPG or PNG).");
  if (buf.length > MAX_PROOF_BYTES) throw new Error("That image is too large. Please send a smaller screenshot.");
  let m2 = m;
  ({ buf, mime: m2 } = await shrink(buf, m));
  // With R2 set up the photo goes to file storage and the row keeps only its key; otherwise it stays in the database.
  // Below the storage cap only, so R2 can never go past its free 10 GB.
  let key: string | null = null;
  if (storageReady() && (await r2Room(buf.length))) {
    key = `proofs/${ws.id}/${Date.now()}-${randomBytes(6).toString("hex")}.${m2.split("/")[1]}`;
    try { await putFile(key, buf, m2); r2Used! += buf.length; } catch (e: any) { console.error("photo upload, keeping it in the database:", e?.message); key = null; }
  }
  const r = await db.run("INSERT INTO payment_proofs (workspace_id, sender, image, mime, caption, r2_key, bytes) VALUES (?,?,?,?,?,?,?)",
    ws.id, sender, key ? "" : buf.toString("base64"), m2, caption.slice(0, 300), key, buf.length);
  return r.lastId;
}

/** Big photos are resized (max 1600 px) and re-saved as JPEG: still sharp enough to read, about a third of the size. */
async function shrink(buf: Buffer, mime: string): Promise<{ buf: Buffer; mime: string }> {
  if (buf.length < 200 * 1024 || mime === "image/gif") return { buf, mime };
  try {
    const sharp = (await import("sharp")).default;
    const out = await sharp(buf).rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 78, mozjpeg: true }).toBuffer();
    return out.length < buf.length ? { buf: out, mime: "image/jpeg" } : { buf, mime };
  } catch {
    return { buf, mime }; // unreadable by sharp: keep the original
  }
}

// ---- R2 safety cap: bytes we keep in R2, counted from the database (refreshed every 10 minutes).
export const r2CapBytes = () => Math.round(Number(process.env.R2_MAX_GB || 9) * 1024 ** 3);
let r2Used: number | null = null, r2CountedAt = 0;
export async function r2UsedBytes(): Promise<number> {
  if (r2Used === null || Date.now() - r2CountedAt > 10 * 60_000) {
    const row = await db.get<{ b: number }>("SELECT COALESCE(SUM(bytes),0) AS b FROM payment_proofs WHERE r2_key IS NOT NULL");
    r2Used = Number(row?.b ?? 0); r2CountedAt = Date.now();
  }
  return r2Used;
}
async function r2Room(size: number) {
  const ok = (await r2UsedBytes()) + size <= r2CapBytes();
  if (!ok && !capHit) console.warn("[storage] R2 cap reached; keeping new photos in the database");
  capHit = !ok;
  return ok;
}
let capHit = false;
/** True once a photo was kept out of R2 because of the cap (until one fits again). */
export const r2CapHit = () => capHit;

/** Screenshots older than PHOTO_KEEP_DAYS (default 180) lose the image; amount, UTR and verdict stay for checks. */
export async function purgeOldPhotos() {
  const days = Math.max(30, Number(process.env.PHOTO_KEEP_DAYS || 180));
  const old = await db.all<{ id: number; r2_key: string | null }>(
    `SELECT id, r2_key FROM payment_proofs WHERE purged=0 AND created_at < datetime('now','-${days} days') LIMIT 500`);
  if (!old.length) return 0;
  await deletePhotoFiles(old.map((r) => r.r2_key));
  await db.run(`UPDATE payment_proofs SET image='', r2_key=NULL, bytes=0, purged=1 WHERE id IN (${old.map(() => "?").join(",")})`, ...old.map((r) => r.id));
  r2Used = null; capHit = false;
  return old.length;
}

/** The photo's bytes (base64), wherever it is stored. */
async function photoData(row: { image: string; r2_key?: string | null }): Promise<string | null> {
  if (!row.r2_key) return row.image || null;
  const f = await getFile(row.r2_key);
  return f ? f.bytes.toString("base64") : null;
}

/** Removes stored photo files for the given rows (best effort; a failure leaves an orphan, not an error). */
export async function deletePhotoFiles(keys: (string | null | undefined)[]) {
  for (const k of keys) if (k) await deleteFile(k).catch((e) => console.error("photo delete", k, e?.message));
}

/** The newest photo from this sender not yet linked to a booking (within the last 2 hours). */
export function latestLoosePhoto(ws: Workspace, sender: string) {
  return db.get<{ id: number }>(
    "SELECT id FROM payment_proofs WHERE workspace_id=? AND sender=? AND booking_id IS NULL AND created_at >= datetime('now','-2 hours') ORDER BY id DESC LIMIT 1",
    ws.id, sender
  );
}

export function proofsFor(ws: Workspace, bookingIds: number[]) {
  if (!bookingIds.length) return Promise.resolve([] as Proof[]);
  return db.all<Proof>(
    `SELECT id, workspace_id, booking_id, sender, mime, caption, verdict, amount, utr, payee, detail, created_at, purged FROM payment_proofs
     WHERE workspace_id=? AND booking_id IN (${bookingIds.map(() => "?").join(",")}) ORDER BY id`,
    ws.id, ...bookingIds
  );
}

export async function proofImage(ws: Workspace, id: number) {
  const row = await db.get<{ image: string; r2_key: string | null; mime: string; booking_id: number | null }>(
    "SELECT image, r2_key, mime, booking_id FROM payment_proofs WHERE workspace_id=? AND id=?", ws.id, id);
  if (!row) return undefined;
  const image = await photoData(row);
  return image ? { image, mime: row.mime, booking_id: row.booking_id } : undefined;
}

export async function purgeLoosePhotos() {
  const old = await db.all<{ id: number; r2_key: string | null }>("SELECT id, r2_key FROM payment_proofs WHERE booking_id IS NULL AND created_at < datetime('now','-2 days')");
  if (!old.length) return;
  await deletePhotoFiles(old.map((r) => r.r2_key));
  r2Used = null;
  await db.run(`DELETE FROM payment_proofs WHERE id IN (${old.map(() => "?").join(",")})`, ...old.map((r) => r.id));
}

// ---------------------------------------------------------------- reading

export interface Receipt {
  is_payment_screenshot: boolean; successful: boolean | null; amount: number | null; utr: string; payee_upi_id: string; payee_name: string; paid_at: string;
}

async function readReceipt(ws: Workspace, image: string, mime: string): Promise<Receipt> {
  const res = await aiChat(ws, {
    system: { stable: "You read payment screenshots and report exactly what they show." },
    maxTokens: 400,
    forceTool: "payment_details",
    tools: [{
      name: "payment_details",
      description: "What the screenshot shows. Copy values exactly as printed; use empty string / null when not visible. Never guess.",
      input_schema: {
        type: "object",
        properties: {
          is_payment_screenshot: { type: "boolean", description: "A UPI / bank / wallet payment confirmation screen" },
          successful: { type: ["boolean", "null"], description: "Shows the payment as successful/completed (false if failed/pending)" },
          amount: { type: ["number", "null"], description: "Amount paid, in rupees" },
          utr: { type: "string", description: "UPI transaction ID / UTR / UPI Ref No (usually 12 digits)" },
          payee_upi_id: { type: "string", description: "The UPI ID it was paid TO (e.g. name@okaxis)" },
          payee_name: { type: "string", description: "Name it was paid TO" },
          paid_at: { type: "string", description: "Date and time shown, as ISO 8601 if possible (e.g. 2026-10-01T14:05)" },
        },
        required: ["is_payment_screenshot", "successful", "amount", "utr", "payee_upi_id", "payee_name", "paid_at"],
      },
    }],
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mime, data: image } },
        { type: "text", text: "Read this payment screenshot." },
      ],
    }],
  });
  const t = res.content.find((b) => b.type === "tool_use") as any;
  const i = t?.input ?? {};
  return {
    is_payment_screenshot: !!i.is_payment_screenshot, successful: typeof i.successful === "boolean" ? i.successful : null,
    amount: typeof i.amount === "number" && isFinite(i.amount) ? i.amount : null, utr: String(i.utr ?? "").replace(/\s+/g, "").slice(0, 40),
    payee_upi_id: String(i.payee_upi_id ?? "").trim().toLowerCase().slice(0, 80), payee_name: String(i.payee_name ?? "").trim().slice(0, 80), paid_at: String(i.paid_at ?? "").slice(0, 40),
  };
}

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2);

/** Compares what the screenshot says with the booking. `sure` = good enough to confirm without the owner looking. */
export async function judge(ws: Workspace, b: Booking, r: Receipt, proofId: number) {
  if (!r.is_payment_screenshot) return { verdict: "unreadable" as const, sure: false, problems: ["it doesn't look like a payment screenshot"] };
  const problems: string[] = [];
  const unsure: string[] = [];
  if (r.successful === false) problems.push("the payment isn't shown as successful");
  if (r.amount == null) unsure.push("couldn't read the amount");
  else if (Math.round(r.amount) !== Math.round(b.amount)) problems.push(`the amount is ${inr(r.amount)}, not ${inr(b.amount)}`);
  const upi = (ws.upi_id || "").toLowerCase();
  if (upi && r.payee_upi_id) {
    if (r.payee_upi_id !== upi) problems.push(`it was paid to ${r.payee_upi_id}, not ${upi}`);
  } else if (ws.upi_name && r.payee_name) {
    const want = words(ws.upi_name);
    if (want.length && !words(r.payee_name).some((w) => want.includes(w))) problems.push(`it was paid to "${r.payee_name}", not "${ws.upi_name}"`);
    else unsure.push("only the name (not the UPI ID) is visible");
  } else unsure.push("couldn't see who it was paid to");
  if (!/^\d{12}$/.test(r.utr)) unsure.push("no 12-digit UPI transaction ID visible");
  else {
    const dup = await db.get(
      "SELECT p.id FROM payment_proofs p WHERE p.workspace_id=? AND p.utr=? AND p.id<>? AND p.verdict IN ('ok','owner') AND COALESCE(p.booking_id,0)<>?",
      ws.id, r.utr, proofId, b.id
    );
    if (dup) problems.push("this transaction ID was already used for another booking");
  }
  const paid = DateTime.fromISO(r.paid_at, { zone: ws.timezone || "Asia/Kolkata" });
  const made = DateTime.fromSQL(b.created_at, { zone: "utc" });
  if (paid.isValid && made.isValid && paid < made.minus({ minutes: 30 })) problems.push("the payment is dated before the booking was made");
  return { verdict: problems.length ? ("mismatch" as const) : ("ok" as const), sure: !problems.length && !unsure.length, problems: [...problems, ...unsure] };
}

/** A customer's screenshot for a UPI booking: read, check, maybe confirm, tell the owner. Returns what to tell the customer. */
export async function submitCustomerProof(ws: Workspace, b: Booking, proofId: number) {
  await db.run("UPDATE payment_proofs SET booking_id=? WHERE id=? AND workspace_id=?", b.id, proofId, ws.id);
  if (b.pay_status === "paid") return { ok: true, status: "already_paid", message: "This booking is already marked as paid. Nothing else to do." };
  if (b.pay_status !== "pending_manual" || b.status !== "confirmed") return { ok: false, message: "This booking isn't waiting for a UPI payment, so I've just saved the photo for the team." };
  const row = (await db.get<{ image: string; r2_key: string | null; mime: string }>("SELECT image, r2_key, mime FROM payment_proofs WHERE id=?", proofId))!;
  let r: Receipt;
  try {
    const data = await photoData(row);
    if (!data) throw new Error("The photo file is missing");
    r = await readReceipt(ws, data, row.mime);
  } catch (e: any) {
    await logActivity(ws.id, "error", b.channel, `Couldn't read screenshot for ${b.ref}: ${e?.message}`);
    await notifyOwners(ws, `🧾 ${b.customer_name} sent a payment screenshot for ${b.ref} (${inr(b.amount)}). Please check it on the Bookings page.`);
    return { ok: true, status: "sent_to_team", message: "Got it. The team will check the payment and confirm shortly." };
  }
  const j = await judge(ws, b, r, proofId);
  await db.run("UPDATE payment_proofs SET verdict=?, amount=?, utr=?, payee=?, detail=? WHERE id=?",
    j.verdict, r.amount, r.utr, r.payee_upi_id || r.payee_name, j.problems.join("; ").slice(0, 300), proofId);
  const facts = `${r.amount != null ? inr(r.amount) : "amount ?"}${r.utr ? `, UTR ${r.utr}` : ""}`;
  if (j.verdict === "ok" && j.sure && ws.upi_auto_confirm) {
    await confirmManualPayment(ws, b, true, { quiet: true });
    await logActivity(ws.id, "payment", b.channel, `Screenshot checked, auto-confirmed · ${b.ref} · ${facts}`);
    await notifyOwners(ws, `✅ ${b.ref} confirmed from ${b.customer_name}'s screenshot (${facts}). Please glance at your bank app to be sure.`);
    return { ok: true, status: "confirmed", message: `Payment of ${inr(b.amount)} verified and the booking is confirmed.` };
  }
  if (j.verdict === "ok") {
    await logActivity(ws.id, "payment", b.channel, `Screenshot looks right, needs your OK · ${b.ref} · ${facts}`);
    await notifyOwners(ws, `🧾 ${b.customer_name} sent a payment screenshot for ${b.ref}: ${facts}${j.problems.length ? ` (${j.problems.join("; ")})` : ""}. Looks right. Check your bank, then reply "confirm ${b.ref}" or use Mark paid on the Bookings page.`);
    return { ok: true, status: "checking", message: "Thanks! The screenshot looks right. The team will confirm the payment shortly." };
  }
  await logActivity(ws.id, "handoff", b.channel, `Screenshot doesn't match · ${b.ref}: ${j.problems.join("; ")}`);
  await notifyOwners(ws, `⚠️ Payment screenshot for ${b.ref} (${b.customer_name}) doesn't match: ${j.problems.join("; ")}. Please check it on the Bookings page.`);
  return {
    ok: false, status: "problem",
    message: `The screenshot doesn't match: ${j.problems.join("; ")}. Please pay ${inr(b.amount)} to ${ws.upi_id} and send the screenshot of that payment. If you think this is a mistake, the team has been told and will check.`,
  };
}

/** The owner attaches their own screenshot: it's proof they received the money. */
export async function attachOwnerProof(ws: Workspace, b: Booking, proofId: number) {
  await db.run("UPDATE payment_proofs SET booking_id=?, verdict='owner' WHERE id=? AND workspace_id=?", b.id, proofId, ws.id);
  let confirmed = false;
  if (b.pay_status === "pending_manual") {
    await confirmManualPayment(ws, b, true);
    confirmed = true;
  }
  await logActivity(ws.id, "payment", "owner", `Payment proof added · ${b.ref}`);
  const note = b.pay_status === "awaiting" ? " Note: this booking is still waiting for its payment link to be paid, so it stays unpaid until then." : "";
  return { ok: true, message: `Saved the screenshot as payment proof for ${b.ref} (${b.customer_name}).${confirmed ? " The payment is now marked as received." : ""}${note}` };
}
