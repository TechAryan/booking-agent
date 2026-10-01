import { DateTime } from "luxon";
import { db, User, Workspace } from "./db.js";
import { decrypt, hashPassword, randomToken } from "./security.js";
import { env } from "./env.js";

// ---------- Users ----------

export function getUser(id: number): Promise<User | undefined> {
  return db.get<User>("SELECT * FROM users WHERE id = ?", id);
}

export function getUserByEmail(email: string): Promise<User | undefined> {
  return db.get<User>("SELECT * FROM users WHERE email = ? COLLATE NOCASE", email.trim());
}

export async function listUsers(): Promise<(User & { business_name: string | null; setup: string; shared_key_id: number | null; last_paid_on: string | null })[]> {
  const rows = await db.all(
    `SELECT u.*, w.business_name, w.business_done, w.claude_ok, w.google_ok, w.tested, w.widget_enabled, w.whatsapp_enabled, w.shared_key_id,
       (SELECT MAX(paid_on) FROM payments p WHERE p.user_id = u.id) AS last_paid_on
     FROM users u LEFT JOIN workspaces w ON w.user_id = u.id ORDER BY u.role DESC, u.created_at DESC`
  );
  return rows.map((r) => ({ ...r, setup: setupSummary(r) }));
}

function setupSummary(r: any): string {
  if (r.role === "admin" && !r.business_name) return "—";
  const done = [r.business_done, r.claude_ok, r.google_ok, r.tested].filter(Boolean).length;
  const live = [r.widget_enabled ? "Widget" : "", r.whatsapp_enabled ? "WhatsApp" : ""].filter(Boolean).join(" + ");
  return live ? `Live: ${live}` : `${done}/4 steps`;
}

export async function createUser(input: {
  email: string;
  name: string;
  password: string;
  role: "user" | "admin";
  validUntil: string | null;
  permWidget: boolean;
  permWhatsapp: boolean;
  notes?: string;
  mustChange?: boolean;
}): Promise<number> {
  const res = await db.run(
    `INSERT INTO users (email, name, password_hash, role, valid_until, perm_widget, perm_whatsapp, notes, must_change_password)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    input.email.trim().toLowerCase(),
    input.name.trim(),
    hashPassword(input.password),
    input.role,
    input.validUntil,
    input.permWidget ? 1 : 0,
    input.permWhatsapp ? 1 : 0,
    input.notes ?? "",
    input.mustChange === false ? 0 : 1
  );
  return res.lastId;
}

export async function setPassword(userId: number, password: string, mustChange: boolean) {
  await db.run("UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?", hashPassword(password), mustChange ? 1 : 0, userId);
}

export async function countActiveAdmins(): Promise<number> {
  const r = await db.get("SELECT COUNT(*) AS c FROM users WHERE role='admin' AND status='active'");
  return Number(r?.c ?? 0);
}

/** Deletes a user and everything that belongs to them (explicitly, so it also works where foreign keys aren't enforced). */
export async function deleteUser(userId: number) {
  const ws = await db.get<{ id: number }>("SELECT id FROM workspaces WHERE user_id = ?", userId);
  if (ws) {
    for (const t of ["activity", "services", "holidays", "knowledge", "offers", "bookings", "payment_proofs"]) await db.run(`DELETE FROM ${t} WHERE workspace_id = ?`, ws.id);
    await db.run("DELETE FROM conversations WHERE workspace_id = ?", ws.id);
    await db.run("DELETE FROM workspaces WHERE id = ?", ws.id);
  }
  await db.run("DELETE FROM payments WHERE user_id = ?", userId);
  await db.run("DELETE FROM sessions WHERE user_id = ?", userId);
  await db.run("DELETE FROM users WHERE id = ?", userId);
}

export function todayIST(): string {
  return DateTime.now().setZone("Asia/Kolkata").toISODate()!;
}

/** Whole days of access left (0 = today is the last day). null = no expiry. Negative = expired. */
export function daysLeft(u: Pick<User, "valid_until">): number | null {
  if (!u.valid_until) return null;
  const end = DateTime.fromISO(u.valid_until, { zone: "Asia/Kolkata" });
  const today = DateTime.fromISO(todayIST(), { zone: "Asia/Kolkata" });
  return Math.round(end.diff(today, "days").days);
}

/** Why this user can't use the product right now, or null if they can. */
export function accessProblem(u: User): string | null {
  if (u.status !== "active") return "Your account is inactive. Please contact support.";
  if (u.valid_until) {
    const today = DateTime.now().setZone("Asia/Kolkata").toISODate()!;
    if (today > u.valid_until) return `Your subscription ended on ${u.valid_until}. Please contact support to renew.`;
  }
  return null;
}

/** Create the first admin from ADMIN_EMAIL / ADMIN_PASSWORD if there is none. */
export async function bootstrapAdmin() {
  const r = await db.get("SELECT COUNT(*) AS c FROM users WHERE role='admin'");
  if (Number(r?.c ?? 0) > 0) return;
  if (!env.bootstrapAdminEmail || !env.bootstrapAdminPassword) {
    console.warn("⚠️  No admin exists. Set ADMIN_EMAIL and ADMIN_PASSWORD and restart, or run: npm run create-admin");
    return;
  }
  await createUser({
    email: env.bootstrapAdminEmail,
    name: "Admin",
    password: env.bootstrapAdminPassword,
    role: "admin",
    validUntil: null,
    permWidget: true,
    permWhatsapp: true,
    mustChange: false,
  });
  console.log(`👤 Created first admin ${env.bootstrapAdminEmail}`);
}

// ---------- Workspaces ----------

export async function getWorkspaceForUser(userId: number): Promise<Workspace> {
  let ws = await db.get<Workspace>("SELECT * FROM workspaces WHERE user_id = ?", userId);
  if (!ws) {
    await db.run("INSERT OR IGNORE INTO workspaces (user_id, public_id) VALUES (?, ?)", userId, `ws_${randomToken(12)}`);
    ws = (await db.get<Workspace>("SELECT * FROM workspaces WHERE user_id = ?", userId))!;
  }
  return ws;
}

export async function getWorkspaceByPublicId(publicId: string): Promise<(Workspace & { owner: User }) | undefined> {
  const ws = await db.get<Workspace>("SELECT * FROM workspaces WHERE public_id = ?", publicId);
  if (!ws) return undefined;
  const owner = await getUser(ws.user_id);
  if (!owner) return undefined;
  return { ...ws, owner };
}

const WS_COLUMNS = new Set([
  "business_name", "timezone", "open_hour", "close_hour", "working_days", "slot_minutes", "services", "extra_info",
  "business_done", "anthropic_key_enc", "claude_model", "claude_ok", "google_sa_enc", "google_sa_email",
  "google_calendar_id", "google_ok", "tested", "widget_enabled", "widget_color", "widget_greeting", "kapso_key_enc",
  "kapso_phone_number_id", "kapso_display_number", "kapso_webhook_id", "kapso_webhook_secret_enc", "whatsapp_enabled", "shared_key_id",
  "business_type", "contact_email", "contact_phone", "address", "maps_url", "website", "socials", "meeting_link", "services_migrated",
  "online_discount_pct", "pay_at_venue", "razorpay_key_id", "razorpay_secret_enc", "razorpay_webhook_secret_enc", "upi_id", "upi_name", "upi_auto_confirm",
  "owner_phones", "google_refresh_enc", "google_account_email",
]);

export async function updateWorkspace(id: number, fields: Partial<Workspace>) {
  const keys = Object.keys(fields).filter((k) => WS_COLUMNS.has(k));
  if (!keys.length) return;
  const sql = `UPDATE workspaces SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`;
  const values = keys.map((k) => ((fields as any)[k] === undefined ? null : (fields as any)[k]));
  await db.run(sql, ...values, id);
}

export function recentActivity(workspaceId: number, limit = 20) {
  return db.all<{ kind: string; channel: string; detail: string; created_at: string }>(
    "SELECT * FROM activity WHERE workspace_id = ? ORDER BY id DESC LIMIT ?",
    workspaceId,
    limit
  );
}

// ---------- Claude keys we provide ----------

export interface ClaudeKey { id: number; name: string; key_enc: string; model: string; created_at: string; used_by?: number }

export async function listClaudeKeys(): Promise<ClaudeKey[]> {
  const rows = await db.all<ClaudeKey>(
    "SELECT k.*, (SELECT COUNT(*) FROM workspaces w WHERE w.shared_key_id = k.id) AS used_by FROM claude_keys k ORDER BY k.name"
  );
  return rows.map((r) => ({ ...r, used_by: Number(r.used_by ?? 0) }));
}

export function getClaudeKey(id: number) {
  return db.get<ClaudeKey>("SELECT * FROM claude_keys WHERE id = ?", id);
}

/** The key + model a workspace should use: ours if we provide one, else their own. */
export async function claudeCredsFor(ws: Workspace): Promise<{ apiKey: string | null; model: string | null; shared: boolean }> {
  if (ws.shared_key_id) {
    const k = await getClaudeKey(ws.shared_key_id);
    if (k) return { apiKey: decrypt(k.key_enc), model: k.model || null, shared: true };
  }
  return { apiKey: decrypt(ws.anthropic_key_enc), model: ws.claude_model, shared: false };
}

/** Give a customer one of our keys (or take it back with null). */
export async function assignSharedKey(userId: number, keyId: number | null) {
  const ws = await getWorkspaceForUser(userId);
  if ((ws.shared_key_id ?? null) === keyId) return;
  await db.run(
    "UPDATE workspaces SET shared_key_id = ?, claude_ok = ? WHERE id = ?",
    keyId,
    keyId ? 1 : ws.anthropic_key_enc ? 1 : 0,
    ws.id
  );
}

// ---------- Payments ----------

export interface Payment {
  id: number; user_id: number; amount: string; paid_on: string; method: string; reference: string; note: string;
  screenshot: string | null; screenshot_type: string | null; extended_to: string | null; recorded_by: string; created_at: string;
}

export function listPayments(userId: number) {
  return db.all<Omit<Payment, "screenshot"> & { has_shot: number }>(
    `SELECT id, user_id, amount, paid_on, method, reference, note, screenshot_type, extended_to, recorded_by, created_at,
       CASE WHEN screenshot IS NULL THEN 0 ELSE 1 END AS has_shot
     FROM payments WHERE user_id = ? ORDER BY paid_on DESC, id DESC`,
    userId
  );
}

export function getPayment(id: number) {
  return db.get<Payment>("SELECT * FROM payments WHERE id = ?", id);
}
