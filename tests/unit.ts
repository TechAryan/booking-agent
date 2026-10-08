// Unit checks for the V2 foundation: inbox, jobs, transactions and the double-booking guard.
// Runs against a fresh local SQLite file (or the fake Turso when TEST_DB=turso is set by run.mjs).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (!process.env.TURSO_DATABASE_URL) process.env.DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "unit-")), "u.db");
process.env.APP_SECRET ||= "unit-secret";
process.env.WEBHOOK_BASE_URL = "https://edge.example.dev";

const { db, initDb } = await import("../src/db.js");
const { saveEvent, onInbox, drainInbox } = await import("../src/inbox.js");
const { enqueue, onJob, runDueJobs, cancelJob, hasDueJobs } = await import("../src/jobs.js");
const { guardedWrite } = await import("../src/bookings.js");

let pass = 0, fail = 0;
const ok = (c: unknown, name: string, extra = "") => { c ? pass++ : fail++; console.log(`${c ? "✅" : "❌"} ${name}${!c && extra ? " — " + extra : ""}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

await initDb();
const ws = 1;

// ---------- inbox ----------
const seen: string[][] = [];
let failOnce = true;
onInbox("t:msg", async (rows) => { seen.push(rows.map((r) => r.body)); });
onInbox("t:flaky", async () => { if (failOnce) { failOnce = false; throw new Error("boom"); } });

ok(await saveEvent(ws, "t:msg", "m1", "cust:A", "a1"), "inbox saves a new event");
ok(!(await saveEvent(ws, "t:msg", "m1", "cust:A", "a1")), "duplicate delivery is dropped");
await saveEvent(ws, "t:msg", "m2", "cust:A", "a2");
await saveEvent(ws, "t:msg", "m3", "cust:B", "b1");
await drainInbox();
const a = seen.find((g) => g.includes("a1"));
ok(a && a.join() === "a1,a2", "one customer's messages arrive together, in order", JSON.stringify(seen));
ok(seen.some((g) => g.join() === "b1"), "another customer is processed separately");
const left = await db.get<{ c: number }>("SELECT COUNT(*) AS c FROM inbox WHERE status <> 'done'");
ok(Number(left?.c) === 0, "all events marked done");

await saveEvent(ws, "t:flaky", "f1", "", "x");
await drainInbox();
const f = await db.get<any>("SELECT * FROM inbox WHERE dedupe_key='f1'");
ok(f.status === "new" && f.next_at > Date.now() && /boom/.test(f.last_error), "a failure is retried later with a wait", JSON.stringify(f));
await db.run("UPDATE inbox SET next_at=0 WHERE dedupe_key='f1'");
await drainInbox();
ok((await db.get<any>("SELECT status FROM inbox WHERE dedupe_key='f1'")).status === "done", "the retry succeeds");

// A crashed worker: row stuck in 'working' with an expired lease is picked up again.
await saveEvent(ws, "t:msg", "m9", "cust:C", "c1");
await db.run("UPDATE inbox SET status='working', lease_until=? WHERE dedupe_key='m9'", Date.now() - 1);
seen.length = 0;
await drainInbox();
ok(seen.some((g) => g.includes("c1")), "an event whose worker died is retried after its lease");

// Order holds even when a later message arrives while an earlier one is in flight.
await saveEvent(ws, "t:msg", "m10", "cust:D", "d1");
await db.run("UPDATE inbox SET status='working', lease_until=? WHERE dedupe_key='m10'", Date.now() + 60_000);
await saveEvent(ws, "t:msg", "m11", "cust:D", "d2");
seen.length = 0;
await drainInbox();
ok(!seen.some((g) => g.includes("d2")), "a customer's next message waits while their previous one is in flight");

// ---------- jobs ----------
const ran: string[] = [];
let polls = 0;
onJob("t:once", async (j) => { ran.push(j.ref); });
onJob("t:poll", async () => (++polls < 3 ? { again: 1 } : undefined));
onJob("t:bad", async () => { throw new Error("nope"); });

await enqueue(ws, "t:once", "r1", Date.now() + 60_000);
ok(!(await hasDueJobs()), "a future job isn't due yet");
await enqueue(ws, "t:once", "r1", Date.now() - 1);
ok(Number((await db.get<any>("SELECT COUNT(*) AS c FROM jobs WHERE kind='t:once'")).c) === 1, "scheduling the same job twice keeps one row");
ok(await hasDueJobs(), "now it's due");
await runDueJobs();
ok(ran.join() === "r1", "the job ran once");
await runDueJobs();
ok(ran.join() === "r1", "and doesn't run again");

await enqueue(ws, "t:once", "r2", Date.now() - 1);
await cancelJob("t:once", "r2");
await runDueJobs();
ok(!ran.includes("r2"), "a cancelled job doesn't run");

await enqueue(ws, "t:poll", "p1", Date.now() - 1);
for (let i = 0; i < 5; i++) { await runDueJobs(); await sleep(5); }
ok(polls === 3 && (await db.get<any>("SELECT status FROM jobs WHERE ref='p1'")).status === "done", "a polling job repeats until it's finished", String(polls));

await enqueue(ws, "t:bad", "b1", Date.now() - 1);
await runDueJobs();
const jb = await db.get<any>("SELECT * FROM jobs WHERE ref='b1'");
ok(jb.status === "pending" && jb.due_at > Date.now() && jb.attempts === 1, "a failing job backs off", JSON.stringify(jb));
await db.run("UPDATE jobs SET attempts=5, due_at=0 WHERE ref='b1'");
await runDueJobs();
ok((await db.get<any>("SELECT status FROM jobs WHERE ref='b1'")).status === "failed", "and stops after 5 tries");

// ---------- transactions + double-booking guard ----------
await db.exec("INSERT OR IGNORE INTO users (id, email, password_hash) VALUES (1, 'u@x.com', 'x'); INSERT OR IGNORE INTO workspaces (id, user_id, public_id) VALUES (1, 1, 'ws_unit');");
try {
  await db.tx(async (q) => {
    await q.run("INSERT INTO bookings (workspace_id, ref, owner, channel, customer_name, start_at, end_at) VALUES (1,'TX-1','o','t','n','2030-01-01T10:00','2030-01-01T10:30')");
    throw new Error("abort");
  });
} catch {}
ok(!(await db.get("SELECT 1 FROM bookings WHERE ref='TX-1'")), "a failed transaction leaves nothing behind");

const insert = (n: number) => guardedWrite(1, "2030-01-02T11:00", "2030-01-02T11:30", null, (q) =>
  q.run("INSERT INTO bookings (workspace_id, ref, owner, channel, customer_name, start_at, end_at, status) VALUES (1,?,'o','t','n','2030-01-02T11:00','2030-01-02T11:30','confirmed')", `RACE-${n}`));
const results = await Promise.all(Array.from({ length: 50 }, (_, i) => insert(i)));
ok(results.filter(Boolean).length === 1, "50 people racing for one slot: exactly one gets it", String(results.filter(Boolean).length));
const overlap = await guardedWrite(1, "2030-01-02T11:15", "2030-01-02T11:45", null, async () => "wrote");
ok(overlap === null, "an overlapping time is refused");
const after = await guardedWrite(1, "2030-01-02T11:30", "2030-01-02T12:00", null, async () => "wrote");
ok(after === "wrote", "the next slot right after is fine");

// ---------- photos: shrink + 6-month clean-up ----------
{
  const sharp = (await import("sharp")).default;
  const { saveProofImage, purgeOldPhotos } = await import("../src/proofs.js");
  const noise = (await import("node:crypto")).randomBytes(900 * 900 * 3);
  const big = await sharp(noise, { raw: { width: 900, height: 900, channels: 3 } }).png().toBuffer();
  const id = await saveProofImage({ id: 1 } as any, "wa:1", big, "image/png");
  const row = await db.get<any>("SELECT mime, bytes, length(image) AS len FROM payment_proofs WHERE id=?", id);
  ok(big.length > 200 * 1024 && row.mime === "image/jpeg" && row.bytes < big.length, "big screenshots are shrunk to JPEG before saving", `${big.length} → ${row.bytes} ${row.mime}`);
  const small = await saveProofImage({ id: 1 } as any, "wa:1", Buffer.from("tiny"), "image/png");
  ok((await db.get<any>("SELECT mime FROM payment_proofs WHERE id=?", small)).mime === "image/png", "small photos are kept as they are");
  await db.run("UPDATE payment_proofs SET utr='123412341234', created_at=datetime('now','-200 days') WHERE id=?", id);
  ok((await purgeOldPhotos()) >= 1, "old screenshots are cleaned up");
  const after = await db.get<any>("SELECT image, purged, utr FROM payment_proofs WHERE id=?", id);
  ok(after.image === "" && after.purged === 1 && after.utr === "123412341234", "the photo goes, the payment details stay (duplicate UTR checks still work)");
  ok((await db.get<any>("SELECT purged FROM payment_proofs WHERE id=?", small)).purged === 0, "recent photos are kept");
}

// ---------- Razorpay webhook address drift ----------
{
  const { razorpayHookMoved, razorpayHookUrl } = await import("../src/payments.js");
  const base: any = { public_id: "ws_x", razorpay_key_id: "rzp_test_1", razorpay_secret_enc: "e", rzp_hook_url: null, rzp_hook_via: null };
  ok(razorpayHookUrl(base) === "https://edge.example.dev/webhooks/razorpay/ws_x", "webhook address uses the edge worker");
  ok(!razorpayHookMoved(base), "nothing known yet → no warning");
  ok(razorpayHookMoved({ ...base, rzp_hook_via: "app" }), "events still arriving on the old direct address → warning");
  ok(!razorpayHookMoved({ ...base, rzp_hook_via: "edge" }), "events via the edge → fine");
  ok(razorpayHookMoved({ ...base, rzp_hook_url: "https://old.example/webhooks/razorpay/ws_x" }), "address we showed changed → warning");
  ok(!razorpayHookMoved({ ...base, razorpay_key_id: "", rzp_hook_via: "app" }), "Razorpay not connected → no warning");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
