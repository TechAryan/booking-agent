// npm test: starts fake Anthropic/Kapso/Google + the app on a temp DB, runs the end-to-end checks.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "booking-e2e-"));
const env = {
  ...process.env, FAKE_LOG: path.join(tmp, "fakes.jsonl"), NO_PROXY: "localhost",
  APP_SECRET: "test-secret", DATABASE_PATH: path.join(tmp, "app.db"), PORT: "3300", PUBLIC_URL: "http://localhost:3300",
  ADMIN_EMAIL: "admin@test.com", ADMIN_PASSWORD: "AdminPass123", ANTHROPIC_BASE_URL: "http://localhost:4100",
  KAPSO_API_BASE: "http://localhost:4100", FAKE_GOOGLE_CALENDAR: "1", NODE_ENV: "test",
  RAZORPAY_API_BASE: "http://localhost:4100", ALLOW_PRIVATE_FETCH: "1", PAYMENT_SWEEP_MS: "1500", TEST_CHAT_LIMIT: "2000",
};
// TEST_DB=turso runs the whole suite against a local stand-in for Turso's HTTP API.
const children = [];
if (process.env.TEST_DB === "turso") {
  Object.assign(env, { TURSO_DATABASE_URL: "http://localhost:4200", TURSO_AUTH_TOKEN: "test-token", FAKE_TURSO_DB: path.join(tmp, "turso.db") });
  children.push(spawn(process.execPath, ["tests/fake-turso.mjs"], { env, stdio: "ignore", detached: true }));
}
const fakes = spawn(process.execPath, ["tests/fakes.mjs"], { env, stdio: "ignore", detached: true });
const app = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "--disable-warning=ExperimentalWarning", "src/server.ts"], { env, stdio: "ignore", detached: true });
const stop = () => { for (const p of [fakes, app, ...children]) { try { process.kill(-p.pid, "SIGTERM"); } catch {} } };
process.on("SIGINT", () => { stop(); process.exit(130); });
for (let i = 0; i < 40; i++) {
  try { if ((await fetch("http://localhost:3300/healthz")).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 500));
}
// TEST_UI=1 runs the browser test (tests/ui.mjs) instead of the API test.
const files = process.env.TEST_UI ? ["tests/ui.mjs"] : ["tests/e2e.mjs", "tests/e2e-v7.mjs"];
let failed = 0;
for (const f of files) {
  const code = await new Promise((res) => spawn(process.execPath, [f], { env: { ...env, UI_BASE: "http://localhost:3300" }, stdio: "inherit" }).on("exit", res));
  if (code) failed++;
}
stop();
process.exit(failed ? 1 : 0);
