// Webhook events are saved first and processed after, so a slow AI reply, a crash or a sleeping server never
// loses a customer message. The edge worker (or the app itself) inserts rows; the app drains them.
//  - Duplicates (providers retry) drop on UNIQUE(source, dedupe_key).
//  - Events with the same group_key (one customer) run one batch at a time, oldest first; different customers run in parallel.
//  - Claims carry a lease, so a crashed worker's events are retried; failures back off and stop after 5 tries.
import { db } from "./db.js";
import { backoff, LEASE_MS } from "./jobs.js";

export interface InboxRow {
  id: number; workspace_id: number; source: string; dedupe_key: string; group_key: string;
  body: string; status: string; attempts: number; lease_until: number | null; next_at: number; created_at: number;
}
/** Gets every claimed event of one group (same workspace + group_key), oldest first. Throw = retry the batch. */
type Handler = (rows: InboxRow[]) => Promise<void>;

const handlers = new Map<string, Handler>();
const MAX_TRIES = 5;

export function onInbox(source: string, fn: Handler) {
  handlers.set(source, fn);
}

/** Saves one event. Returns false if it was already saved (a provider retry). */
export async function saveEvent(workspaceId: number, source: string, dedupeKey: string, groupKey: string, body: string): Promise<boolean> {
  const now = Date.now();
  const r = await db.run(
    "INSERT OR IGNORE INTO inbox (workspace_id, source, dedupe_key, group_key, body, next_at, created_at) VALUES (?,?,?,?,?,?,?)",
    workspaceId, source, dedupeKey.slice(0, 200), groupKey.slice(0, 200), body, now, now
  );
  return r.changes === 1;
}

/** Cheap check for the edge timer: anything waiting longer than `olderThanMs`? */
export async function hasStaleEvents(olderThanMs = 30_000, now = Date.now()) {
  return !!(await db.get(
    "SELECT 1 FROM inbox WHERE status IN ('new','working') AND next_at <= ? AND (status='new' OR lease_until < ?) AND created_at <= ? LIMIT 1",
    now, now, now - olderThanMs
  ));
}

/**
 * Claims the oldest ready event of each group that has nothing in flight, then the rest of that group's
 * waiting events, so several quick messages from one customer are answered together.
 */
async function claim(limit: number): Promise<InboxRow[][]> {
  const now = Date.now(), lease = now + LEASE_MS;
  const heads = await db.all<InboxRow>(
    `UPDATE inbox SET status='working', lease_until=?, attempts=attempts+1
     WHERE id IN (
       SELECT i.id FROM inbox i
       WHERE i.status IN ('new','working') AND i.next_at <= ? AND (i.status='new' OR i.lease_until < ?)
         AND (i.group_key = '' OR NOT EXISTS (
           SELECT 1 FROM inbox j WHERE j.workspace_id=i.workspace_id AND j.group_key=i.group_key AND j.id < i.id
             AND j.status IN ('new','working')))
         AND (i.group_key = '' OR NOT EXISTS (
           SELECT 1 FROM inbox k WHERE k.workspace_id=i.workspace_id AND k.group_key=i.group_key AND k.id <> i.id
             AND k.status='working' AND k.lease_until >= ?))
       ORDER BY i.id LIMIT ?)
     RETURNING *`,
    lease, now, now, now, limit
  );
  const groups: InboxRow[][] = [];
  for (const h of heads) {
    if (!h.group_key) { groups.push([h]); continue; }
    const rest = await db.all<InboxRow>(
      `UPDATE inbox SET status='working', lease_until=?, attempts=attempts+1
       WHERE workspace_id=? AND group_key=? AND status='new' AND id > ? AND next_at <= ?
       RETURNING *`,
      lease, h.workspace_id, h.group_key, h.id, now
    );
    groups.push([h, ...rest.sort((a, b) => a.id - b.id)]);
  }
  return groups;
}

let running: Promise<number> | null = null;
/** Processes everything waiting. Safe to call often; concurrent calls in one process share one run. */
export function drainInbox(): Promise<number> {
  if (running) return running;
  running = (async () => {
    let total = 0;
    for (let round = 0; round < 50; round++) {
      const groups = await claim(20);
      if (!groups.length) break;
      total += groups.reduce((n, g) => n + g.length, 0);
      await Promise.all(groups.map(runGroup));
    }
    return total;
  })().finally(() => (running = null));
  return running;
}

async function runGroup(rows: InboxRow[]) {
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => "?").join(",");
  const fn = handlers.get(rows[0]!.source);
  try {
    if (!fn) throw new Error(`No handler for ${rows[0]!.source}`);
    await fn(rows);
    await db.run(`UPDATE inbox SET status='done', lease_until=NULL, last_error=NULL WHERE id IN (${marks})`, ...ids);
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 300);
    const tries = Math.max(...rows.map((r) => r.attempts));
    if (tries >= MAX_TRIES) {
      await db.run(`UPDATE inbox SET status='failed', lease_until=NULL, last_error=? WHERE id IN (${marks})`, msg, ...ids);
      console.error(`[inbox ${rows[0]!.source}] gave up on ${ids.join(",")}: ${msg}`);
    } else {
      await db.run(`UPDATE inbox SET status='new', lease_until=NULL, next_at=?, last_error=? WHERE id IN (${marks})`, Date.now() + backoff(tries), msg, ...ids);
    }
  }
}

/** Runs a drain soon, at most one at a time (used right after the app saves an event itself). */
let kickTimer: NodeJS.Timeout | null = null;
export function kickDrain() {
  if (kickTimer) return;
  kickTimer = setTimeout(() => {
    kickTimer = null;
    drainInbox().catch((e) => console.error("inbox drain", e?.message));
  }, 25);
}
