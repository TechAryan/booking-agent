// Edge worker checks for the WhatsApp-provider route (runs after e2e-wa.mjs has set one up). TEST_DB=turso only.
import { createClient } from "@libsql/client/web";
import worker, { type Env } from "../edge/src/index.js";
import { decryptSecret } from "../shared/webcrypto.js";

let pass = 0, fail = 0;
const ok = (c: unknown, name: string, extra = "") => { c ? pass++ : fail++; console.log(`${c ? "✅" : "❌"} ${name}${!c && extra ? " — " + extra : ""}`); };
const env: Env = { TURSO_URL: "http://localhost:4200", TURSO_TOKEN: "test-token", APP_SECRET: "test-secret", APP_URL: "http://localhost:3300" };
const db = createClient({ url: env.TURSO_URL, authToken: env.TURSO_TOKEN });
const tasks: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void tasks.push(p) };
let r: Response;
// Other WhatsApp providers: /webhooks/wa/<provider>/<business>/<secret>
const wa = (await db.execute("SELECT id, public_id, wa_provider, wa_hook_secret_enc FROM workspaces WHERE wa_provider IS NOT NULL AND wa_provider <> 'kapso' AND wa_hook_secret_enc IS NOT NULL LIMIT 1")).rows[0] as any;
if (wa) {
  const sec = (await decryptSecret(env.APP_SECRET, wa.wa_hook_secret_enc))!;
  const waUrl = (p: string, s2 = sec) => `https://edge.example/webhooks/wa/${p}/${wa.public_id}/${s2}`;
  r = await worker.fetch(new Request(`${waUrl(wa.wa_provider)}?hub.mode=subscribe&hub.challenge=xyz&hub.verify_token=${sec}`), env, ctx);
  ok(r.status === 200 && (await r.text()) === "xyz", "edge answers Meta's address check");
  r = await worker.fetch(new Request(waUrl(wa.wa_provider, "x".repeat(sec.length)), { method: "POST", body: "{}" }), env, ctx);
  ok(r.status === 404, "edge refuses a wrong secret in the address");
  r = await worker.fetch(new Request(waUrl("gupshup"), { method: "POST", body: "{}" }), env, ctx);
  ok(wa.wa_provider === "gupshup" || r.status === 404, "edge refuses another provider's path");
  r = await worker.fetch(new Request(waUrl(wa.wa_provider), { method: "POST", body: '{"edge":"wa1"}', headers: { "X-Hub-Signature-256": "sha256=abc", "Content-Type": "application/json" } }), env, ctx);
  await Promise.all(tasks.splice(0));
  const row = (await db.execute("SELECT body FROM inbox WHERE source='wh:wa' AND body LIKE '%wa1%'")).rows[0] as any;
  const saved = row ? JSON.parse(row.body) : null;
  ok(r.status === 200 && saved?.headers?.provider === wa.wa_provider && saved.headers["x-hub-signature-256"] === "sha256=abc" && saved.headers.url === waUrl(wa.wa_provider), "edge saves the event with the signature header and address for the app to check");
  await db.execute({ sql: "UPDATE workspaces SET wa_provider='twilio' WHERE id=?", args: [wa.id] });
  r = await worker.fetch(new Request(waUrl("twilio"), { method: "POST", body: "MessageSid=SM1&Body=x", headers: { "Content-Type": "application/x-www-form-urlencoded" } }), env, ctx);
  ok(r.status === 200 && (await r.text()).includes("<Response/>"), "Twilio gets TwiML back from the edge (fresh secrets read after a provider switch)");
  await db.execute({ sql: "UPDATE workspaces SET wa_provider=? WHERE id=?", args: [wa.wa_provider, wa.id] });
  await Promise.all(tasks.splice(0));
} else ok(false, "a WhatsApp-provider workspace exists for the edge checks");


console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
