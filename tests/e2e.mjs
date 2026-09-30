// End-to-end test against a running app (http://localhost:3300) with fakes on :4100.
import crypto from "node:crypto";
import fs from "node:fs";
const BASE = "http://localhost:3300";
let pass = 0, fail = 0;
const ok = (cond, name, extra = "") => { cond ? pass++ : fail++; console.log(`${cond ? "✅" : "❌"} ${name}${!cond && extra ? " — " + extra : ""}`); };

class Client {
  jar = {};
  async req(path, { method = "GET", form, json, headers = {}, raw, multipart } = {}) {
    const h = { ...headers, cookie: Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join("; ") };
    let body;
    if (form) { body = new URLSearchParams(form).toString(); h["content-type"] = "application/x-www-form-urlencoded"; }
    if (json) { body = JSON.stringify(json); h["content-type"] = "application/json"; }
    if (raw) body = raw;
    if (multipart) body = multipart;
    const r = await fetch(BASE + path, { method, headers: h, body, redirect: "manual" });
    for (const c of r.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(";"); const [k, v] = kv.split("=");
      if (v === "" || /Expires=Thu, 01 Jan 1970/.test(c)) delete this.jar[k]; else this.jar[k] = v;
    }
    const text = await r.text();
    return { status: r.status, loc: r.headers.get("location") || "", text };
  }
  async page(path) { const r = await this.req(path); this.csrf = r.text.match(/name="_csrf" value="([^"]+)"/)?.[1] || r.text.match(/data-csrf="([^"]+)"/)?.[1] || this.csrf; return r; }
  post(path, form) { return this.req(path, { method: "POST", form: { _csrf: this.csrf, ...form } }); }
}
const dec = (s) => decodeURIComponent(s.replace(/\+/g, " "));

// ---- Admin ----
const admin = new Client();
let r = await admin.req("/");
ok(r.status === 302 && r.loc.startsWith("/login"), "anon redirected to login");
r = await admin.req("/login", { method: "POST", form: { email: "admin@test.com", password: "wrong" } });
ok(dec(r.loc).includes("Wrong email or password"), "wrong password rejected");
r = await admin.req("/login", { method: "POST", form: { email: "admin@test.com", password: "AdminPass123" } });
ok(r.status === 302 && r.loc === "/", "admin login", r.loc);
r = await admin.page("/admin");
ok(r.text.includes("admin@test.com"), "admin panel lists admin");

// no csrf → 403
r = await admin.req("/admin/users/new", { method: "POST", form: { name: "X", email: "x@x.com" } });
ok(r.status === 403, "POST without CSRF blocked");

await admin.page("/admin/users/new");
r = await admin.post("/admin/users/new", { name: "Dr Priya", email: "priya@clinic.com", role: "user", status: "active", valid_until: "2099-01-01", perm_widget: "1", perm_whatsapp: "1", notes: "Paid 999 via UPI" });
const temp = r.text.match(/id="pw">([^<]+)</)?.[1];
ok(!!temp, "customer created, temp password shown", r.text.slice(0, 200));
r = await admin.post("/admin/users/new", { name: "Dup", email: "PRIYA@clinic.com", role: "user" });
ok(dec(r.loc).includes("already exists"), "duplicate email blocked");
// second admin
r = await admin.post("/admin/users/new", { name: "Ops", email: "ops@test.com", role: "admin", valid_until: "" });
ok(/id="pw">/.test(r.text), "second admin created");

// ---- Customer ----
const cu = new Client();
r = await cu.req("/login", { method: "POST", form: { email: "priya@clinic.com", password: temp } });
ok(r.loc.startsWith("/account/password"), "first login forces password change", r.loc);
r = await cu.req("/", {});
ok(r.loc.startsWith("/account/password"), "dashboard blocked until password changed");
await cu.page("/account/password?first=1");
r = await cu.post("/account/password", { current: temp, password: "short", password2: "short" });
ok(dec(r.loc).includes("at least 8"), "weak password rejected");
r = await cu.post("/account/password", { current: temp, password: "Clinic2026!", password2: "Clinic2026!" });
ok(r.loc.startsWith("/?ok="), "password changed", r.loc);
r = await cu.page("/");
ok(r.text.includes("Business details") && r.text.includes("Connect WhatsApp"), "dashboard shows steps");

// Business
await cu.page("/setup/business");
r = await cu.post("/setup/business", { business_name: "Smile Dental", services: "Consultation, Cleaning", days: "1", open_hour: "19", close_hour: "10" });
ok(dec(r.loc).includes("Closing time"), "business validation");
const days = ["1", "2", "3", "4", "5", "6", "7"];
const body = new URLSearchParams({ _csrf: cu.csrf, business_name: "Smile Dental", services: "Consultation, Cleaning", open_hour: "0", close_hour: "23", slot_minutes: "30", timezone: "Asia/Kolkata", extra_info: "Parking in basement" });
days.forEach((d) => body.append("days", d));
r = await cu.req("/setup/business", { method: "POST", raw: body.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
ok(r.loc.startsWith("/setup/claude"), "business saved → claude step", r.loc);

// Claude
await cu.page("/setup/claude");
r = await cu.post("/setup/claude", { api_key: "hello", model: "claude-sonnet-5-5" });
ok(dec(r.loc).includes("doesn't look like"), "bad key format rejected");
r = await cu.post("/setup/claude", { api_key: "sk-ant-bad", model: "claude-sonnet-5-5" });
ok(dec(r.loc).includes("not valid"), "invalid key rejected by test", dec(r.loc));
r = await cu.post("/setup/claude", { api_key: "sk-ant-good-key-123456", model: "claude-sonnet-5-5" });
ok(r.loc.startsWith("/setup/google"), "valid key saved", dec(r.loc));
r = await cu.page("/setup/claude");
ok(r.text.includes("sk-ant…3456") && !r.text.includes("sk-ant-good-key-123456"), "key masked, never shown in full");

// Google
await cu.page("/setup/google");
const fd = new FormData();
fd.append("keyfile", new Blob([JSON.stringify({ type: "service_account", client_email: "booking-bot@proj.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n" })], { type: "application/json" }), "whatever.json");
r = await cu.req(`/setup/google/key?_csrf=${cu.csrf}`, { method: "POST", multipart: fd });
ok(dec(r.loc).includes("Key uploaded"), "service account uploaded", dec(r.loc));
const fd2 = new FormData(); fd2.append("keyfile", new Blob(["{\"type\":\"user\"}"]), "x.json");
r = await cu.req(`/setup/google/key?_csrf=${cu.csrf}`, { method: "POST", multipart: fd2 });
ok(dec(r.loc).includes("not a service account"), "wrong JSON rejected");
r = await cu.page("/setup/google");
ok(r.text.includes("booking-bot@proj.iam.gserviceaccount.com"), "shows email to share with");
r = await cu.post("/setup/google", { calendar_id: "bookings@group.calendar.google.com" });
ok(r.loc.startsWith("/setup/test"), "calendar tested + saved", dec(r.loc));

// Test chat
r = await cu.page("/setup/test");
r = await cu.req("/setup/test/message", { method: "POST", json: { text: "hi" }, headers: { "x-csrf-token": cu.csrf } });
ok(JSON.parse(r.text).reply === "Hello from Smile Dental", "test chat replies with business context", r.text);
r = await cu.req("/setup/test/message", { method: "POST", json: { text: "please book me" }, headers: { "x-csrf-token": cu.csrf } });
ok(JSON.parse(r.text).reply.includes('"ok":true'), "test chat books a slot", r.text);
r = await cu.req("/setup/test/message", { method: "POST", json: { text: "what bookings do I have" }, headers: { "x-csrf-token": cu.csrf } });
ok(JSON.parse(r.text).reply.includes("Priya"), "lists booking by phone", r.text);
r = await cu.page("/");
ok(/dot done[^]*Test your assistant/.test(r.text), "test step auto-marked done after booking");

// Widget
r = await cu.req("/w/nothing");
ok(r.status === 404, "unknown widget 404");
await cu.page("/setup/widget");
r = await cu.post("/setup/widget", { color: "#2563eb", greeting: "Namaste! Book with us", enabled: "1" });
r = await cu.page("/setup/widget");
const pub = r.text.match(/\/w\/(ws_[A-Za-z0-9_-]+)/)?.[1];
ok(!!pub && r.text.includes("widget.js"), "widget live + embed code", pub);
const anon = new Client();
r = await anon.req(`/w/${pub}`);
ok(r.status === 200 && r.text.includes("Namaste! Book with us") && r.text.includes("#2563eb"), "widget page renders");
ok(r.text.includes(`window.WIDGET_ID="${pub}"`), "widget script gets a valid (unescaped) id");
r = await anon.req(`/w/${pub}/message`, { method: "POST", json: { session: "abcdefabcdefabcdef12", text: "book please" } });
ok(JSON.parse(r.text).reply?.includes('"ok":true'), "widget books (asks phone)", r.text);
r = await anon.req(`/w/${pub}/message`, { method: "POST", json: { session: "abcdefabcdefabcdef12", text: "what bookings do I have" } });
ok(JSON.parse(r.text).reply.includes("Priya"), "same widget session sees its booking", r.text);
r = await anon.req(`/w/${pub}/message`, { method: "POST", json: { session: "zzzzzzzzzzzzzzzzzzzz99", text: "what bookings do I have" } });
ok(JSON.parse(r.text).reply.includes("[]"), "another visitor can't see that booking", r.text);
r = await anon.req("/widget.js");
ok(r.text.includes("data-id"), "widget.js loader served");

// WhatsApp
await cu.page("/setup/whatsapp");
r = await cu.post("/setup/whatsapp", { phone_number_id: "999", api_key: "kapso-good" });
ok(dec(r.loc).includes("long number"), "short phone id rejected");
r = await cu.post("/setup/whatsapp", { phone_number_id: "444555666", api_key: "kapso-bad" });
ok(dec(r.loc).includes("rejected this API key"), "bad kapso key rejected", dec(r.loc));
r = await cu.post("/setup/whatsapp", { phone_number_id: "444555666", api_key: "kapso-good" });
ok(dec(r.loc).includes("isn't in this Kapso project"), "unknown phone id rejected", dec(r.loc));
r = await cu.post("/setup/whatsapp", { phone_number_id: "111222333", api_key: "kapso-good" });
ok(dec(r.loc).includes("WhatsApp is live on +1 555 010 0101"), "WhatsApp connected", dec(r.loc));
const logLines = fs.readFileSync(process.env.FAKE_LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const hook = logLines.find((l) => l.method === "POST" && l.url.endsWith("/webhooks"));
ok(hook?.body?.whatsapp_webhook?.url === `http://localhost:3300/webhooks/kapso/${pub}`, "webhook registered with our URL");
const secret = hook.body.whatsapp_webhook.secret_key;

// Inbound WhatsApp message
const send = async (payload, sig = true) => {
  const raw = JSON.stringify(payload);
  const headers = { "content-type": "application/json", "x-webhook-event": "whatsapp.message.received" };
  if (sig) headers["x-webhook-signature"] = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  return anon.req(`/webhooks/kapso/${pub}`, { method: "POST", raw, headers });
};
const inbound = (id, text) => ({ message: { id, type: "text", from: "919812345678", text: { body: text }, kapso: { direction: "inbound" } }, conversation: { phone_number: "+919812345678", kapso: { contact_name: "Rahul" } }, phone_number_id: "111222333" });
r = await send(inbound("wamid.1", "hi"), false);
ok(r.status === 401, "unsigned webhook rejected");
r = await send(inbound("wamid.2", "book me tomorrow"));
ok(r.status === 200, "signed webhook accepted");
await send(inbound("wamid.2", "book me tomorrow")); // duplicate retry
await new Promise((s) => setTimeout(s, 1500));
const after = fs.readFileSync(process.env.FAKE_LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const sends = after.filter((l) => l.url.includes("/meta/whatsapp/") && l.body?.type === "text");
ok(sends.length === 1 && sends[0].body.to === "919812345678" && sends[0].body.text.body.includes('"ok":true'), "bot replied once on WhatsApp with booking", JSON.stringify(sends));
ok(after.some((l) => l.body?.status === "read"), "marked as read + typing");
// batched payload
r = await send({ type: "whatsapp.message.received", batch: true, data: [inbound("wamid.3", "hi"), inbound("wamid.4", "there")] });
await new Promise((s) => setTimeout(s, 800));
const after2 = fs.readFileSync(process.env.FAKE_LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.url.includes("/meta/whatsapp/") && l.body?.type === "text");
ok(after2.length === 2, "batched messages answered once together", String(after2.length));

// Dashboard activity
r = await cu.page("/");
ok(r.text.includes("Rahul") || r.text.includes("919812345678"), "dashboard shows WhatsApp booking");

// ---- Admin controls take effect ----
r = await admin.page("/admin");
const uid = r.text.match(/href="\/admin\/users\/(\d+)"[^]*?priya@clinic/)?.[1] || r.text.match(/priya@clinic[^]*?href="\/admin\/users\/(\d+)"/)?.[1];
ok(!!uid, "admin sees customer", uid);
await admin.page(`/admin/users/${uid}`);
r = await admin.post(`/admin/users/${uid}`, { name: "Dr Priya", email: "priya@clinic.com", role: "user", status: "active", valid_until: "2099-01-01", perm_widget: "1", notes: "" });
r = await anon.req(`/w/${pub}/message`, { method: "POST", json: { session: "abcdefabcdefabcdef12", text: "hi" } });
ok(r.status === 200, "widget still on");
const before = fs.readFileSync(process.env.FAKE_LOG, "utf8").split("\n").length;
await send(inbound("wamid.5", "hi"));
await new Promise((s) => setTimeout(s, 800));
const nowSends = fs.readFileSync(process.env.FAKE_LOG, "utf8").trim().split("\n").slice(before - 1).filter((l) => l.includes("/meta/whatsapp/") && l.includes('"type":"text"'));
ok(nowSends.length === 0, "removing WhatsApp permission stops WhatsApp replies");

r = await admin.post(`/admin/users/${uid}`, { name: "Dr Priya", email: "priya@clinic.com", role: "user", status: "active", valid_until: "2020-01-01", perm_widget: "1", perm_whatsapp: "1" });
r = await cu.req("/");
ok(r.loc.includes("login") && dec(r.loc).includes("subscription ended"), "expired user logged out", dec(r.loc));
r = await anon.req(`/w/${pub}/message`, { method: "POST", json: { session: "abcdefabcdefabcdef12", text: "hi" } });
ok(r.status === 404, "expired user's widget stops");
r = await cu.req("/login", { method: "POST", form: { email: "priya@clinic.com", password: "Clinic2026!" } });
ok(dec(r.loc).includes("subscription ended"), "expired user can't log in");

// Reset password
r = await admin.post(`/admin/users/${uid}/reset-password`, {});
ok(/id="pw">/.test(r.text), "admin reset password shows new temp");

// Last-admin protections
const adminId = r.text.match(/x/) && (await admin.page("/admin")).text.match(/href="\/admin\/users\/(\d+)"[^<]*<\/a><\/td>\s*<\/tr>/g);
r = await admin.page("/admin");
const selfId = r.text.match(/admin@test\.com[^]*?href="\/admin\/users\/(\d+)"/)?.[1];
await admin.page(`/admin/users/${selfId}`);
r = await admin.post(`/admin/users/${selfId}`, { name: "Admin", email: "admin@test.com", role: "user", status: "active" });
ok(dec(r.loc).includes("can't remove your own admin"), "can't demote self");

// non-admin can't reach admin
r = await anon.req("/admin");
ok(r.status === 302, "anon can't open admin");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
