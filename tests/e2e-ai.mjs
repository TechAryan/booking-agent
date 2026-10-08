// Phase 1 end-to-end: choosing an AI (Claude, Gemini, OpenAI, DeepSeek, Sarvam, OpenRouter), key checks, versions.
import crypto from "node:crypto";
import fs from "node:fs";
const BASE = "http://localhost:3300";
let pass = 0, fail = 0;
const ok = (cond, name, extra = "") => { cond ? pass++ : fail++; console.log(`${cond ? "✅" : "❌"} ${name}${!cond && extra ? " — " + String(extra).slice(0, 600) : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  jar = {};
  async req(path, { method = "GET", form, json, headers = {}, raw, multipart, follow = false } = {}) {
    const h = { ...headers, cookie: Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join("; ") };
    let body;
    if (form) { body = form instanceof URLSearchParams ? form.toString() : new URLSearchParams(form).toString(); h["content-type"] = "application/x-www-form-urlencoded"; }
    if (json) { body = JSON.stringify(json); h["content-type"] = "application/json"; }
    if (raw) body = raw;
    if (multipart) body = multipart;
    const r = await fetch(path.startsWith("http") ? path : BASE + path, { method, headers: h, body, redirect: "manual" });
    for (const c of r.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(";"); const [k, v] = kv.split("=");
      if (v === "" || /Expires=Thu, 01 Jan 1970/.test(c)) delete this.jar[k]; else this.jar[k] = v;
    }
    const text = await r.text();
    const out = { status: r.status, loc: r.headers.get("location") || "", text };
    if (follow && out.status >= 300 && out.status < 400 && out.loc) return this.req(out.loc, { follow: true });
    return out;
  }
  async page(path) { const r = await this.req(path); this.csrf = r.text.match(/name="_csrf" value="([^"]+)"/)?.[1] || r.text.match(/data-csrf="([^"]+)"/)?.[1] || this.csrf; return r; }
  post(path, form) {
    if (form instanceof URLSearchParams) { form.set("_csrf", this.csrf); return this.req(path, { method: "POST", form }); }
    return this.req(path, { method: "POST", form: { _csrf: this.csrf, ...form } });
  }
  async say(text, as = "customer") {
    const r = await this.req("/setup/test/message", { method: "POST", json: { text, as }, headers: { "x-csrf-token": this.csrf } });
    try { return JSON.parse(r.text).reply || JSON.parse(r.text).error || r.text; } catch { return r.text; }
  }
  async tool(name, input = {}, as = "customer") {
    const out = await this.say(`!tool ${name} ${JSON.stringify(input)}`, as);
    const m = out.match(/^RESULT \w+: ([\s\S]*)$/);
    if (!m) return { _raw: out };
    try { return JSON.parse(m[1]); } catch { return { _raw: m[1] }; }
  }
}
const payPath = (ref) => fakeLog().filter((l) => l.razorpay && l.method === "POST" && l.url === "/v1/payment_links" && l.body.reference_id === ref).at(-1)?.body.callback_url.replace("http://localhost:3300", "");
const dec = (s) => decodeURIComponent(String(s).replace(/\+/g, " "));
const fakeLog = () => fs.readFileSync(process.env.FAKE_LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const ist = (days) => { const d = new Date(Date.now() + 5.5 * 3600000); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };


// ---------- Phase 1: choose your AI ----------
const admin = new Client();
await admin.req("/login", { method: "POST", form: { email: "admin@test.com", password: "AdminPass123" } });
await admin.page("/admin/users/new");
let r = await admin.post("/admin/users/new", { name: "Neha Rao", email: "neha@spa.com", phone: "9822233344", role: "user", status: "active", valid_until: "2099-01-01", perm_widget: "1", payment_status: "paid" });
const temp = r.text.match(/id="pw"[^>]*>([^<]+)</)?.[1];
const cu = new Client();
await cu.req("/login", { method: "POST", form: { email: "neha@spa.com", password: temp } });
await cu.page("/account/password?first=1");
await cu.post("/account/password", { current: temp, password: "Spa2026!xyz", password2: "Spa2026!xyz" });
await cu.page("/setup/business");
const f = new URLSearchParams({ business_name: "Lotus Spa", open_hour: "0", close_hour: "23", slot_minutes: "30", timezone: "Asia/Kolkata", extra_info: "" });
["1", "2", "3", "4", "5", "6", "7"].forEach((d) => f.append("days", d));
for (const [n, k] of [["Cleaning", "free"], ["Massage", "free"]]) { f.append("svc_id", ""); f.append("svc_name", n); f.append("svc_kind", k); f.append("svc_price", ""); f.append("svc_mode", "offline"); f.append("svc_details", ""); f.append("svc_minutes", ""); }
r = await cu.post("/setup/business", f);
ok(r.loc.startsWith("/setup/claude"), "business saved → AI step", dec(r.loc));

r = await cu.page("/setup/claude");
ok(r.text.includes("Connect your AI") && r.text.includes("Claude is our recommended AI. We test every option below before offering it."), "AI page leads with Claude and the recommended wording");
ok(r.text.includes("Other AI options") && ["Gemini (Google)", "OpenAI (ChatGPT)", "DeepSeek", "Sarvam (Indian)", "OpenRouter"].every((n) => r.text.includes(n)), "other AIs listed under Other AI options");
ok(r.text.includes("Haiku 5.5") && r.text.includes("claude-haiku-5-5") && !r.text.includes("Haiku 4.5"), "Haiku label is 5.5");
ok(/value="claude-sonnet-5-5" checked/.test(r.text) && r.text.includes(">Recommended<") && r.text.includes(">Cheaper<") && r.text.includes(">Smartest<"), "versions with Recommended / Cheaper / Smartest; Sonnet preselected");
ok(r.text.includes("More versions") && r.text.includes("data-load-models"), "More versions picker offered");
ok(r.text.includes("Prices change; check"), "pricing warning shown");

// Claude first, as most businesses will
r = await cu.post("/setup/claude", { provider: "anthropic", api_key: "sk-ant-good-key-lotus", model: "claude-haiku-5-5" });
ok(r.loc.startsWith("/setup/google") && dec(r.loc).includes("Claude is connected"), "Claude connects with a practice booking", dec(r.loc));
const claudeCalls = fakeLog().filter((l) => l.claude && l.key === "sk-ant-good-key-lotus");
ok(claudeCalls.length >= 3 && claudeCalls.every((l) => l.model === "claude-haiku-5-5"), "practice booking ran on the chosen Claude version (check → book → reply)", claudeCalls.length);

// Google (fake sign-in) so the test chat works
r = await cu.req("/setup/google/start");
await cu.req(r.loc.replace("http://localhost:3300", ""));
r = await cu.page("/");
ok(r.text.includes("Lotus Spa"), "dashboard ready");

// ---------- Gemini ----------
r = await cu.page("/setup/claude?p=gemini");
ok(r.text.includes("Connect Gemini (Google)") && r.text.includes("aistudio.google.com") && r.text.includes("gemini-3.8-flash") && r.text.includes("free tier"), "Gemini guide, versions and free-tier warning");
ok(/<details class="ai-others" open>/.test(r.text) && r.text.includes('class="chip on" href="/setup/claude?p=gemini'), "Other AI options open with Gemini picked");
r = await cu.post("/setup/claude", { provider: "gemini", api_key: "AIza-bad-key-0000000", model: "gemini-3.8-flash" });
ok(dec(r.loc).includes("not valid") && dec(r.loc).includes("p=gemini"), "bad Gemini key rejected, stays on Gemini", dec(r.loc));
r = await cu.post("/setup/claude", { provider: "gemini", api_key: "AIza-good-key-123456789", model: "gemini-3.8-flash" });
ok(r.loc === "/" || dec(r.loc).includes("Gemini (Google) is connected"), "Gemini connects", dec(r.loc));
let gem = fakeLog().filter((l) => l.ai === "gemini");
ok(gem.some((l) => l.sigs.some((s) => s.startsWith("sig-"))), "Gemini thought signatures are sent back within the turn");
r = await cu.page("/setup/claude");
ok(r.text.includes("Gemini (Google) · Gemini 3.8 Flash") && r.text.includes("AIza-g…6789"), "current AI shown, key masked");
let out = await cu.say("hello");
ok(out === "Hello from Lotus Spa" && fakeLog().filter((l) => l.ai === "gemini").at(-1).key === "AIza-good-key-123456789", "customer chat runs on Gemini", out);
out = await cu.say("I want to book a cleaning");
ok(out.startsWith("RESULT book_appointment") && out.includes('"ok":true'), "a real booking goes through on Gemini (tool calls + results)", out);
out = await cu.say("hello again");
ok(out === "Hello from Lotus Spa", "next turn works with stored history from a tool turn", out);
gem = fakeLog().filter((l) => l.ai === "gemini").at(-1);
ok(gem.sigs.length >= 2, "older Gemini tool calls carry a signature (real or placeholder)", JSON.stringify(gem.sigs));

// ---------- OpenAI (Responses API) ----------
r = await cu.post("/setup/claude", { provider: "openai", api_key: "sk-proj-good-openai-key-1", model: "other", model_other: "gpt-nope" });
ok(dec(r.loc).includes("isn't available"), "unknown OpenAI version rejected with a clear message", dec(r.loc));
r = await cu.post("/setup/claude", { provider: "openai", api_key: "sk-proj-good-openai-key-1", model: "gpt-6-luna" });
ok(dec(r.loc).includes("OpenAI (ChatGPT) is connected"), "OpenAI connects", dec(r.loc));
let oa = fakeLog().filter((l) => l.ai === "openai");
ok(oa.every((l) => l.store === false && l.reasoning?.effort === "low"), "OpenAI calls are stateless with low reasoning");
ok(oa.some((l) => l.reasoningBack), "OpenAI reasoning items are sent back inside the turn");
out = await cu.say("book me in please");
ok(out.startsWith("RESULT book_appointment") && out.includes('"ok":true'), "booking works on OpenAI", out);
out = await cu.say("hi");
oa = fakeLog().filter((l) => l.ai === "openai").at(-1);
ok(out === "Hello from Lotus Spa" && oa.reasoningBack === false && oa.cacheKey === "ws" + oa.cacheKey.slice(2), "a new turn drops last turn's reasoning (no stale state)", JSON.stringify(oa));

// ---------- DeepSeek ----------
r = await cu.post("/setup/claude", { provider: "deepseek", api_key: "sk-broke-deepseek-key", model: "deepseek-flash" });
ok(dec(r.loc).includes("balance is empty"), "DeepSeek empty balance explained", dec(r.loc));
r = await cu.post("/setup/claude", { provider: "deepseek", api_key: "sk-good-deepseek-key-1", model: "deepseek-flash" });
ok(dec(r.loc).includes("DeepSeek is connected") && dec(r.loc).includes("Balance: 4.20 USD"), "DeepSeek connects and shows the balance", dec(r.loc));
ok(fakeLog().filter((l) => l.ai === "deepseek").every((l) => l.thinking?.type === "disabled"), "DeepSeek thinking switched off");
r = await cu.page("/setup/claude?p=deepseek");
ok(r.text.includes("China"), "DeepSeek data-location note shown");

// ---------- Sarvam ----------
r = await cu.post("/setup/claude", { provider: "sarvam", api_key: "sk_good_sarvam_key_1", model: "sarvam-105b" });
ok(dec(r.loc).includes("Sarvam (Indian) is connected"), "Sarvam connects", dec(r.loc));
ok(fakeLog().filter((l) => l.ai === "sarvam").every((l) => l.hasReasoningEffort && l.reasoning_effort === null), "Sarvam reasoning switched off");

// ---------- OpenRouter + More versions ----------
await cu.page("/setup/claude?p=openrouter");
r = await cu.req("/setup/ai/models", { method: "POST", form: { _csrf: cu.csrf, provider: "openrouter", api_key: "sk-or-v1-good-router-key" } });
let models = JSON.parse(r.text).models || [];
ok(models.some((m) => m.id === "meta/llama-9"), "More versions loads the live list for the pasted key", r.text.slice(0, 200));
r = await cu.req("/setup/ai/models", { method: "POST", form: { _csrf: cu.csrf, provider: "openai", api_key: "" } });
models = JSON.parse(r.text).models || [];
ok(models.some((m) => m.id === "gpt-6-mini") && !models.some((m) => /embedding|realtime/.test(m.id)), "saved OpenAI key lists chat versions only", r.text.slice(0, 200));
r = await cu.req("/setup/ai/models", { method: "POST", form: { _csrf: cu.csrf, provider: "gemini", api_key: "AIza-bad-key-0000000" } });
ok(r.status === 400 && JSON.parse(r.text).error.includes("not valid"), "bad key on the version list gives a clear error");
r = await cu.post("/setup/claude", { provider: "openrouter", api_key: "sk-or-v1-good-router-key", model: "other", model_other: "meta/llama-9" });
ok(dec(r.loc).includes("OpenRouter") && dec(r.loc).includes("Credit left on this key"), "OpenRouter connects with a version from More versions", dec(r.loc));
r = await cu.page("/setup/claude");
ok(/value="other" checked/.test(r.text) && r.text.includes('value="meta/llama-9"'), "custom version shown as selected");

// ---------- Website import on a non-Claude AI ----------
r = await cu.page("/setup/claude?p=gemini");
ok(r.text.includes("saved: <span class=\"mono\">AIza-g…6789") && !/name="api_key"[^>]*required/.test(r.text), "Gemini key remembered after switching away");
r = await cu.post("/setup/claude", { provider: "gemini", api_key: "", model: "gemini-3.5-flash-lite" });
ok(dec(r.loc).includes("Gemini (Google) is connected"), "switching back to Gemini needs no re-paste", dec(r.loc));
r = await cu.post("/setup/profile/import", { url: "http://localhost:4100/site" });
r = await cu.page("/setup/profile");
ok(r.text.includes("Bridal makeup"), "website import works on Gemini (forced tool, simplified schema)");
ok(fakeLog().filter((l) => l.ai === "gemini" && l.toolChoice === "required").length >= 1, "forced tool sent as required");

// ---------- Back to Claude ----------
r = await cu.post("/setup/claude", { provider: "anthropic", api_key: "", model: "claude-sonnet-5-5" });
ok(dec(r.loc).includes("Claude is connected"), "back to Claude with the saved key", dec(r.loc));
out = await cu.say("hello");
ok(out === "Hello from Lotus Spa" && fakeLog().filter((l) => l.claude).at(-1).key === "sk-ant-good-key-lotus", "chat runs on Claude again; history carried across AIs");
r = await cu.page("/setup/claude");
ok(/\d+ AI replies this month/.test(r.text), "usage this month shown");
r = await cu.page("/");
ok(r.text.includes("Connect your AI") && !r.text.includes("Connect Claude"), "dashboard step renamed");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
