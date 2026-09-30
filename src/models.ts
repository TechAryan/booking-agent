import { DateTime } from "luxon";
import { db, User, Workspace } from "./db.js";
import { hashPassword, randomToken } from "./security.js";
import { env } from "./env.js";

// ---------- Users ----------

export function getUser(id: number): Promise<User | undefined> {
  return db.get<User>("SELECT * FROM users WHERE id = ?", id);
}

export function getUserByEmail(email: string): Promise<User | undefined> {
  return db.get<User>("SELECT * FROM users WHERE email = ? COLLATE NOCASE", email.trim());
}

export async function listUsers(): Promise<(User & { business_name: string | null; setup: string })[]> {
  const rows = await db.all(
    `SELECT u.*, w.business_name, w.business_done, w.claude_ok, w.google_ok, w.tested, w.widget_enabled, w.whatsapp_enabled
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
    await db.run("DELETE FROM activity WHERE workspace_id = ?", ws.id);
    await db.run("DELETE FROM conversations WHERE workspace_id = ?", ws.id);
    await db.run("DELETE FROM workspaces WHERE id = ?", ws.id);
  }
  await db.run("DELETE FROM sessions WHERE user_id = ?", userId);
  await db.run("DELETE FROM users WHERE id = ?", userId);
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
  "kapso_phone_number_id", "kapso_display_number", "kapso_webhook_id", "kapso_webhook_secret_enc", "whatsapp_enabled",
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
