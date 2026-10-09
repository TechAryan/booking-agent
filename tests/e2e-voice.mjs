// Phase 4 end-to-end: calling agent (Bolna, Retell, ElevenLabs, Sarvam), consent, planner, live tools, reports, retries, limits.
import crypto from "node:crypto";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
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
const dec = (s) => decodeURIComponent(String(s).replace(/\+/g, " "));
const fakeLog = () => fs.readFileSync(process.env.FAKE_LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const vlog = (p, path) => fakeLog().filter((l) => l.voice === p && (!path || l.path === path || (path instanceof RegExp && path.test(l.path))));
const ist = (days) => { const d = new Date(Date.now() + 5.5 * 3600000); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const sq = new DatabaseSync(process.env.TEST_DB === "turso" ? process.env.FAKE_TURSO_DB : process.env.DATABASE_PATH);
sq.exec("PRAGMA busy_timeout=5000");
const q = (sql, ...a) => sq.prepare(sql).all(...a);
const q1 = (sql, ...a) => q(sql, ...a)[0];
async function until(fn, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(150); } return null; }
const post = (path, body, headers = {}) => fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const tool = async (path, body, headers) => { const r = await post(path, body, headers); let j = null; try { j = await r.json(); } catch {} return { status: r.status, j }; };

// ---------- users ----------
const admin = new Client();
await admin.req("/login", { method: "POST", form: { email: "admin@test.com", password: "AdminPass123" } });
async function newUser(email, calling) {
  await admin.page("/admin/users/new");
  const r = await admin.post("/admin/users/new", { name: "Asha Rao", email, phone: "9822211133", role: "user", status: "active", valid_until: "2099-01-01", perm_widget: "1", perm_whatsapp: "1", ...(calling ? { perm_calling: "1" } : {}), payment_status: "paid" });
  const temp = r.text.match(/id="pw"[^>]*>([^<]+)</)?.[1];
  const c = new Client();
  await c.req("/login", { method: "POST", form: { email, password: temp } });
  await c.page("/account/password?first=1");
  await c.post("/account/password", { current: temp, password: "Call2026!ok", password2: "Call2026!ok" });
  return c;
}
const nope = await newUser("nocall@spa.com", false);
let r = await nope.req("/setup/calling");
ok(r.status === 302 && dec(r.loc).includes("isn't included in your plan"), "calling page closed without the calling permission");
ok(!(await nope.page("/")).text.includes("Calling agent"), "dashboard hides calling without permission");

const cu = await newUser("asha@spa.com", true);
r = await cu.page("/");
ok(r.text.includes("Calling agent"), "dashboard shows the calling step");
r = await cu.page("/setup/calling");
ok(r.status === 200 && r.text.includes("Before you start") && r.text.includes("TRAI") && r.text.includes("Bolna <span class=\"tag rec\">Recommended</span>"), "calling page: before-you-start box, Bolna recommended");
ok(["ElevenLabs", "Retell AI", "Sarvam"].every((n) => r.text.includes(n)), "other calling providers listed");
r = await cu.post("/setup/calling/p/bolna", { api_key: "bolna-good", number: "+91 80 1234 5678" });
ok(dec(r.loc).includes("Finish your business details"), "needs business + calendar first", dec(r.loc));

await cu.page("/setup/business");
const f = new URLSearchParams({ business_name: "Asha Spa", open_hour: "0", close_hour: "23", slot_minutes: "30", timezone: "Asia/Kolkata", extra_info: "", address: "12 MG Road, Pune" });
["1", "2", "3", "4", "5", "6", "7"].forEach((d) => f.append("days", d));
for (const [n, k, p] of [["Cleaning", "free", ""], ["Facial", "paid", "500"]]) {
  f.append("svc_id", ""); f.append("svc_name", n); f.append("svc_kind", k); f.append("svc_price", p); f.append("svc_mode", "offline"); f.append("svc_details", ""); f.append("svc_minutes", "");
}
await cu.post("/setup/business", f);
await cu.page("/setup/claude");
await cu.post("/setup/claude", { provider: "anthropic", api_key: "sk-ant-good-key-asha", model: "claude-sonnet-5-5" });
r = await cu.req("/setup/google/start");
await cu.req(r.loc.replace("http://localhost:3300", ""));
const pub = (await cu.page("/setup/widget")).text.match(/ws_[A-Za-z0-9_-]{10,}/)?.[0];
const wsId = q1("SELECT id FROM workspaces WHERE public_id=?", pub)?.id;

// ---------- consent isn't asked before calling is connected ----------
ok(!(await cu.say("!system")).includes("okay if we call you"), "no call-consent question while calling is off");

// ---------- connect Bolna ----------
await cu.page("/setup/calling");
r = await cu.post("/setup/calling/p/bolna", { api_key: "bolna-bad", number: "+91 80 1234 5678" });
ok(dec(r.loc).includes("Bolna rejected these details"), "bad Bolna key refused", dec(r.loc));
r = await cu.post("/setup/calling/p/bolna", { api_key: "bolna-good", number: "+91 80 9999 0000" });
ok(dec(r.loc).includes("Bolna has no number"), "number not on the Bolna account is refused", dec(r.loc));
r = await cu.post("/setup/calling/p/bolna", { api_key: "bolna-good", number: "abc" });
ok(dec(r.loc).includes("Enter the number you bought in Bolna"), "number format checked", dec(r.loc));
r = await cu.post("/setup/calling/p/bolna", { api_key: "bolna-good", number: "+91 80 1234 5678" });
ok(dec(r.loc).includes("Bolna is connected and your agent is ready"), "Bolna connected", dec(r.loc));
const created = vlog("bolna", "/v2/agent").at(-1)?.body;
const cfg = created?.agent_config?.tasks?.[0]?.tools_config;
ok(cfg?.llm_agent?.llm_config?.provider === "azure-openai" && cfg?.synthesizer?.provider === "sarvam" && cfg?.transcriber?.provider === "sarvam" && cfg?.input?.provider === "plivo", "agent uses India routing (Azure OpenAI, Sarvam voice and ears, Plivo)", JSON.stringify(cfg).slice(0, 300));
ok(created?.agent_config?.calling_guardrails?.call_start_hour === 9 && created?.agent_config?.calling_guardrails?.call_end_hour === 21, "TRAI calling hours set on the agent");
const toolUrl = Object.values(cfg?.api_tools?.tools_params ?? {})[0]?.url;
const secret = toolUrl?.match(/\/voice\/tool\/bolna\/ws_[\w-]+\/([A-Za-z0-9]+)\//)?.[1];
ok(!!secret && created.agent_config.webhook_url.endsWith(`/webhooks/voice/bolna/${pub}/${secret}`), "tools and call reports point at our secret addresses", toolUrl);
const names = cfg.api_tools.tools.map((t) => t.name);
ok(names.includes("confirm_attendance") && names.includes("stop_calls") && !names.includes("book_appointment"), "outgoing-only agent has no booking tool", names.join(","));
ok(/"call_key":"%\(call_key\)s"/.test(cfg.api_tools.tools_params.confirm_attendance.param), "tools pass the call key back");
const prompt = created?.agent_prompts?.task_1?.system_prompt ?? "";
ok(prompt.includes("Asha Spa") && prompt.includes("{customer_name}") && prompt.includes("Facial: ₹500") && prompt.includes("Never ask for card, UPI PIN, OTP"), "prompt has business facts, call variables and safety rules", prompt.slice(0, 400));
ok(!vlog("bolna", "/inbound/setup").length, "incoming calls not linked until switched on");
r = await cu.page("/setup/calling");
ok(r.text.includes("Calling is on through Bolna") && r.text.includes("Test call to my phone") && r.text.includes("What the agent does"), "connected page shows switches and test call");

// ---------- settings ----------
r = await cu.post("/setup/calling/settings", { enabled: "1", confirm: "1", remind: "3h", can_reschedule: "1", can_cancel: "1", inbound: "1", start: "9", end: "10", language: "hinglish", voice: "female", daily_cap: "50" });
ok(dec(r.loc).includes("at least 2 hours"), "calling window must be at least 2 hours");
r = await cu.post("/setup/calling/settings", { enabled: "1", confirm: "1", remind: "3h", can_reschedule: "1", can_cancel: "1", inbound: "1", start: "10", end: "20", language: "en", voice: "male", daily_cap: "50" });
ok(dec(r.loc).includes("Your agent is updated"), "settings saved", dec(r.loc));
const upd = vlog("bolna", /^\/v2\/agent\/bolna-agent-1$/).at(-1)?.body;
ok(upd?.agent_config?.calling_guardrails?.call_start_hour === 10 && upd.agent_config.tasks[0].tools_config.api_tools.tools.some((t) => t.name === "book_appointment") && upd.agent_config.tasks[0].tools_config.synthesizer.provider_config.voice_id === "rahul", "agent updated: hours, incoming booking tool, male voice");
ok(vlog("bolna", "/inbound/setup").at(-1)?.body?.phone_number_id === "pn-1", "incoming calls linked to the number");
await cu.post("/setup/calling/settings", { enabled: "1", confirm: "1", remind: "3h", can_reschedule: "1", can_cancel: "1", inbound: "1", start: "9", end: "21", language: "hinglish", voice: "female", daily_cap: "50" });

// ---------- consent when booking ----------
ok((await cu.say("!system")).includes("okay if we call you"), "assistant asks for call consent once calling is on");
const day = ist(2);
let b1 = await cu.tool("book_appointment", { start: `${day}T15:00`, service: "Cleaning", customer_name: "Ravi", customer_phone: "+91 90000 11111", ok_to_call: true });
ok(b1.ok && b1.status === "confirmed", "booking with call consent", JSON.stringify(b1));
const bk1 = q1("SELECT * FROM bookings WHERE ref=?", b1.ref);
ok(bk1?.call_consent === 1, "consent saved on the booking");
let b0 = await cu.tool("book_appointment", { start: `${day}T16:00`, service: "Cleaning", customer_name: "Sita", customer_phone: "+91 90000 22222" });
const bk0 = q1("SELECT * FROM bookings WHERE ref=?", b0.ref);
ok(bk0?.call_consent === 0, "no consent unless the customer said yes");

// ---------- planner: confirmation call goes out, reminder is scheduled ----------
const placed = await until(() => vlog("bolna", "/call").find((l) => l.body.user_data?.booking_ref === b1.ref));
ok(placed && placed.body.recipient_phone_number === "+919000011111" && placed.body.from_phone_number === "+918012345678" && placed.body.user_data.purpose === "confirm", "confirmation call placed through Bolna", JSON.stringify(placed?.body));
const remind = q1("SELECT * FROM jobs WHERE kind='voice_call' AND ref=?", `remind:${bk1.id}`);
ok(remind && remind.status === "pending" && Math.abs(remind.due_at - (Date.parse(bk1.start_at) - 3 * 3600_000)) < 60_000, "reminder call scheduled 3 hours before", JSON.stringify(remind));
await sleep(1500);
ok(!vlog("bolna", "/call").some((l) => l.body.user_data?.booking_ref === b0.ref) && !q1("SELECT 1 AS x FROM jobs WHERE kind='voice_call' AND ref LIKE ? AND status='pending'", `%:${bk0.id}`), "no calls for a booking without consent");
const call1 = q1("SELECT * FROM calls WHERE booking_id=?", bk1.id);
ok(call1?.status === "ringing" && call1.provider_call_id && call1.call_key === placed.body.user_data.call_key, "call recorded with our call key", JSON.stringify(call1));

// ---------- live tool calls ----------
const T = (name) => `/voice/tool/bolna/${pub}/${secret}/${name}`;
let t = await tool(`/voice/tool/bolna/${pub}/wrongsecretwrongsecret12/booking_details`, { call_key: call1.call_key });
ok(t.status === 404, "tool address with a wrong secret is refused");
t = await tool(T("booking_details"), { call_key: call1.call_key, execution_id: call1.provider_call_id });
ok(t.j?.booking?.ref === b1.ref && t.j.booking.service === "Cleaning", "booking_details finds the call's booking", JSON.stringify(t.j));
t = await tool(T("booking_details"), { call_key: "%(call_key)s", execution_id: call1.provider_call_id });
ok(t.j?.booking?.ref === b1.ref, "unfilled call key: the caller is looked up from Bolna's call record", JSON.stringify(t.j));
t = await tool(T("booking_details"), { call_key: "%(call_key)s", execution_id: "%(execution_id)s" });
ok(/can't see the caller/.test(t.j?.error ?? ""), "no way to tell the caller: personal tools refuse", JSON.stringify(t.j));
t = await tool(T("business_info"), {});
ok(t.j?.name === "Asha Spa" && t.j.services.some((s) => s.name === "Facial" && s.price === 500), "business_info works for anyone");
t = await tool(T("cancel_booking"), { call_key: call1.call_key, ref: b0.ref });
ok(t.j?.error && q1("SELECT status FROM bookings WHERE id=?", bk0.id).status === "confirmed", "can't touch someone else's booking", JSON.stringify(t.j));
t = await tool(T("confirm_attendance"), { call_key: call1.call_key });
ok(t.j?.ok && q1("SELECT outcome FROM calls WHERE id=?", call1.id).outcome === "confirmed", "confirm_attendance marks the call outcome", JSON.stringify(t.j));
t = await tool(T("book_appointment"), { call_key: call1.call_key, service: "Cleaning", start: `${day}T18:00`, customer_name: "Ravi" });
ok(/only taken on incoming calls/.test(t.j?.error ?? ""), "no new bookings on outgoing calls");

// ---------- post-call report ----------
const rep = (id, status, extra = {}) => ({ id, status, summary: status === "completed" ? "Customer said they will come." : undefined, transcript: "assistant: Namaste\nuser: haan", telephony_data: { duration: "42", call_type: "outbound", to_number: "+919000011111", from_number: "+918012345678" }, ...extra });
r = await fetch(`${BASE}/webhooks/voice/bolna/${pub}/nottherightsecret12345`, { method: "POST", body: JSON.stringify(rep(call1.provider_call_id, "completed")) });
ok(r.status === 404, "report address with a wrong secret is refused");
r = await fetch(`${BASE}/webhooks/voice/bolna/${pub}/${secret}`, { method: "POST", body: JSON.stringify(rep(call1.provider_call_id, "in-progress")) });
ok(r.status === 200, "report accepted");
await until(() => q1("SELECT status FROM calls WHERE id=?", call1.id).status === "in_progress");
await fetch(`${BASE}/webhooks/voice/bolna/${pub}/${secret}`, { method: "POST", body: JSON.stringify(rep(call1.provider_call_id, "completed")) });
const done1 = await until(() => { const c = q1("SELECT * FROM calls WHERE id=?", call1.id); return c.status === "completed" ? c : null; });
ok(done1 && done1.seconds === 42 && done1.summary.includes("will come") && done1.transcript.includes("haan"), "completed report saved: length, summary, transcript", JSON.stringify(done1));
ok(await until(() => q1("SELECT 1 AS x FROM activity WHERE workspace_id=? AND detail LIKE ?", wsId, "%Confirmation call to +919000011111: confirmed they'll come%")), "activity shows the call outcome");
r = await cu.page("/calls");
ok(r.text.includes("Confirmation") && r.text.includes("Ravi") && r.text.includes("Done") && r.text.includes("1 min"), "calls page lists the call");

// ---------- reschedule and cancel on a call; switches ----------
let b2 = await cu.tool("book_appointment", { start: `${day}T11:00`, service: "Facial", customer_name: "Meera", customer_phone: "+91 90000 33333", payment: "venue", ok_to_call: true });
const bk2 = q1("SELECT * FROM bookings WHERE ref=?", b2.ref);
const c2 = await until(() => q1("SELECT * FROM calls WHERE booking_id=?", bk2.id));
ok(!!c2, "second confirmation call placed");
t = await tool(T("reschedule_booking"), { call_key: c2.call_key, new_start: `${day}T12:00` });
ok(t.j?.ok && q1("SELECT start_at FROM bookings WHERE id=?", bk2.id).start_at.includes("T12:00") && q1("SELECT outcome FROM calls WHERE id=?", c2.id).outcome === "rescheduled", "reschedule_booking moves the booking", JSON.stringify(t.j));
await cu.post("/setup/calling/settings", { enabled: "1", confirm: "1", remind: "3h", can_reschedule: "1", inbound: "1", start: "9", end: "21", language: "hinglish", voice: "female", daily_cap: "50" });
t = await tool(T("cancel_booking"), { call_key: c2.call_key });
ok(/switched off/.test(t.j?.error ?? "") && q1("SELECT status FROM bookings WHERE id=?", bk2.id).status === "confirmed", "cancel switch off: agent can't cancel");
await cu.post("/setup/calling/settings", { enabled: "1", confirm: "1", remind: "3h", can_reschedule: "1", can_cancel: "1", inbound: "1", start: "9", end: "21", language: "hinglish", voice: "female", daily_cap: "50" });
sq.prepare("UPDATE bookings SET pay_status='paid' WHERE id=?").run(bk2.id);
t = await tool(T("cancel_booking"), { call_key: c2.call_key });
ok(t.j?.ok === false && /paid/.test(t.j.message) && q1("SELECT status FROM bookings WHERE id=?", bk2.id).status === "confirmed", "paid booking can't be cancelled on a call", JSON.stringify(t.j));
sq.prepare("UPDATE bookings SET pay_status=? WHERE id=?").run(bk2.pay_status, bk2.id);
t = await tool(T("cancel_booking"), { call_key: c2.call_key, reason: "travelling" });
ok(t.j?.ok && q1("SELECT status FROM bookings WHERE id=?", bk2.id).status === "cancelled" && q1("SELECT outcome FROM calls WHERE id=?", c2.id).outcome === "cancelled", "unpaid booking cancelled on a call", JSON.stringify(t.j));
ok(await until(() => !q1("SELECT 1 AS x FROM jobs WHERE kind='voice_call' AND ref=? AND status='pending'", `remind:${bk2.id}`)), "cancelled booking: reminder call dropped");

// ---------- incoming call ----------
t = await tool(T("booking_details"), { call_key: "%(call_key)s", execution_id: "in-9000011111" });
ok(t.j?.bookings?.some((x) => x.ref === b1.ref), "incoming call: caller's own bookings found from Bolna's record", JSON.stringify(t.j));
t = await tool(T("book_appointment"), { execution_id: "in-9000044444", service: "Cleaning", start: `${day}T17:00`, customer_name: "Kabir" });
const bk4 = q1("SELECT * FROM bookings WHERE customer_phone='919000044444'");
ok(t.j?.ok && bk4?.status === "confirmed" && bk4.call_consent === 1, "incoming call books a free service for the caller", JSON.stringify(t.j));
t = await tool(T("book_appointment"), { execution_id: "in-9000044444", service: "Facial", start: `${day}T19:00`, customer_name: "Kabir" });
ok(t.j?.ok && q1("SELECT COUNT(*) AS c FROM bookings WHERE customer_phone='919000044444'").c === 2, "pay-at-venue service bookable on a call", JSON.stringify(t.j));
await fetch(`${BASE}/webhooks/voice/bolna/${pub}/${secret}`, { method: "POST", body: JSON.stringify({ id: "in-9000044444", status: "completed", summary: "Booked a cleaning.", telephony_data: { duration: 70, call_type: "inbound", from_number: "+919000044444", to_number: "+918012345678" } }) });
ok(await until(() => q1("SELECT * FROM calls WHERE provider_call_id='in-9000044444' AND direction='in' AND status='completed'")), "incoming call report creates a call row");

// ---------- not reached: one retry, then the owner is told ----------
let b5 = await cu.tool("book_appointment", { start: `${day}T13:00`, service: "Cleaning", customer_name: "Nisha", customer_phone: "+91 90000 55555", ok_to_call: true });
const bk5 = q1("SELECT * FROM bookings WHERE ref=?", b5.ref);
const c5 = await until(() => q1("SELECT * FROM calls WHERE booking_id=? AND attempt=1 AND provider_call_id IS NOT NULL", bk5.id));
await fetch(`${BASE}/webhooks/voice/bolna/${pub}/${secret}`, { method: "POST", body: JSON.stringify(rep(c5.provider_call_id, "no-answer", { telephony_data: { call_type: "outbound", to_number: "+919000055555" } })) });
const c5b = await until(() => q1("SELECT * FROM calls WHERE booking_id=? AND attempt=2 AND provider_call_id IS NOT NULL", bk5.id));
ok(q1("SELECT status FROM calls WHERE id=?", c5.id).status === "no_answer" && !!c5b, "no answer: called again once", JSON.stringify(c5b));
await fetch(`${BASE}/webhooks/voice/bolna/${pub}/${secret}`, { method: "POST", body: JSON.stringify(rep(c5b.provider_call_id, "busy", { telephony_data: { call_type: "outbound", to_number: "+919000055555" } })) });
ok(await until(() => q1("SELECT 1 AS x FROM activity WHERE workspace_id=? AND detail LIKE ?", wsId, `%Couldn't reach Nisha%${b5.ref}%busy%`)), "second miss: owner told, no third call");
await sleep(1200);
ok(q("SELECT * FROM calls WHERE booking_id=?", bk5.id).length === 2, "only two attempts");
ok(vlog("bolna", "/call").filter((l) => l.body.recipient_phone_number === "+919000055555").length === 2, "two calls placed in total");

// ---------- stop calls (do-not-call) ----------
t = await tool(T("stop_calls"), { call_key: c5b.call_key });
ok(t.j?.ok && q1("SELECT 1 AS x FROM do_not_call WHERE workspace_id=? AND customer_key='919000055555'", wsId), "stop_calls saves do-not-call");
const n0 = vlog("bolna", "/call").length;
let b6 = await cu.tool("book_appointment", { start: `${day}T13:30`, service: "Cleaning", customer_name: "Nisha", customer_phone: "+91 90000 55555", ok_to_call: true });
await sleep(2500);
ok(b6.ok && vlog("bolna", "/call").length === n0, "do-not-call number isn't called even with consent");

// ---------- daily cap ----------
const outToday = q1("SELECT COUNT(*) AS c FROM calls WHERE workspace_id=? AND direction='out'", wsId).c;
await cu.post("/setup/calling/settings", { enabled: "1", confirm: "1", remind: "3h", can_reschedule: "1", can_cancel: "1", inbound: "1", start: "9", end: "21", language: "hinglish", voice: "female", daily_cap: String(outToday) });
let b7 = await cu.tool("book_appointment", { start: `${day}T14:00`, service: "Cleaning", customer_name: "Om", customer_phone: "+91 90000 77777", ok_to_call: true });
ok(await until(() => q1("SELECT 1 AS x FROM activity WHERE workspace_id=? AND detail LIKE ?", wsId, `%Daily call limit (${outToday}) reached%${b7.ref}%`)), "daily limit: call skipped and noted");
await cu.post("/setup/calling/settings", { enabled: "1", confirm: "1", remind: "3h", can_reschedule: "1", can_cancel: "1", inbound: "1", start: "9", end: "21", language: "hinglish", voice: "female", daily_cap: "100" });

// ---------- switched off ----------
await cu.post("/setup/calling/settings", { remind: "3h", start: "9", end: "21", language: "hinglish", voice: "female", daily_cap: "100" });
const n1 = vlog("bolna", "/call").length;
let b8 = await cu.tool("book_appointment", { start: `${day}T20:00`, service: "Cleaning", customer_name: "Zoya", customer_phone: "+91 90000 88888", ok_to_call: true });
await sleep(2000);
ok(vlog("bolna", "/call").length === n1 && q1("SELECT call_consent FROM bookings WHERE ref=?", b8.ref).call_consent === 0, "calling off: no consent asked, no calls");
await cu.post("/setup/calling/settings", { enabled: "1", confirm: "1", remind: "3h", can_reschedule: "1", can_cancel: "1", inbound: "1", start: "9", end: "21", language: "hinglish", voice: "female", daily_cap: "100" });

// ---------- test call ----------
await cu.page("/setup/calling");
r = await cu.post("/setup/calling/test", { phone: "+91 98222 11133" });
ok(dec(r.loc).includes("Calling +919822211133 now") && vlog("bolna", "/call").at(-1)?.body.user_data.purpose === "test", "test call to the owner", dec(r.loc));

// ---------- Retell (signed tools and reports) ----------
const rsign = (body, ts = Date.now()) => `v=${ts},d=${crypto.createHmac("sha256", "retell-good").update(body + ts).digest("hex")}`;
await cu.page("/setup/calling?p=retell");
r = await cu.post("/setup/calling/p/retell", { api_key: "retell-good", number: "+91 80 1111 2222" });
ok(dec(r.loc).includes("Retell AI is connected"), "Retell connected", dec(r.loc));
const llm = vlog("retell", "/create-retell-llm").at(-1)?.body;
ok(llm?.general_tools?.some((x) => x.url === `http://localhost:3300/voice/tool/retell/${pub}/${secret}/confirm_attendance`) && llm.general_prompt.includes("{{customer_name}}"), "Retell LLM gets our tools and prompt");
ok(vlog("retell", /^\/update-phone-number\//).at(-1)?.body?.inbound_agents?.[0]?.agent_id === "ag_r1", "Retell number bound to the agent (incoming on)");
t = await tool(T("business_info"), {});
ok(t.status === 404, "old provider's tool address stops working after switching");
let b9 = await cu.tool("book_appointment", { start: `${ist(3)}T15:00`, service: "Cleaning", customer_name: "Dev", customer_phone: "+91 90000 99999", ok_to_call: true });
const bk9 = q1("SELECT * FROM bookings WHERE ref=?", b9.ref);
const rc = await until(() => vlog("retell", "/v2/create-phone-call").find((l) => l.body.retell_llm_dynamic_variables?.booking_ref === b9.ref));
ok(rc && rc.body.to_number === "+919000099999" && rc.body.metadata.call_key, "Retell call placed", JSON.stringify(rc?.body));
const c9 = await until(() => q1("SELECT * FROM calls WHERE booking_id=? AND provider_call_id IS NOT NULL", bk9.id));
const RT = (n) => `/voice/tool/retell/${pub}/${secret}/${n}`;
const body9 = JSON.stringify({ name: "confirm_attendance", args: {}, call: { call_id: c9.provider_call_id, direction: "outbound", to_number: "+919000099999", metadata: { call_key: c9.call_key } } });
t = await tool(RT("confirm_attendance"), body9);
ok(t.status === 401, "unsigned Retell tool call refused");
t = await tool(RT("confirm_attendance"), body9, { "x-retell-signature": rsign(body9, Date.now() - 10 * 60_000) });
ok(t.status === 401, "old Retell signature refused");
t = await tool(RT("confirm_attendance"), body9, { "x-retell-signature": rsign(body9) });
ok(t.j?.ok, "signed Retell tool call works", JSON.stringify(t.j));
const inb = JSON.stringify({ name: "booking_details", args: {}, call: { call_id: "call_in1", direction: "inbound", from_number: "+919000099999", to_number: "+918011112222" } });
t = await tool(RT("booking_details"), inb, { "x-retell-signature": rsign(inb) });
ok(t.j?.bookings?.some((x) => x.ref === b9.ref), "Retell incoming call: signed caller number used", JSON.stringify(t.j));
const rr = JSON.stringify({ event: "call_analyzed", call: { call_id: c9.provider_call_id, direction: "outbound", from_number: "+918011112222", to_number: "+919000099999", disconnection_reason: "user_hangup", duration_ms: 65000, transcript: "Agent: hi", call_analysis: { call_summary: "Confirmed." }, metadata: { call_key: c9.call_key } } });
await fetch(`${BASE}/webhooks/voice/retell/${pub}/${secret}`, { method: "POST", headers: { "x-retell-signature": "v=1,d=00" }, body: rr });
await sleep(1500);
ok(q1("SELECT status FROM calls WHERE id=?", c9.id).status === "ringing", "badly signed Retell report ignored");
await fetch(`${BASE}/webhooks/voice/retell/${pub}/${secret}`, { method: "POST", headers: { "x-retell-signature": rsign(rr) }, body: rr });
ok(await until(() => q1("SELECT 1 AS x FROM calls WHERE id=? AND status='completed' AND seconds=65", c9.id)), "signed Retell report saved");

// ---------- ElevenLabs ----------
await cu.page("/setup/calling?p=elevenlabs");
r = await cu.post("/setup/calling/p/elevenlabs", { api_key: "el-good", number: "+91 80 3333 4444" });
ok(dec(r.loc).includes("ElevenLabs is connected"), "ElevenLabs connected", dec(r.loc));
const elTool = vlog("elevenlabs", "/v1/convai/tools").find((l) => l.body.tool_config.name === "confirm_attendance")?.body.tool_config;
ok(elTool?.api_schema?.url.endsWith(`/voice/tool/elevenlabs/${pub}/${secret}/confirm_attendance`) && elTool.api_schema.request_body_schema.properties.caller.dynamic_variable === "system__caller_id", "ElevenLabs tools filled by the system (call key, caller)");
ok(vlog("elevenlabs", "/v1/convai/agents/create").at(-1)?.body?.conversation_config?.agent?.hinglish_mode === true, "ElevenLabs Hinglish mode on");
ok(vlog("elevenlabs", "/v1/convai/settings").at(-1)?.body?.webhooks?.post_call_webhook_id === "wh_el1", "ElevenLabs post-call webhook set");
let b10 = await cu.tool("book_appointment", { start: `${ist(3)}T16:00`, service: "Cleaning", customer_name: "Ira", customer_phone: "+91 90000 10101", ok_to_call: true });
const ec = await until(() => vlog("elevenlabs", "/v1/convai/exotel/outbound-call").find((l) => l.body.conversation_initiation_client_data?.dynamic_variables?.booking_ref === b10.ref));
ok(ec && ec.body.agent_phone_number_id === "pn_el", "ElevenLabs call placed through Exotel");
const c10 = await until(() => q1("SELECT * FROM calls WHERE booking_id=(SELECT id FROM bookings WHERE ref=?) AND provider_call_id IS NOT NULL", b10.ref));
const er = JSON.stringify({ type: "post_call_transcription", data: { conversation_id: c10.provider_call_id, status: "done", metadata: { call_duration_secs: 30, phone_call: { direction: "outbound", external_number: "+919000010101", agent_number: "+918033334444" } }, analysis: { transcript_summary: "Will come." }, transcript: [{ role: "agent", message: "Namaste" }], conversation_initiation_client_data: { dynamic_variables: { call_key: c10.call_key } } } });
const ts = Math.floor(Date.now() / 1000);
await fetch(`${BASE}/webhooks/voice/elevenlabs/${pub}/${secret}`, { method: "POST", headers: { "elevenlabs-signature": `t=${ts},v0=${crypto.createHmac("sha256", "el-hook-secret").update(`${ts}.${er}`).digest("hex")}` }, body: er });
ok(await until(() => q1("SELECT 1 AS x FROM calls WHERE id=? AND status='completed' AND summary='Will come.'", c10.id)), "signed ElevenLabs report saved");

// ---------- Sarvam (manual) ----------
await cu.page("/setup/calling?p=sarvam");
r = await cu.post("/setup/calling/p/sarvam", { api_key: "sv-good", org_id: "org1", workspace_id: "wks1", app_id: "app1", app_version: "x", connection_id: "conn1", number: "+91 80 5555 6666" });
ok(dec(r.loc).includes("The version is a number"), "Sarvam fields checked");
r = await cu.post("/setup/calling/p/sarvam", { api_key: "sv-good", org_id: "org1", workspace_id: "wks1", app_id: "app1", app_version: "2", connection_id: "conn1", number: "+91 80 5555 6666" });
ok(r.loc.includes("#manual") && dec(r.loc).includes("set up the agent in Sarvam"), "Sarvam saved; manual setup next", dec(r.loc));
r = await cu.page("/setup/calling");
ok(r.text.includes('id="manual"') && r.text.includes(`/voice/tool/sarvam/${pub}/${secret}/booking_details`) && r.text.includes("Copy instructions"), "Sarvam page shows prompt and tool addresses to paste");
r = await cu.post("/setup/calling/test", { phone: "+91 98222 11133" });
const sv = vlog("sarvam", /outbounds$/).at(-1)?.body;
ok(sv?.app_config?.app_id === "app1" && sv.app_config.app_version === 2 && sv.user_config.user_phone_number === "+919822211133" && sv.webhook_config.url.includes(`/webhooks/voice/sarvam/${pub}/${secret}`), "Sarvam test call placed", JSON.stringify(sv));

// ---------- disconnect ----------
r = await cu.post("/setup/calling/disconnect", {});
ok(dec(r.loc).includes("Calling disconnected"), "disconnected");
t = await tool(`/voice/tool/sarvam/${pub}/${secret}/business_info`, {});
ok(t.status === 404, "tool address dead after disconnect");
ok(!(await cu.say("!system")).includes("okay if we call you"), "consent question gone after disconnect");

console.log(`\nvoice: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
