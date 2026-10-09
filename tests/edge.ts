// Edge worker checks, run in-process against the fake Turso + the running app (TEST_DB=turso only,
// because the worker talks to the database over Turso's HTTP API like it does in production).
import fs from "node:fs";
import crypto from "node:crypto";
import { createClient } from "@libsql/client/web";
import worker, { scheduled, wake, type Env } from "../edge/src/index.js";
import { decryptSecret } from "../shared/webcrypto.js";

let pass = 0, fail = 0;
const ok = (c: unknown, name: string, extra = "") => { c ? pass++ : fail++; console.log(`${c ? "✅" : "❌"} ${name}${!c && extra ? " — " + extra : ""}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const env: Env = { TURSO_URL: "http://localhost:4200", TURSO_TOKEN: "test-token", APP_SECRET: "test-secret", APP_URL: "http://localhost:3300" };
const db = createClient({ url: env.TURSO_URL, authToken: env.TURSO_TOKEN });
const log = () => fs.readFileSync(process.env.FAKE_LOG!, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

const w = (await db.execute("SELECT public_id, kapso_webhook_secret_enc FROM workspaces WHERE whatsapp_enabled=1 AND kapso_webhook_secret_enc IS NOT NULL LIMIT 1")).rows[0] as any;
const secret = (await decryptSecret(env.APP_SECRET, w.kapso_webhook_secret_enc))!;
// Same secret format as the Node app (src/security.ts)
process.env.APP_SECRET = env.APP_SECRET;
const { decrypt } = await import("../src/security.js");
ok(secret && secret === decrypt(w.kapso_webhook_secret_enc), "edge decrypts secrets exactly like the app");

const tasks: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void tasks.push(p) };
const send = (body: string, sig: string, e: Env = env, pub = w.public_id) =>
  worker.fetch(new Request(`https://edge.example/webhooks/kapso/${pub}`, { method: "POST", headers: { "X-Webhook-Signature": sig, "X-Webhook-Event": "whatsapp.message.received", "Content-Type": "application/json" }, body }), e, ctx);
const msg = (id: string, from: string, text: string) => JSON.stringify({ message: { id, type: "text", from, text: { body: text }, kapso: { direction: "inbound" } }, conversation: { phone_number: `+${from}` }, phone_number_id: "111222333" });
const sign = (b: string) => crypto.createHmac("sha256", secret).update(b).digest("hex");

const body = msg("wamid.edge1", "919711111111", "hello from the edge");
let r = await send(body, sign(body));
ok(r.status === 200, "edge accepts a signed webhook", String(r.status));
const rows = Number((await db.execute("SELECT COUNT(*) AS c FROM inbox WHERE source='wh:kapso' AND body LIKE '%wamid.edge1%'")).rows[0]!.c);
ok(rows === 1, "and saves it to the inbox");
await Promise.all(tasks.splice(0));
let replied = false;
for (let i = 0; i < 30 && !replied; i++) { await sleep(200); replied = log().some((l: any) => l.body?.to === "919711111111"); }
ok(replied, "the woken app replied to the customer");

r = await send(body, sign(body));
await Promise.all(tasks.splice(0));
ok(r.status === 200 && Number((await db.execute("SELECT COUNT(*) AS c FROM inbox WHERE source='wh:kapso' AND body LIKE '%wamid.edge1%'")).rows[0]!.c) === 1, "a repeated delivery is stored once");
await sleep(800);
ok(log().filter((l: any) => l.body?.to === "919711111111").length === 1, "and answered once");

r = await send(body, "0".repeat(64));
ok(r.status === 401, "bad signature is refused");
r = await send(body, sign(body), env, "ws_doesnotexist");
ok(r.status === 404, "unknown business is refused");
r = await worker.fetch(new Request("https://edge.example/anything", { method: "GET" }), env, ctx);
ok(r.status === 404, "other paths are not served");

ok((await wake(env, "/internal/tick")) === 200, "app accepts the edge's signed wake-up");
const forged = await fetch("http://localhost:3300/internal/tick", { method: "POST", headers: { "X-Internal-Ts": String(Date.now()), "X-Internal-Sig": "0".repeat(64) } });
ok(forged.status === 401, "a forged wake-up is refused");

await db.execute({ sql: "INSERT OR REPLACE INTO jobs (workspace_id, kind, ref, due_at, created_at) VALUES (1, 'payment_check', 'BK-NOSUCH', ?, ?)", args: [Date.now() - 1000, Date.now()] });
ok((await scheduled(env)) === "woke", "timer wakes the app when a job is due");
let done = false;
for (let i = 0; i < 30 && !done; i++) { await sleep(200); done = (await db.execute("SELECT status FROM jobs WHERE ref='BK-NOSUCH'")).rows[0]?.status === "done"; }
ok(done, "and the job runs");


// Business websites
const siteRow = (await db.execute("SELECT s.slug, p.id AS photo FROM sites s LEFT JOIN site_photos p ON p.workspace_id=s.workspace_id WHERE s.html IS NOT NULL LIMIT 1")).rows[0] as any;
if (siteRow) {
  r = await worker.fetch(new Request(`https://edge.example/p/${siteRow.slug}`), env, ctx);
  const pageText = await r.text();
  ok(r.status === 200 && pageText.includes("<!doctype html>") && (r.headers.get("content-security-policy") || "").includes("default-src 'none'"), "edge serves a published website from the database");
  r = await worker.fetch(new Request("https://edge.example/p/no-such-shop"), env, ctx);
  ok(r.status === 404, "edge: unknown website 404");
  if (siteRow.photo) {
    r = await worker.fetch(new Request(`https://edge.example/p/${siteRow.slug}/img/${siteRow.photo}`), env, ctx);
    ok(r.status === 200 && /^image\//.test(r.headers.get("content-type") || ""), "edge: photo served (from the app when there's no R2 binding)");
  }
  r = await worker.fetch(new Request(`https://edge.example/p/${siteRow.slug}`), { ...env, TURSO_URL: "http://localhost:1" }, ctx);
  ok(r.status === 200, "edge: website still served by the app when the database is down");
} else ok(false, "a published website exists for the edge checks");

// Database unreachable: the edge passes the request straight to the app.
const body2 = msg("wamid.edge2", "919722222222", "fallback please");
r = await send(body2, sign(body2), { ...env, TURSO_URL: "http://localhost:1" });
ok(r.status === 200, "with the database down, the request is passed to the app", String(r.status));
replied = false;
for (let i = 0; i < 30 && !replied; i++) { await sleep(200); replied = log().some((l: any) => l.body?.to === "919722222222"); }
ok(replied, "and the customer still gets a reply");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
