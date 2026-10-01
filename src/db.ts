import fs from "node:fs";
import path from "node:path";
import { env } from "./env.js";

/*
 * Storage: one small async interface, two backends.
 *  - TURSO_DATABASE_URL set  → Turso (hosted SQLite, over HTTPS). Used on Render/Railway so data survives restarts.
 *  - otherwise              → local SQLite file at DATABASE_PATH (Node's built-in sqlite, nothing to compile).
 * Same SQL for both. Moving hosts = keep the same TURSO_* values.
 */

type Arg = string | number | null | bigint;
type Args = Arg[] | [Record<string, Arg>];

interface Backend {
  get(sql: string, args: Args): Promise<Record<string, any> | undefined>;
  all(sql: string, args: Args): Promise<Record<string, any>[]>;
  run(sql: string, args: Args): Promise<{ changes: number; lastId: number }>;
  exec(sql: string): Promise<void>;
  kind: string;
}

function norm(args: Args): any {
  return args.length === 1 && args[0] !== null && typeof args[0] === "object" ? args[0] : args;
}

async function localBackend(): Promise<Backend> {
  const { DatabaseSync } = await import("node:sqlite");
  fs.mkdirSync(path.dirname(path.resolve(env.databasePath)), { recursive: true });
  const d = new DatabaseSync(env.databasePath);
  d.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const call = (sql: string, args: Args, fn: "get" | "all" | "run") => {
    const st = d.prepare(sql) as any;
    const a = norm(args);
    return Array.isArray(a) ? st[fn](...a) : st[fn](a);
  };
  return {
    kind: `sqlite file ${env.databasePath}`,
    get: async (sql, args) => {
      const r = call(sql, args, "get");
      return r ? { ...r } : undefined;
    },
    all: async (sql, args) => (call(sql, args, "all") as any[]).map((r) => ({ ...r })),
    run: async (sql, args) => {
      const r = call(sql, args, "run");
      return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
    },
    exec: async (sql) => void d.exec(sql),
  };
}

async function tursoBackend(): Promise<Backend> {
  const { createClient } = await import("@libsql/client/web");
  const client = createClient({ url: env.tursoUrl.replace(/^libsql:/, "https:"), authToken: env.tursoToken || undefined });
  const toObj = (rs: any, row: any) => Object.fromEntries(rs.columns.map((c: string, i: number) => [c, row[i]]));
  const exec1 = (sql: string, args: Args) => client.execute({ sql, args: norm(args) });
  return {
    kind: `turso ${new URL(env.tursoUrl.replace(/^libsql:/, "https:")).host}`,
    get: async (sql, args) => {
      const rs = await exec1(sql, args);
      return rs.rows.length ? toObj(rs, rs.rows[0]) : undefined;
    },
    all: async (sql, args) => {
      const rs = await exec1(sql, args);
      return rs.rows.map((r: any) => toObj(rs, r));
    },
    run: async (sql, args) => {
      const rs = await exec1(sql, args);
      return { changes: rs.rowsAffected, lastId: Number(rs.lastInsertRowid ?? 0) };
    },
    exec: async (sql) => {
      await client.executeMultiple(sql);
    },
  };
}

let backend: Backend | null = null;
function b(): Backend {
  if (!backend) throw new Error("Database not ready yet");
  return backend;
}

export const db = {
  get: <T = any>(sql: string, ...args: Args) => b().get(sql, args) as Promise<T | undefined>,
  all: <T = any>(sql: string, ...args: Args) => b().all(sql, args) as Promise<T[]>,
  run: (sql: string, ...args: Args) => b().run(sql, args),
  exec: (sql: string) => b().exec(sql),
  kind: () => b().kind,
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  valid_until TEXT,                         -- YYYY-MM-DD, inclusive; NULL = no expiry
  must_change_password INTEGER NOT NULL DEFAULT 1,
  perm_widget INTEGER NOT NULL DEFAULT 1,
  perm_whatsapp INTEGER NOT NULL DEFAULT 1,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

-- One workspace (= one business) per user.
CREATE TABLE IF NOT EXISTS workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  public_id TEXT NOT NULL UNIQUE,           -- used in widget + webhook URLs

  business_name TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  open_hour INTEGER NOT NULL DEFAULT 10,
  close_hour INTEGER NOT NULL DEFAULT 19,
  working_days TEXT NOT NULL DEFAULT '1,2,3,4,5,6',
  slot_minutes INTEGER NOT NULL DEFAULT 30,
  services TEXT NOT NULL DEFAULT '',
  extra_info TEXT NOT NULL DEFAULT '',      -- address, FAQs, what the bot must not do
  business_done INTEGER NOT NULL DEFAULT 0,

  anthropic_key_enc TEXT,
  claude_model TEXT,
  claude_ok INTEGER NOT NULL DEFAULT 0,

  google_sa_enc TEXT,
  google_sa_email TEXT,
  google_calendar_id TEXT,
  google_ok INTEGER NOT NULL DEFAULT 0,

  tested INTEGER NOT NULL DEFAULT 0,

  widget_enabled INTEGER NOT NULL DEFAULT 0,
  widget_color TEXT NOT NULL DEFAULT '#16a34a',
  widget_greeting TEXT NOT NULL DEFAULT '',

  kapso_key_enc TEXT,
  kapso_phone_number_id TEXT,
  kapso_display_number TEXT,
  kapso_webhook_id TEXT,
  kapso_webhook_secret_enc TEXT,
  whatsapp_enabled INTEGER NOT NULL DEFAULT 0,

  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversations (
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,                    -- whatsapp | widget | test
  external_id TEXT NOT NULL,                -- phone number or widget session id
  history TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workspace_id, channel, external_id)
);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                       -- booking | cancel | message | error
  channel TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS activity_ws ON activity(workspace_id, id DESC);

-- Claude keys we (the admins) own and can hand to customers. Customers never see these.
CREATE TABLE IF NOT EXISTS claude_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  key_enc TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Payments customers made to us (recorded by hand by an admin).
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount TEXT NOT NULL DEFAULT '',
  paid_on TEXT NOT NULL,                    -- YYYY-MM-DD
  method TEXT NOT NULL DEFAULT '',
  reference TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  screenshot TEXT,                          -- base64 image, small (compressed in the browser)
  screenshot_type TEXT,
  extended_to TEXT,                         -- validity was extended to this date
  recorded_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS payments_user ON payments(user_id, paid_on DESC);

-- What the business offers. price 0 (or empty) = free.
CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  price REAL NOT NULL DEFAULT 0,             -- rupees
  mode TEXT NOT NULL DEFAULT 'offline' CHECK (mode IN ('online','offline','both')),
  duration_minutes INTEGER,                  -- NULL = the business's slot length
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS services_ws ON services(workspace_id, sort);

-- Days the business is closed.
CREATE TABLE IF NOT EXISTS holidays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  date TEXT NOT NULL,                        -- YYYY-MM-DD
  end_date TEXT,                             -- inclusive, NULL = one day
  label TEXT NOT NULL DEFAULT 'Holiday',
  source TEXT NOT NULL DEFAULT 'manual',
  UNIQUE (workspace_id, date, label)
);

-- Extra knowledge about the business: uploaded files, website import, notes.
CREATE TABLE IF NOT EXISTS knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                        -- file | website | note
  title TEXT NOT NULL DEFAULT '',
  source_url TEXT,
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS knowledge_ws ON knowledge(workspace_id, id);

-- Discounts the owner sets (e.g. over WhatsApp): for everyone, one service, or one customer, for a time window.
CREATE TABLE IF NOT EXISTS offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  percent REAL NOT NULL,
  service_id INTEGER,                        -- NULL = all services
  customer_phone TEXT,                       -- digits; NULL = everyone
  starts_on TEXT,                            -- YYYY-MM-DD, NULL = now
  ends_on TEXT,                              -- YYYY-MM-DD inclusive, NULL = no end
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Every booking we make, including ones waiting for payment.
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ref TEXT NOT NULL UNIQUE,                  -- short code shown to customers, e.g. BK-7Q2X
  owner TEXT NOT NULL,                       -- wa:<phone> or <channel>:<session>
  channel TEXT NOT NULL,
  customer_name TEXT NOT NULL DEFAULT '',
  customer_phone TEXT NOT NULL DEFAULT '',
  customer_email TEXT NOT NULL DEFAULT '',
  service_id INTEGER,
  service_name TEXT NOT NULL DEFAULT '',
  start_at TEXT NOT NULL,                    -- ISO with offset
  end_at TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'offline',      -- online | offline
  list_price REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,            -- what the customer pays
  pay_method TEXT NOT NULL DEFAULT 'free',   -- free | online | venue | upi
  pay_status TEXT NOT NULL DEFAULT 'none',   -- none | awaiting | paid | expired | failed | refund_due | pending_manual
  status TEXT NOT NULL DEFAULT 'confirmed',  -- held | confirmed | cancelled | paid_unbooked
  hold_expires_at INTEGER,                   -- ms; only while status = held
  payment_link_id TEXT,
  pay_url TEXT,
  payment_id TEXT,
  event_id TEXT,
  meet_link TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS bookings_ws ON bookings(workspace_id, start_at);
CREATE INDEX IF NOT EXISTS bookings_owner ON bookings(workspace_id, owner);

CREATE TABLE IF NOT EXISTS seen_messages (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
`;

/** Connects and creates tables. Call once before serving requests. */
export async function initDb() {
  backend = env.tursoUrl ? await tursoBackend() : await localBackend();
  await db.exec(SCHEMA);
  await migrate();
  const cleanup = async () => {
    await db.run("DELETE FROM sessions WHERE expires_at < ?", Date.now());
    await db.run("DELETE FROM seen_messages WHERE created_at < ?", Date.now() - 3 * 86400_000);
    await db.run("DELETE FROM conversations WHERE updated_at < datetime('now','-30 days')");
  };
  setInterval(() => cleanup().catch((e) => console.error("cleanup failed", e)), 3600_000).unref();
}

// Columns added after launch. ADD COLUMN fails if it already exists, which is fine.
const MIGRATIONS: [string, string, string][] = [
  ["users", "payment_status", "TEXT NOT NULL DEFAULT 'pending'"], // paid | pending | trial
  ["users", "phone", "TEXT NOT NULL DEFAULT ''"],
  ["workspaces", "shared_key_id", "INTEGER"],                    // a claude_keys row we provide, instead of their own key
  // Business profile
  ["workspaces", "business_type", "TEXT NOT NULL DEFAULT ''"],
  ["workspaces", "contact_email", "TEXT NOT NULL DEFAULT ''"],
  ["workspaces", "contact_phone", "TEXT NOT NULL DEFAULT ''"],
  ["workspaces", "address", "TEXT NOT NULL DEFAULT ''"],
  ["workspaces", "maps_url", "TEXT NOT NULL DEFAULT ''"],
  ["workspaces", "website", "TEXT NOT NULL DEFAULT ''"],
  ["workspaces", "socials", "TEXT NOT NULL DEFAULT '{}'"],        // JSON {instagram, facebook, youtube, ...}
  ["workspaces", "meeting_link", "TEXT NOT NULL DEFAULT ''"],     // fixed link for online sessions if no Google Meet
  ["workspaces", "services_migrated", "INTEGER NOT NULL DEFAULT 0"],
  // Payments
  ["workspaces", "online_discount_pct", "REAL NOT NULL DEFAULT 0"],
  ["workspaces", "pay_at_venue", "INTEGER NOT NULL DEFAULT 1"],   // customers may pay offline
  ["workspaces", "razorpay_key_id", "TEXT NOT NULL DEFAULT ''"],
  ["workspaces", "razorpay_secret_enc", "TEXT"],
  ["workspaces", "razorpay_webhook_secret_enc", "TEXT"],
  ["workspaces", "upi_id", "TEXT NOT NULL DEFAULT ''"],
  ["workspaces", "upi_name", "TEXT NOT NULL DEFAULT ''"],
  // Owner control over WhatsApp
  ["workspaces", "owner_phones", "TEXT NOT NULL DEFAULT ''"],     // comma separated digits
  // Google sign-in (OAuth) instead of a service-account key
  ["workspaces", "google_refresh_enc", "TEXT"],
  ["workspaces", "google_account_email", "TEXT NOT NULL DEFAULT ''"],
];
async function migrate() {
  for (const [table, col, def] of MIGRATIONS) {
    const cols = await db.all(`PRAGMA table_info(${table})`);
    if (cols.some((c) => c.name === col)) continue;
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  }
}

// ---------- Types ----------

export interface User {
  id: number;
  email: string;
  name: string;
  password_hash: string;
  role: "user" | "admin";
  status: "active" | "inactive";
  valid_until: string | null;
  must_change_password: number;
  perm_widget: number;
  perm_whatsapp: number;
  notes: string;
  created_at: string;
  last_login_at: string | null;
  payment_status: "paid" | "pending" | "trial";
  phone: string;
}

export interface Workspace {
  id: number;
  user_id: number;
  public_id: string;
  business_name: string;
  timezone: string;
  open_hour: number;
  close_hour: number;
  working_days: string;
  slot_minutes: number;
  services: string;
  extra_info: string;
  business_done: number;
  anthropic_key_enc: string | null;
  claude_model: string | null;
  claude_ok: number;
  google_sa_enc: string | null;
  google_sa_email: string | null;
  google_calendar_id: string | null;
  google_ok: number;
  tested: number;
  widget_enabled: number;
  widget_color: string;
  widget_greeting: string;
  kapso_key_enc: string | null;
  kapso_phone_number_id: string | null;
  kapso_display_number: string | null;
  kapso_webhook_id: string | null;
  kapso_webhook_secret_enc: string | null;
  whatsapp_enabled: number;
  shared_key_id: number | null;
  business_type: string;
  contact_email: string;
  contact_phone: string;
  address: string;
  maps_url: string;
  website: string;
  socials: string;
  meeting_link: string;
  services_migrated: number;
  online_discount_pct: number;
  pay_at_venue: number;
  razorpay_key_id: string;
  razorpay_secret_enc: string | null;
  razorpay_webhook_secret_enc: string | null;
  upi_id: string;
  upi_name: string;
  owner_phones: string;
  google_refresh_enc: string | null;
  google_account_email: string;
  updated_at: string;
}

export async function logActivity(workspaceId: number, kind: string, channel: string, detail: string) {
  await db.run("INSERT INTO activity (workspace_id, kind, channel, detail) VALUES (?,?,?,?)", workspaceId, kind, channel, detail.slice(0, 500));
}
