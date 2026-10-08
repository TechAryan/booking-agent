// Edge worker (Cloudflare Workers, free plan): always awake, so no webhook is ever lost while the app sleeps.
//  - Webhooks: check the provider's signature, save the raw event to the `inbox` table, answer 200 at once,
//    then wake the app to process it. Same URL paths as the app, so switching is only a URL change.
//  - Timer (every minute): wake the app only when a job is due or an event has waited too long.
//  - If the database can't be reached, the request is passed straight to the app (old behaviour).
import { createClient, type Client } from "@libsql/client/web";
import { decryptSecret, hmacHex, internalSig, safeEqual, sha256Hex } from "../../shared/webcrypto.js";

export interface Env {
  TURSO_URL: string;
  TURSO_TOKEN?: string;
  APP_SECRET: string;
  APP_URL: string; // e.g. https://booking-agent-1-jv73.onrender.com
}
interface Ctx { waitUntil(p: Promise<unknown>): void }

let client: Client | null = null;
let clientUrl = "";
function dbFor(env: Env) {
  if (!client || clientUrl !== env.TURSO_URL) {
    client = createClient({ url: env.TURSO_URL.replace(/^libsql:/, "https:"), authToken: env.TURSO_TOKEN || undefined });
    clientUrl = env.TURSO_URL;
  }
  return client;
}

// Per-business webhook secrets, cached for a minute per worker instance (saves a database read per message).
type Secrets = { id: number; kapso: string | null; razorpay: string | null };
const cache = new Map<string, { at: number; v: Secrets | null }>();
async function secretsFor(env: Env, publicId: string): Promise<Secrets | null> {
  const hit = cache.get(publicId);
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  const rs = await dbFor(env).execute({ sql: "SELECT id, kapso_webhook_secret_enc, razorpay_webhook_secret_enc FROM workspaces WHERE public_id = ?", args: [publicId] });
  const row = rs.rows[0] as any;
  const v = row ? { id: Number(row.id), kapso: await decryptSecret(env.APP_SECRET, row.kapso_webhook_secret_enc), razorpay: await decryptSecret(env.APP_SECRET, row.razorpay_webhook_secret_enc) } : null;
  if (cache.size > 2000) cache.clear();
  cache.set(publicId, { at: Date.now(), v });
  return v;
}

async function save(env: Env, wsId: number, source: string, dedupe: string, headers: Record<string, string>, body: string) {
  const now = Date.now();
  await dbFor(env).execute({
    sql: "INSERT OR IGNORE INTO inbox (workspace_id, source, dedupe_key, group_key, body, next_at, created_at) VALUES (?,?,?,?,?,?,?)",
    args: [wsId, source, dedupe.slice(0, 200), "", JSON.stringify({ headers, body }), now, now],
  });
}

/** Signed wake-up call to the app. Returns the HTTP status (0 if unreachable). */
export async function wake(env: Env, path: "/internal/drain" | "/internal/tick") {
  const ts = Date.now();
  try {
    const r = await fetch(env.APP_URL.replace(/\/+$/, "") + path, {
      method: "POST",
      headers: { "X-Internal-Ts": String(ts), "X-Internal-Sig": await internalSig(env.APP_SECRET, ts, path) },
    });
    return r.status;
  } catch {
    return 0; // a sleeping app may take a minute; the timer retries
  }
}

/** Passes the original request to the app unchanged (used when our database is unreachable). */
function forward(env: Env, req: Request, raw: ArrayBuffer) {
  const url = new URL(req.url);
  return fetch(env.APP_URL.replace(/\/+$/, "") + url.pathname + url.search, { method: req.method, headers: req.headers, body: raw });
}

async function handle(req: Request, env: Env, ctx: Ctx): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/healthz") return new Response("ok");
  const m = url.pathname.match(/^\/webhooks\/(kapso|razorpay)\/([A-Za-z0-9_-]{4,64})$/);
  if (req.method !== "POST" || !m) return new Response("Not found", { status: 404 });
  const [, provider, publicId] = m;
  const raw = await req.arrayBuffer();
  if (raw.byteLength > 2 * 1024 * 1024) return new Response("Too large", { status: 413 });
  const body = new Uint8Array(raw);
  try {
    const s = await secretsFor(env, publicId!);
    if (!s) return new Response("Not found", { status: 404 });
    if (provider === "kapso") {
      const sig = (req.headers.get("X-Webhook-Signature") || "").replace(/^sha256=/, "");
      if (!s.kapso || !sig || !safeEqual(await hmacHex(s.kapso, body), sig)) return new Response("Unauthorized", { status: 401 });
      await save(env, s.id, "wh:kapso", await sha256Hex(body), { event: req.headers.get("X-Webhook-Event") || "" }, new TextDecoder().decode(body));
    } else {
      const sig = req.headers.get("X-Razorpay-Signature") || "";
      if (!s.razorpay || !sig || !safeEqual(await hmacHex(s.razorpay, body), sig)) return new Response("Unauthorized", { status: 401 });
      const eventId = req.headers.get("X-Razorpay-Event-Id") || (await sha256Hex(body));
      await save(env, s.id, "wh:razorpay", eventId, {}, new TextDecoder().decode(body));
    }
  } catch (e) {
    console.error("edge: database problem, passing to the app", (e as Error)?.message);
    return forward(env, req, raw);
  }
  ctx.waitUntil(wake(env, "/internal/drain"));
  return new Response("ok");
}

/** Minute timer: one indexed query each for due jobs and stuck events; wake the app only if needed. */
export async function scheduled(env: Env): Promise<"woke" | "idle"> {
  const now = Date.now();
  const rs = await dbFor(env).execute({
    sql: `SELECT
            EXISTS(SELECT 1 FROM jobs WHERE status IN ('pending','working') AND due_at <= ? AND (status='pending' OR lease_until < ?)) AS jobs,
            EXISTS(SELECT 1 FROM inbox WHERE status IN ('new','working') AND next_at <= ? AND (status='new' OR lease_until < ?) AND created_at <= ?) AS inbox`,
    args: [now, now, now, now, now - 30_000],
  });
  const r = rs.rows[0] as any;
  if (Number(r?.jobs) || Number(r?.inbox)) {
    await wake(env, "/internal/tick");
    return "woke";
  }
  return "idle";
}

export default {
  fetch: (req: Request, env: Env, ctx: Ctx) => handle(req, env, ctx),
  scheduled: (_ev: unknown, env: Env, ctx: Ctx) => ctx.waitUntil(scheduled(env)),
};
