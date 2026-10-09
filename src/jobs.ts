// Work that must happen later: payment-link checks, reminder calls, page republish …
// One row per (kind, ref), so scheduling the same thing twice just moves it. Workers claim rows with a lease,
// so two app servers never run the same job, and a crashed worker's jobs are picked up when the lease ends.
import { db } from "./db.js";

export interface Job {
  id: number; workspace_id: number; kind: string; ref: string; due_at: number;
  status: string; attempts: number; lease_until: number | null; last_error: string | null;
}
/** Return `{ again: ms }` to run the same job again later (polling), anything else = done. Throw = retry with backoff. */
type Handler = (job: Job) => Promise<void | { again: number }>;

const handlers = new Map<string, Handler>();
export const LEASE_MS = 60_000;
const MAX_TRIES = 5;

export function onJob(kind: string, fn: Handler) {
  handlers.set(kind, fn);
}

/** Schedules (or re-schedules) one job. Idempotent per (kind, ref). */
export async function enqueue(workspaceId: number, kind: string, ref: string, dueAt: number) {
  const now = Date.now();
  await db.run(
    `INSERT INTO jobs (workspace_id, kind, ref, due_at, created_at) VALUES (?,?,?,?,?)
     ON CONFLICT(kind, ref) DO UPDATE SET due_at=excluded.due_at, status='pending', attempts=0, lease_until=NULL, last_error=NULL`,
    workspaceId, kind, ref, Math.round(dueAt), now
  );
}

export async function cancelJob(kind: string, ref: string) {
  await db.run("UPDATE jobs SET status='cancelled', lease_until=NULL WHERE kind=? AND ref=? AND status IN ('pending','working')", kind, ref);
}

/** Cheap check used by the edge timer: is anything due? (one indexed lookup) */
export async function hasDueJobs(now = Date.now()) {
  return !!(await db.get("SELECT 1 FROM jobs WHERE status IN ('pending','working') AND due_at <= ? AND (status='pending' OR lease_until < ?) LIMIT 1", now, now));
}

async function claim(limit: number): Promise<Job[]> {
  const now = Date.now();
  return db.all<Job>(
    `UPDATE jobs SET status='working', lease_until=?, attempts=attempts+1
     WHERE id IN (SELECT id FROM jobs WHERE status IN ('pending','working') AND due_at <= ? AND (status='pending' OR lease_until < ?)
                  ORDER BY due_at LIMIT ?)
     RETURNING *`,
    now + LEASE_MS, now, now, limit
  );
}

/** Growing waits between retries: 30 s, 1 min, 2 min, 4 min … */
export const backoff = (attempts: number) => Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 30 * 60_000);

let running: Promise<number> | null = null;
/** Runs everything that is due. Safe to call often; concurrent calls in one process share the same run. */
export function runDueJobs(): Promise<number> {
  if (running) return running;
  running = (async () => {
    let total = 0;
    for (let round = 0; round < 20; round++) {
      const batch = await claim(25);
      if (!batch.length) break;
      total += batch.length;
      await Promise.all(batch.map(runOne));
    }
    return total;
  })().finally(() => (running = null));
  return running;
}

async function runOne(job: Job) {
  const fn = handlers.get(job.kind);
  try {
    if (!fn) throw new Error(`No handler for job kind ${job.kind}`);
    const r = await fn(job);
    if (r && typeof r === "object" && r.again > 0) {
      await db.run("UPDATE jobs SET status='pending', due_at=?, attempts=0, lease_until=NULL WHERE id=? AND status='working'", Date.now() + r.again, job.id);
    } else {
      await db.run("UPDATE jobs SET status='done', lease_until=NULL, last_error=NULL WHERE id=? AND status='working'", job.id);
    }
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 300);
    if (job.attempts >= MAX_TRIES) {
      await db.run("UPDATE jobs SET status='failed', lease_until=NULL, last_error=? WHERE id=?", msg, job.id);
      console.error(`[job ${job.kind} ${job.ref}] failed for good: ${msg}`);
    } else {
      await db.run("UPDATE jobs SET status='pending', due_at=?, lease_until=NULL, last_error=? WHERE id=? AND status='working'", Date.now() + backoff(job.attempts), msg, job.id);
    }
  }
}

/** The business's website shows something that changed (price, service, hours, contact): republish it in
 *  2 minutes, once, if it's published (several quick edits fold into one run). Handler: src/sites/index.ts. */
export function markSiteDirty(wsId: number) {
  return enqueue(wsId, "site_publish", `ws:${wsId}`, Date.now() + Number(process.env.SITE_REPUBLISH_MS ?? 120_000)).catch(() => undefined);
}

/** A booking was made, paid, moved or cancelled: let the calling agent (re)plan its calls, if calling is on. */
export function bookingChanged(ws: { id: number; voice_settings?: string | null }, bookingId: number) {
  if (!ws.voice_settings || !/"enabled"\s*:\s*true/.test(ws.voice_settings)) return Promise.resolve();
  return enqueue(ws.id, "voice_plan", `bk:${bookingId}`, Date.now() + 1000).catch(() => undefined);
}
