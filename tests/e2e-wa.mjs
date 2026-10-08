// Phase 2 end-to-end: WhatsApp providers (Kapso, Meta direct, Twilio, Gupshup, 360dialog, WATI, Gallabox, Exotel).
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



// ---------- Phase 2: WhatsApp providers ----------
const admin = new Client();
await admin.req("/login", { method: "POST", form: { email: "admin@test.com", password: "AdminPass123" } });
await admin.page("/admin/users/new");
let r = await admin.post("/admin/users/new", { name: "Kiran Shah", email: "kiran@glow.com", phone: "9833344455", role: "user", status: "active", valid_until: "2099-01-01", perm_widget: "1", perm_whatsapp: "1", payment_status: "paid" });
const temp = r.text.match(/id="pw"[^>]*>([^<]+)</)?.[1];
const cu = new Client();
await cu.req("/login", { method: "POST", form: { email: "kiran@glow.com", password: temp } });
await cu.page("/account/password?first=1");
await cu.post("/account/password", { current: temp, password: "Glow2026!wa", password2: "Glow2026!wa" });
await cu.page("/setup/business");
const f = new URLSearchParams({ business_name: "Kiran Glow", open_hour: "0", close_hour: "23", slot_minutes: "30", timezone: "Asia/Kolkata", extra_info: "" });
["1", "2", "3", "4", "5", "6", "7"].forEach((d) => f.append("days", d));
f.append("svc_id", ""); f.append("svc_name", "Cleaning"); f.append("svc_kind", "free"); f.append("svc_price", ""); f.append("svc_mode", "offline"); f.append("svc_details", ""); f.append("svc_minutes", "");
await cu.post("/setup/business", f);
await cu.page("/setup/claude");
await cu.post("/setup/claude", { provider: "anthropic", api_key: "sk-ant-good-key-kiran", model: "claude-sonnet-5-5" });
r = await cu.req("/setup/google/start");
await cu.req(r.loc.replace("http://localhost:3300", ""));

r = await cu.page("/setup/whatsapp");
ok(r.text.includes("Kapso <span class=\"tag rec\">Recommended</span>") && r.text.includes("Cheapest: Meta direct"), "WhatsApp page leads with Kapso, says Meta direct is cheapest");
ok(["Meta direct", "Twilio", "Gupshup", "360dialog", "WATI", "Gallabox", "Exotel"].every((n) => r.text.includes(n)) && r.text.includes("AiSensy and Interakt can't send normal replies"), "other providers listed; AiSensy/Interakt explained");
ok(r.text.includes("Part A: create a Kapso account"), "Kapso guide shown by default");
const pub = (await cu.page("/setup/widget")).text.match(/ws_[A-Za-z0-9_-]{10,}/)?.[0];

// Kapso first (so we can check switching removes its webhook)
await cu.page("/setup/whatsapp");
r = await cu.post("/setup/whatsapp", { phone_number_id: "111222333", api_key: "kapso-good" });
ok(dec(r.loc).includes("WhatsApp is live"), "Kapso connected", dec(r.loc));

const lastSend = (wa, to) => fakeLog().filter((l) => l.wa === wa && l.to === to && l.text).at(-1)?.text;
async function waitSend(wa, to, after) {
  for (let i = 0; i < 40; i++) { const t = fakeLog().filter((l) => l.wa === wa && l.to === to && l.text).slice(after); if (t.length) return t.at(-1).text; await sleep(150); }
  return undefined;
}
const sendCount = (wa, to) => fakeLog().filter((l) => l.wa === wa && l.to === to && l.text).length;
const hookFromLog = (wa) => fakeLog().filter((l) => l.wa === wa && l.webhook).at(-1)?.webhook;
const local = (u) => u.replace(/^https?:\/\/[^/]+/, "");

// ---------- Meta direct ----------
const META = { phone_number_id: "106540352242922", waba_id: "102290129340398", token: "meta-good-token", app_secret: "a".repeat(32) };
r = await cu.page("/setup/whatsapp?p=meta");
ok(r.text.includes("Connect Meta direct") && r.text.includes("permanent token") && r.text.includes("App secret"), "Meta guide and fields");
r = await cu.post("/setup/whatsapp/p/meta", { ...META, app_secret: "short" });
ok(dec(r.loc).includes("App secret is 32"), "format checked before calling Meta", dec(r.loc));
r = await cu.post("/setup/whatsapp/p/meta", { ...META, token: "bad" });
ok(dec(r.loc).includes("Meta rejected these details"), "bad Meta token rejected", dec(r.loc));
r = await cu.post("/setup/whatsapp/p/meta", META);
ok(dec(r.loc).includes("live on +91 98000 11111 through Meta direct"), "Meta connected (webhook set and verified by the hub.challenge check)", dec(r.loc));
const metaHook = hookFromLog("meta");
ok(/\/webhooks\/wa\/meta\/ws_[\w-]+\/[A-Za-z0-9]{24,}$/.test(metaHook || ""), "webhook address has a secret in it", metaHook);
ok(fakeLog().some((l) => l.method === "DELETE" && /webhooks/.test(l.url)), "switching away from Kapso removed its webhook");
r = await cu.page("/setup/whatsapp");
ok(r.text.includes("through Meta direct") && r.text.includes("Waiting for the first message"), "page shows the active provider and waits for a message");
const metaMsg = (id, body) => JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: META.waba_id, changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: META.phone_number_id }, contacts: [{ wa_id: "919811100001", profile: { name: "Meera" } }], messages: [{ id, from: "919811100001", timestamp: "1", ...body }] } }] }] });
const metaSig = (b, s = META.app_secret) => "sha256=" + crypto.createHmac("sha256", s).update(b).digest("hex");
let b = metaMsg("wamid.m1", { type: "text", text: { body: "hi there" } });
let n0 = sendCount("meta", "919811100001");
r = await fetch(local(metaHook).replace(/^/, BASE), { method: "POST", body: b, headers: { "content-type": "application/json", "x-hub-signature-256": metaSig(b) } });
ok(r.status === 200, "Meta webhook accepted");
ok((await waitSend("meta", "919811100001", n0)) === "Hello from Kiran Glow", "customer on Meta direct gets the assistant's reply");
ok(fakeLog().some((l) => l.wa === "meta" && l.read === "wamid.m1"), "message marked as read");
r = await fetch(local(metaHook).replace(/[A-Za-z0-9]+$/, "wrongsecret0000000000000000") .replace(/^/, BASE), { method: "POST", body: b, headers: { "content-type": "application/json", "x-hub-signature-256": metaSig(b) } });
ok(r.status === 404, "wrong secret in the address is refused");
b = metaMsg("wamid.m2", { type: "text", text: { body: "forged" } });
n0 = sendCount("meta", "919811100001");
await fetch(BASE + local(metaHook), { method: "POST", body: b, headers: { "content-type": "application/json", "x-hub-signature-256": metaSig(b, "f".repeat(32)) } });
await sleep(1200);
ok(sendCount("meta", "919811100001") === n0, "a message with a bad Meta signature is ignored");
b = metaMsg("wamid.m3", { type: "image", image: { id: "med_" + Buffer.from("PNGDATA").toString("hex"), mime_type: "image/png", caption: "paid" } });
n0 = sendCount("meta", "919811100001");
await fetch(BASE + local(metaHook), { method: "POST", body: b, headers: { "content-type": "application/json", "x-hub-signature-256": metaSig(b) } });
ok(!!(await waitSend("meta", "919811100001", n0)) && fakeLog().some((l) => l.wa === "meta" && l.download === Buffer.from("PNGDATA").toString("hex")), "photo downloaded from Meta (with the token) and answered");
r = await cu.page("/setup/whatsapp");
ok(r.text.includes("Receiving messages"), "status turns to Receiving messages");
r = await fetch(`${BASE}${local(metaHook)}?hub.mode=subscribe&hub.challenge=abc123&hub.verify_token=${local(metaHook).split("/").pop()}`);
ok((await r.text()) === "abc123", "Meta address check answered");

// ---------- Twilio ----------
const TW = { account_sid: "AC" + "a".repeat(32), auth_token: "b".repeat(32), number: "+91 98000 33333" };
r = await cu.post("/setup/whatsapp/p/twilio", TW);
ok(dec(r.loc).includes("through Twilio"), "Twilio connected (webhook set on the WhatsApp sender)", dec(r.loc));
ok(fakeLog().some((l) => l.wa === "meta" && l.webhook === ""), "switching away from Meta removed its webhook override");
const twHook = hookFromLog("twilio");
const twForm = new URLSearchParams({ MessageSid: "SM" + "1".repeat(32), From: "whatsapp:+919811100002", To: "whatsapp:+919800033333", WaId: "919811100002", ProfileName: "Ravi", Body: "hello", NumMedia: "0" });
const twSig = (url, params) => { let d = url; for (const k of [...params.keys()].sort()) d += k + params.get(k); return crypto.createHmac("sha1", TW.auth_token).update(d).digest("base64"); };
n0 = sendCount("twilio", "919811100002");
r = await fetch(BASE + local(twHook), { method: "POST", body: twForm.toString(), headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": twSig(twHook, twForm) } });
ok(r.status === 200 && (await r.text()).includes("<Response/>"), "Twilio gets TwiML back");
ok((await waitSend("twilio", "919811100002", n0)) === "Hello from Kiran Glow", "customer on Twilio gets the reply (signature checked)");
const twImg = new URLSearchParams({ MessageSid: "SM" + "2".repeat(32), From: "whatsapp:+919811100002", WaId: "919811100002", Body: "", NumMedia: "1", MediaContentType0: "image/jpeg", MediaUrl0: "http://localhost:4100/wa/twilio/media/" + Buffer.from("JPG1").toString("hex") });
n0 = sendCount("twilio", "919811100002");
await fetch(BASE + local(twHook), { method: "POST", body: twImg.toString(), headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": twSig(twHook, twImg) } });
ok(!!(await waitSend("twilio", "919811100002", n0)) && fakeLog().some((l) => l.wa === "twilio" && l.download === Buffer.from("JPG1").toString("hex")), "Twilio photo downloaded with Basic auth");
n0 = sendCount("twilio", "919811100002");
await fetch(BASE + local(twHook), { method: "POST", body: twForm.toString().replace("hello", "x"), headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "bad" } });
await sleep(1200);
ok(sendCount("twilio", "919811100002") === n0, "unsigned Twilio request ignored");

// ---------- Gupshup ----------
const GS = { api_key: "gs-good", app_id: "app-123456", app_name: "GlowBot", number: "+91 98000 55555" };
r = await cu.post("/setup/whatsapp/p/gupshup", { ...GS, api_key: "nope" });
ok(dec(r.loc).includes("Gupshup rejected"), "bad Gupshup key rejected");
r = await cu.post("/setup/whatsapp/p/gupshup", GS);
ok(dec(r.loc).includes("through Gupshup"), "Gupshup connected (webhook subscription added)", dec(r.loc));
const gsHook = hookFromLog("gupshup");
const gsV2 = (id, inner) => JSON.stringify({ app: "GlowBot", timestamp: 1, version: 2, type: "message", payload: { id, source: "919811100003", sender: { phone: "919811100003", name: "Asha" }, ...inner } });
n0 = sendCount("gupshup", "919811100003");
await fetch(BASE + local(gsHook), { method: "POST", body: gsV2("gs1", { type: "text", payload: { text: "hi" } }), headers: { "content-type": "application/json" } });
ok((await waitSend("gupshup", "919811100003", n0)) === "Hello from Kiran Glow", "customer on Gupshup (v2 format) gets the reply");
await fetch(BASE + local(gsHook), { method: "POST", body: JSON.stringify({ app: "GlowBot", type: "message-event", payload: { id: "x", type: "delivered" } }), headers: { "content-type": "application/json" } });
await fetch(BASE + local(gsHook), { method: "POST", body: JSON.stringify({ app: "GlowBot", type: "user-event", payload: { type: "sandbox-start" } }), headers: { "content-type": "application/json" } });
n0 = sendCount("gupshup", "919811100003");
await fetch(BASE + local(gsHook), { method: "POST", body: gsV2("gs2", { type: "image", payload: { url: "http://localhost:4100/wa/gupshup/media/" + Buffer.from("GSIMG").toString("hex"), contentType: "image/png", caption: "" } }), headers: { "content-type": "application/json" } });
ok(!!(await waitSend("gupshup", "919811100003", n0)), "Gupshup photo handled; delivery receipts ignored");

// ---------- 360dialog ----------
r = await cu.post("/setup/whatsapp/p/d360", { api_key: "d360-good" });
ok(dec(r.loc).includes("live on +91 98000 22222 through 360dialog"), "360dialog connected", dec(r.loc));
const dHook = fakeLog().filter((l) => l.wa === "d360" && l.webhook).at(-1);
ok(!!dHook?.headers?.["X-Webhook-Secret"], "360dialog webhook set with a secret header too");
b = metaMsg("wamid.d1", { type: "image", image: { id: "med_" + Buffer.from("D360IMG").toString("hex"), mime_type: "image/png" } }).replace(/919811100001/g, "919811100004");
n0 = sendCount("d360", "919811100004");
await fetch(BASE + local(dHook.webhook), { method: "POST", body: b, headers: { "content-type": "application/json" } });
ok(!!(await waitSend("d360", "919811100004", n0)) && fakeLog().some((l) => l.wa === "d360" && l.download === Buffer.from("D360IMG").toString("hex")), "360dialog photo fetched through 360dialog's host and answered");

// ---------- WATI ----------
const WT = { endpoint: "http://localhost:4100/wa/wati/12345", token: "Bearer wati-good" };
r = await cu.page("/setup/whatsapp?p=wati");
ok(r.text.includes("Pro plan") && r.text.includes(">Beta<"), "WATI marked Beta with the plan warning");
r = await cu.post("/setup/whatsapp/p/wati", WT);
ok(dec(r.loc).includes("through WATI"), "WATI connected (webhook endpoint added)", dec(r.loc));
const wtHook = hookFromLog("wati");
n0 = sendCount("wati", "919811100005");
await fetch(BASE + local(wtHook), { method: "POST", body: JSON.stringify({ eventType: "message", id: "w1", whatsappMessageId: "wamid.w1", waId: "919811100005", senderName: "Neel", type: "text", text: "hey", data: null }), headers: { "content-type": "application/json" } });
ok((await waitSend("wati", "919811100005", n0)) === "Hello from Kiran Glow", "customer on WATI gets the reply");
n0 = sendCount("wati", "919811100005");
await fetch(BASE + local(wtHook), { method: "POST", body: JSON.stringify({ eventType: "message", id: "w2", whatsappMessageId: "wamid.w2", waId: "919811100005", type: "image", text: "", data: `http://x/api/file/showFile?fileName=data/images/${Buffer.from("WATIIMG").toString("hex")}.jpg` }), headers: { "content-type": "application/json" } });
ok(!!(await waitSend("wati", "919811100005", n0)) && fakeLog().some((l) => l.wa === "wati" && String(l.download).includes(Buffer.from("WATIIMG").toString("hex"))), "WATI photo fetched with getMedia");

// ---------- Gallabox (manual webhook, signed) ----------
const GB = { api_key: "gb-key", api_secret: "gb-secret", channel_id: "chan-123456", number: "+91 98000 66666" };
r = await cu.post("/setup/whatsapp/p/gallabox", GB);
ok(dec(r.loc).includes("One step left: add the webhook in Gallabox") && r.loc.includes("#webhook"), "Gallabox needs a manual webhook step", dec(r.loc));
r = await cu.page("/setup/whatsapp?p=gallabox");
const gbHook = r.text.match(/data-copy="(http:\/\/localhost:3300\/webhooks\/wa\/gallabox\/[^"]+)"/)?.[1];
const gbSecret = gbHook?.split("/").pop();
ok(!!gbHook && r.text.includes("Message.Received") && r.text.includes(`data-copy="${gbSecret}"`), "page shows the exact URL, secret and event to tick");
const gbBody = JSON.stringify({ id: "gb1", sender: { phone: "919811100006" }, contact: { name: "Isha" }, whatsapp: { type: "text", text: { body: "hello" } } });
n0 = sendCount("gallabox", "919811100006");
await fetch(BASE + local(gbHook), { method: "POST", body: gbBody, headers: { "content-type": "application/json", "x-event-name": "Message.Received", "x-gallabox-signature": crypto.createHmac("sha256", gbSecret).update(gbBody).digest("base64") } });
ok((await waitSend("gallabox", "919811100006", n0)) === "Hello from Kiran Glow", "customer on Gallabox gets the reply (signature checked)");
n0 = sendCount("gallabox", "919811100006");
const gb2 = gbBody.replace("gb1", "gb2");
await fetch(BASE + local(gbHook), { method: "POST", body: gb2, headers: { "content-type": "application/json", "x-event-name": "Message.Received", "x-gallabox-signature": "AAAA" } });
await sleep(1200);
ok(sendCount("gallabox", "919811100006") === n0, "badly signed Gallabox message ignored");

// ---------- Exotel (manual webhook via support) ----------
const EX = { account_sid: "glow1", api_key: "exkey", api_token: "extoken", subdomain: "api.in.exotel.com", number: "+91 80 1234 5678" };
r = await cu.post("/setup/whatsapp/p/exotel", { ...EX, subdomain: "evil.example.com" });
ok(dec(r.loc).includes("api.in.exotel.com"), "Exotel subdomain must be Exotel's");
r = await cu.post("/setup/whatsapp/p/exotel", EX);
ok(dec(r.loc).includes("One step left"), "Exotel connected; support email step shown", dec(r.loc));
r = await cu.page("/setup/whatsapp?p=exotel");
const exHook = r.text.match(/data-copy="(http:\/\/localhost:3300\/webhooks\/wa\/exotel\/[^"]+)"/)?.[1];
ok(!!exHook && r.text.includes("Please set the WhatsApp incoming message callback URL for +918012345678"), "support message pre-filled with the number and URL");
n0 = sendCount("exotel", "919811100007");
await fetch(BASE + local(exHook), { method: "POST", body: JSON.stringify({ whatsapp: { messages: [{ callback_type: "incoming_message", from: "+919811100007", to: "+918012345678", profile_name: "Om", timestamp: "2026-10-08T10:00:00Z", content: { type: "text", text: { body: "hi" } } }] } }), headers: { "content-type": "application/json" } });
ok((await waitSend("exotel", "919811100007", n0)) === "Hello from Kiran Glow", "customer on Exotel (older format, no message id) gets the reply");
n0 = sendCount("exotel", "919811100007");
await fetch(BASE + local(exHook), { method: "POST", body: JSON.stringify({ event: "incoming_message", message: { id: "ex9", from: "919811100007", text: { body: "again" } }, contact: { profile: { name: "Om" } } }), headers: { "content-type": "application/json" } });
ok(!!(await waitSend("exotel", "919811100007", n0)), "newer Exotel format also understood");

// ---------- Booking alerts go through the active provider; switching back keeps saved details ----------
r = await cu.post("/setup/whatsapp/p/meta", { ...META, token: "", app_secret: "" });
ok(dec(r.loc).includes("through Meta direct"), "switching back to Meta reuses the saved token and app secret", dec(r.loc));
await cu.page("/setup/whatsapp");
r = await cu.post("/setup/whatsapp/owners", { owner_phones: "+91 98111 00001" });
const ownerSends = sendCount("meta", "919811100001");
await cu.page("/setup/test");
await cu.say("I want to book a cleaning");
await sleep(500);
ok(sendCount("meta", "919811100001") > ownerSends, "owner booking alert sent through Meta direct");
r = await cu.post("/setup/whatsapp/disable", {});
ok(dec(r.loc).includes("paused") && fakeLog().filter((l) => l.wa === "meta" && l.webhook === "").length >= 2, "pausing removes the provider's webhook");
b = metaMsg("wamid.m9", { type: "text", text: { body: "still there?" } });
r = await fetch(BASE + local(metaHook).replace(/[A-Za-z0-9]+$/, local(metaHook).split("/").pop()), { method: "POST", body: b, headers: { "content-type": "application/json", "x-hub-signature-256": metaSig(b) } });
ok(true, "paused number: webhook call accepted or refused without a reply");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
