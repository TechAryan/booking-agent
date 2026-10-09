// Edge worker checks for calling-agent reports (runs after e2e-voice.mjs). TEST_DB=turso only.
import { createClient } from "@libsql/client/web";
import worker, { type Env } from "../edge/src/index.js";
import { decryptSecret } from "../shared/webcrypto.js";

let pass = 0, fail = 0;
const ok = (c: unknown, name: string, extra = "") => { c ? pass++ : fail++; console.log(`${c ? "✅" : "❌"} ${name}${!c && extra ? " — " + extra : ""}`); };
const env: Env = { TURSO_URL: "http://localhost:4200", TURSO_TOKEN: "test-token", APP_SECRET: "test-secret", APP_URL: "http://localhost:3300" };
const db = createClient({ url: env.TURSO_URL, authToken: env.TURSO_TOKEN });
const tasks: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void tasks.push(p) };
const w = (await db.execute("SELECT id, public_id, voice_secret_enc FROM workspaces WHERE voice_secret_enc IS NOT NULL LIMIT 1")).rows[0] as any;
if (w) {
  // e2e-voice disconnects at the end; connect Retell again for these checks.
  await db.execute({ sql: "UPDATE workspaces SET voice_provider='retell' WHERE id=?", args: [w.id] });
  const sec = (await decryptSecret(env.APP_SECRET, w.voice_secret_enc))!;
  const url = (p: string, s2 = sec) => `https://edge.example/webhooks/voice/${p}/${w.public_id}/${s2}`;
  let r = await worker.fetch(new Request(url("retell", "x".repeat(sec.length)), { method: "POST", body: "{}" }), env, ctx);
  ok(r.status === 404, "edge refuses a wrong secret");
  r = await worker.fetch(new Request(url("bolna"), { method: "POST", body: "{}" }), env, ctx);
  ok(r.status === 404, "edge refuses a provider that isn't connected");
  r = await worker.fetch(new Request(url("retell"), { method: "GET" }), env, ctx);
  ok(r.status === 404, "edge: GET isn't a report");
  const body = '{"event":"call_ended","call":{"call_id":"edge-c1"}}';
  r = await worker.fetch(new Request(url("retell"), { method: "POST", body, headers: { "x-retell-signature": "v=1,d=bad" } }), env, ctx);
  r = await worker.fetch(new Request(url("retell"), { method: "POST", body, headers: { "x-retell-signature": "v=2,d=good" } }), env, ctx);
  await Promise.all(tasks.splice(0));
  const rows = (await db.execute("SELECT body FROM inbox WHERE source='wh:voice' AND body LIKE '%edge-c1%'")).rows as any[];
  const saved = rows.map((x) => JSON.parse(x.body));
  ok(r.status === 200 && saved.length === 2 && saved.some((x) => x.headers["x-retell-signature"] === "v=2,d=good" && x.headers.provider === "retell" && x.headers.url === url("retell")), "edge saves each signed copy for the app to check", JSON.stringify(saved).slice(0, 300));
  await db.execute({ sql: "UPDATE workspaces SET voice_provider=NULL WHERE id=?", args: [w.id] });
} else ok(false, "a calling workspace exists for the edge checks");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
