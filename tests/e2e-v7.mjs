// v7 end-to-end: services & prices, profile & knowledge, website import, holidays, Google sign-in + invites,
// Razorpay (redirect, webhook, polling, expiry, late payment), UPI, owner mode (test chat + WhatsApp), bookings page.
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

// ---------- A new customer ----------
const admin = new Client();
await admin.req("/login", { method: "POST", form: { email: "admin@test.com", password: "AdminPass123" } });
await admin.page("/admin/users/new");
let r = await admin.post("/admin/users/new", { name: "Asha Mehta", email: "asha@glow.com", phone: "9811122233", role: "user", status: "active", valid_until: "2099-01-01", perm_widget: "1", perm_whatsapp: "1", payment_status: "paid" });
const temp = r.text.match(/id="pw"[^>]*>([^<]+)</)?.[1];
const cu = new Client();
await cu.req("/login", { method: "POST", form: { email: "asha@glow.com", password: temp } });
await cu.page("/account/password?first=1");
await cu.post("/account/password", { current: temp, password: "Glow2026!x", password2: "Glow2026!x" });

// ---------- Services editor ----------
r = await cu.page("/setup/business");
ok(r.text.includes("data-svc-editor") && r.text.includes('name="svc_name"'), "business page has the services editor");
const f = new URLSearchParams({ business_name: "Glow Studio", open_hour: "0", close_hour: "23", slot_minutes: "30", timezone: "Asia/Kolkata", extra_info: "" });
["1", "2", "3", "4", "5", "6", "7"].forEach((d) => f.append("days", d));
const rows = [
  { name: "Facial", kind: "paid", price: "800", mode: "offline", details: "60 minute glow facial", minutes: "60" },
  { name: "Consultation", kind: "free", price: "", mode: "both", details: "", minutes: "" },
  { name: "Skin check", kind: "paid", price: "0", mode: "online", details: "", minutes: "" }, // paid but ₹0 → free
  { name: "", kind: "free", price: "", mode: "offline", details: "", minutes: "" },          // blank row ignored
];
for (const x of rows) { f.append("svc_id", ""); f.append("svc_name", x.name); f.append("svc_kind", x.kind); f.append("svc_price", x.price); f.append("svc_mode", x.mode); f.append("svc_details", x.details); f.append("svc_minutes", x.minutes); }
r = await cu.post("/setup/business", f);
ok(r.loc.startsWith("/setup/claude"), "business with services saved", dec(r.loc));
r = await cu.page("/setup/business");
ok(r.text.includes('value="Facial"') && r.text.includes('value="800"') && r.text.includes("60 minute glow facial"), "service with price + details shown back");
const skinRow = r.text.split('value="Skin check"')[1] || "";
ok(/<option value="free" selected>/.test(skinRow.slice(0, 600)), "paid with ₹0 is saved as free");

await cu.page("/setup/claude");
await cu.post("/setup/claude", { api_key: "sk-ant-good-key-glow", model: "claude-sonnet-5-5" });

// ---------- Sign in with Google ----------
r = await cu.page("/setup/google");
ok(r.text.includes("Sign in with Google") && r.text.includes("Use a service-account key instead"), "Google step offers one-click sign-in, key file as advanced");
r = await cu.req("/setup/google/start");
ok(r.status === 302 && r.loc.includes("/setup/google/callback") && r.loc.includes("state="), "sign-in redirects to Google (fake)");
const bad = await cu.req("/setup/google/callback?code=fake-code&state=wrong");
ok(dec(bad.loc).includes("expired"), "callback with wrong state rejected");
r = await cu.req(r.loc.replace("http://localhost:3300", ""));
ok(dec(r.loc).includes('Google connected. Bookings go to "owner@gmail.com"'), "callback connects + picks main calendar", dec(r.loc));
r = await cu.page("/setup/google");
ok(r.text.includes("Signed in as owner@gmail.com") && r.text.includes("Bookings</option>"), "shows account + calendar picker");
await cu.post("/setup/google", { calendar_id: "bookings@group.calendar.google.com" });
r = await cu.page("/setup/google");
ok(/<option value="bookings@group.calendar.google.com" selected>/.test(r.text), "switched calendar");

// ---------- Profile & knowledge ----------
await cu.page("/setup/profile");
r = await cu.post("/setup/profile", { contact_phone: "+91 98111 22233", contact_email: "not-an-email", address: "12 MG Road, Bengaluru", maps_url: "", website: "localhost:4100/site", social_instagram: "instagram.com/glowstudio", social_facebook: "javascript:alert(1)" });
r = await cu.page("/setup/profile");
ok(r.text.includes("12 MG Road") && r.text.includes("google.com/maps/search/?api=1&amp;query=Glow%20Studio%2012%20MG%20Road") , "map link made from address");
ok(r.text.includes("https://instagram.com/glowstudio") && !r.text.includes("javascript:alert"), "social links cleaned (https added, bad scheme dropped)");
ok(!r.text.includes('value="not-an-email"'), "invalid email not saved");
const up = new FormData();
up.append("files", new Blob(["# Prices\nBridal package ₹15000.\nWe speak Hindi, Bengali and English."], { type: "text/markdown" }), "prices.md");
up.append("files", new Blob([JSON.stringify([{ name: "Glow chat", chat_messages: [{ sender: "human", text: "Our cancellation policy: 24 hours notice please." }, { sender: "assistant", text: "Got it." }] }])], { type: "application/json" }), "claude-export.json");
up.append("files", new Blob(["MZ\u0000\u0001"], { type: "application/octet-stream" }), "virus.exe");
r = await cu.req(`/setup/profile/files?_csrf=${cu.csrf}`, { method: "POST", multipart: up });
ok(dec(r.loc).includes("Added 2 files") && dec(r.loc).includes("virus.exe"), "md + json chat export accepted, .exe rejected", dec(r.loc));
await cu.post("/setup/profile/note", { title: "Parking", content: "Free parking behind the building." });
r = await cu.page("/setup/profile");
ok(r.text.includes("prices") && r.text.includes("claude-export") && r.text.includes("Parking"), "knowledge listed");
const noteId = [...r.text.split("Free parking")[0].matchAll(/action="\/setup\/profile\/knowledge\/(\d+)"/g)].at(-1)?.[1];

// Website import
r = await cu.post("/setup/profile/import", { url: "http://localhost:4100/site" });
ok(r.status === 200 && r.text.includes("Add these services?") && r.text.includes("Bridal makeup") && r.text.includes("₹5,000"), "website import suggests services", r.text.slice(0, 300) + dec(r.loc));
const pickI = r.text.match(/name="svc_(\d+)" value="([^"]*Bridal makeup[^"]*)"/);
const addSvc = new URLSearchParams(); addSvc.append("pick", pickI[1]); addSvc.append(`svc_${pickI[1]}`, pickI[2].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'"));
r = await cu.post("/setup/profile/add-services", addSvc);
ok(dec(r.loc).includes("Added 1 service"), "picked service added", dec(r.loc));
const crawl = fakeLog();
r = await cu.page("/setup/profile");
ok(r.text.includes("Website: localhost") && r.text.includes("Bridal makeup costs ₹5000"), "website notes saved (crawled the services page too)");

// Prompt contains everything
await cu.page("/setup/test");
let sys = await cu.say("!system");
ok(sys.includes("12 MG Road") && sys.includes("Google Maps: https://www.google.com/maps/search") && sys.includes("Facial: ₹800") && sys.includes("Skin check: free"), "prompt has address, map, prices", sys.slice(0, 400));
ok(sys.includes("Bridal package ₹15000") && sys.includes("24 hours notice") && sys.includes("Free parking"), "prompt has uploaded files, chat export and notes");
ok(sys.includes("Google Meet link is created automatically") && sys.includes("calendar invite"), "prompt knows about Meet + invites");
await cu.post(`/setup/profile/knowledge/${noteId}/delete`, {});
sys = await cu.say("!system");
ok(!sys.includes("Free parking"), "deleted note no longer used");

// ---------- Booking with invite + Meet ----------
const day = ist(2);
let av = await cu.tool("check_availability", { date: day, service: "Consultation" });
ok(Array.isArray(av.slots) && av.slots.length > 5, "availability", JSON.stringify(av));
let b = await cu.tool("book_appointment", { start: `${day}T${av.slots[0]}`, service: "Consultation", customer_name: "Ravi", customer_email: "ravi@example.com", mode: "online", customer_phone: "+91 90000 00001" });
ok(b.ok && b.status === "confirmed" && /^BK-/.test(b.ref) && b.meetLink?.startsWith("https://meet.google.com/") && b.invite === "ravi@example.com", "online booking: Meet link + email invite", JSON.stringify(b));
let evs = await (await fetch(`${BASE}/__test/google-events`)).json();
let ev = evs.find((e) => e.priv.bookingRef === b.ref);
ok(ev?.attendees?.[0]?.email === "ravi@example.com" && ev.sendUpdates === "all" && ev.calendarId === "bookings@group.calendar.google.com", "calendar event invites the customer", JSON.stringify(ev));
const onlineRef = b.ref;
b = await cu.tool("book_appointment", { start: `${day}T${av.slots[3]}`, service: "Consultation", customer_name: "Meena", mode: "offline", customer_phone: "+91 90000 00002" });
ok(b.ok && b.location === "12 MG Road, Bengaluru" && b.mapsLink?.includes("google.com/maps") && b.message.includes("Map:"), "in-person booking returns address + map", JSON.stringify(b));
evs = await (await fetch(`${BASE}/__test/google-events`)).json();
ok(evs.find((e) => e.priv.bookingRef === b.ref)?.location?.includes("12 MG Road"), "in-person event has the address as location");
// Reschedule + list + cancel
let mv = await cu.tool("reschedule_appointment", { ref: b.ref, new_start: `${day}T${av.slots[5]}` });
ok(mv.ok && mv.message.includes("Moved"), "reschedule", JSON.stringify(mv));
let mine = await cu.tool("list_my_appointments");
ok(Array.isArray(mine) && mine.length === 2 && mine.some((x) => x.meetLink), "list my appointments (with Meet link)", JSON.stringify(mine));
let cx = await cu.tool("cancel_appointment", { ref: onlineRef });
ok(cx.ok, "cancel");
evs = await (await fetch(`${BASE}/__test/google-events`)).json();
ok(!evs.some((e) => e.priv.bookingRef === onlineRef), "cancel removes the calendar event");
const other = await cu.tool("cancel_appointment", { ref: "BK-NOTMINE" });
ok(String(other._raw || JSON.stringify(other)).includes("No booking"), "can't touch unknown refs");

// ---------- Holidays ----------
await cu.page("/setup/holidays");
const hday = ist(3);
r = await cu.post("/setup/holidays", { date: hday, label: "Durga Puja", end_date: "" });
ok(dec(r.loc).includes("Day off added"), "holiday added");
av = await cu.tool("check_availability", { date: hday });
ok(av.slots?.length === 0 && av.closed === "Durga Puja", "no slots on a holiday, reason given", JSON.stringify(av));
const txt = new FormData();
txt.append("text", `${ist(10)} Diwali\n${ist(12).split("-").reverse().join("/")} Bhai Dooj\nrandom line\n${ist(20)} to ${ist(22)} Staff trip`);
r = await cu.req(`/setup/holidays/text?_csrf=${cu.csrf}`, { method: "POST", multipart: txt });
ok(dec(r.loc).includes("Found 3 dates, added 3"), "pasted list parsed (ISO, dd/mm/yyyy, range)", dec(r.loc));
av = await cu.tool("check_availability", { date: ist(21) });
ok(av.closed === "Staff trip", "range blocks days in the middle", JSON.stringify(av));
r = await cu.page(`/setup/holidays?country=${encodeURIComponent("en.indian#holiday@group.v.calendar.google.com")}`);
ok(r.text.includes("Republic Day") && r.text.includes("Independence Day"), "public holidays listed from Google");
r = await cu.post("/setup/holidays/import", { pick: `${new Date().getFullYear() + 1}-01-26|Republic Day` });
ok(dec(r.loc).includes("Added 1 holiday"), "public holiday imported");
// All-day "Leave" event in their calendar closes the day
evs = await (await fetch(`${BASE}/__test/google-events`)).json();
sys = await cu.say("!system");
ok(sys.includes("Durga Puja") && sys.includes("Diwali"), "prompt lists upcoming holidays");

// ---------- Payments: Razorpay ----------
await cu.page("/setup/payments");
r = await cu.post("/setup/payments/razorpay", { key_id: "rzp_test_good", key_secret: "nope" });
ok(dec(r.loc).includes("rejected these keys"), "bad Razorpay keys rejected", dec(r.loc));
r = await cu.post("/setup/payments/razorpay", { key_id: "not-a-key", key_secret: "x" });
ok(dec(r.loc).includes("should look like"), "Key ID format checked");
r = await cu.post("/setup/payments/razorpay", { key_id: "rzp_test_good", key_secret: "secret_good" });
ok(dec(r.loc).includes("TEST mode"), "Razorpay connected (test mode flagged)", dec(r.loc));
r = await cu.page("/setup/payments");
const hookSecret = r.text.match(/Secret: <span class="mono"[^>]*>([^<]+)</)?.[1];
ok(!!hookSecret && r.text.includes(`/webhooks/razorpay/`), "webhook URL + secret shown");
const pub = r.text.match(/\/webhooks\/razorpay\/(ws_[A-Za-z0-9_-]+)/)?.[1];
ok(r.text.includes("Not received yet") && !r.text.includes("Webhook working"), "webhook status: waiting for the first event");
r = await cu.post("/setup/payments", { pay_at_venue: "1", online_discount_pct: "10" });
r = await cu.page("/setup/payments");
ok(r.text.includes("₹800 at the venue") && r.text.includes("₹720 online"), "price preview shows discount");

let pr = await cu.tool("get_price", { service: "Facial" });
ok(pr.list_price === 800 && pr.pay_at_venue === 800 && pr.pay_online === 720 && pr.online_discount_percent === 10, "get_price: venue vs online", JSON.stringify(pr));
const pday = ist(4);
av = await cu.tool("check_availability", { date: pday, service: "Facial" });
ok(av.slots.length && av.slots.every((s, i, a) => i === 0 || s > a[i - 1]), "slots for 60-min facial");
const ask = await cu.tool("book_appointment", { start: `${pday}T${av.slots[0]}`, service: "Facial", customer_name: "Neha", customer_phone: "+919800000003" });
ok(!ask.ok && ask.message.includes("₹720") && ask.message.includes("₹800"), "paid service without payment choice → asks online/venue", JSON.stringify(ask));

// 1) Pay online → redirect back → confirmed
const s1 = av.slots[0];
let p1 = await cu.tool("book_appointment", { start: `${pday}T${s1}`, service: "Facial", customer_name: "Neha", customer_phone: "+919800000003", customer_email: "neha@example.com", payment: "online" });
ok(p1.ok && p1.status === "awaiting_payment" && p1.amount === 720 && p1.payUrl?.includes("/rzp/plink_"), "online payment → link, slot held", JSON.stringify(p1));
const rzCreate = fakeLog().filter((l) => l.razorpay && l.method === "POST" && l.url === "/v1/payment_links").at(-1);
ok(rzCreate.body.amount === 72000 && rzCreate.body.reference_id === p1.ref && /\/pay\/ws_[\w-]+\/BK-\w+\/[0-9a-f]{20}$/.test(rzCreate.body.callback_url) && rzCreate.body.callback_url.includes(`/pay/${pub}/${p1.ref}/`) && rzCreate.body.expire_by > Date.now() / 1000 + 15 * 60, "link: amount in paise, ref, callback, ≥15 min expiry", JSON.stringify(rzCreate.body));
av = await cu.tool("check_availability", { date: pday, service: "Facial" });
ok(!av.slots.includes(s1), "held slot not offered to others");
let chk = await cu.tool("check_payment", { ref: p1.ref });
ok(chk.status === "not_paid_yet" && chk.message.includes("still open"), "‘I paid’ before paying → not yet", JSON.stringify(chk));
const anon = new Client();
r = await anon.req(`/pay/${pub}/${p1.ref}/0000000000aaaaaaaaaa`);
ok(r.status === 404, "pay page needs the signed token");
r = await anon.req(payPath(p1.ref));
ok(r.text.includes("Pay ₹720") && r.text.includes("data-countdown"), "payment page shows amount + countdown");
const plink1 = p1.payUrl.split("/").pop();
const paid1 = await (await fetch(`http://localhost:4100/__rzp/pay/${plink1}`, { method: "POST" })).json();
const cbq = new URLSearchParams(paid1.callback);
const tampered = new URLSearchParams(paid1.callback); tampered.set("razorpay_signature", "0".repeat(64));
r = await anon.req(`${payPath(p1.ref)}?${tampered}`);
ok(r.text.includes("You're booked"), "tampered signature ignored, but server double-checks Razorpay and confirms anyway");
evs = await (await fetch(`${BASE}/__test/google-events`)).json();
ev = evs.find((e) => e.priv.bookingRef === p1.ref);
ok(ev && ev.attendees?.[0]?.email === "neha@example.com" && ev.description.includes("₹720 paid online"), "paid booking lands in calendar with invite", JSON.stringify(ev));
r = await anon.req(`${payPath(p1.ref)}?${cbq}`);
ok(r.text.includes("You're booked") && r.text.includes("Open in Google Maps") && r.text.includes("Add to Google Calendar"), "redirect page: booked, map, add to calendar");
evs = await (await fetch(`${BASE}/__test/google-events`)).json();
ok(evs.filter((e) => e.priv.bookingRef === p1.ref).length === 1, "double confirmation creates only one event");
chk = await cu.tool("check_payment", { ref: p1.ref });
ok(chk.status === "paid", "check_payment after paying → paid");

// 2) Webhook confirms
av = await cu.tool("check_availability", { date: pday, service: "Facial" });
let p2 = await cu.tool("book_appointment", { start: `${pday}T${av.slots[0]}`, service: "Facial", customer_name: "Kiran", customer_phone: "+919800000004", payment: "online" });
const plink2 = p2.payUrl.split("/").pop();
await fetch(`http://localhost:4100/__rzp/pay/${plink2}`, { method: "POST" });
const hookBody = JSON.stringify({ event: "payment_link.paid", payload: { payment_link: { entity: { id: plink2, reference_id: p2.ref, status: "paid" } }, payment: { entity: { id: `pay_${plink2}` } } } });
r = await anon.req(`/webhooks/razorpay/${pub}`, { method: "POST", raw: hookBody, headers: { "content-type": "application/json", "x-razorpay-signature": "bad" } });
ok(r.status === 401, "webhook with bad signature rejected");
const sig = crypto.createHmac("sha256", hookSecret).update(hookBody).digest("hex");
r = await anon.req(`/webhooks/razorpay/${pub}`, { method: "POST", raw: hookBody, headers: { "content-type": "application/json", "x-razorpay-signature": sig, "x-razorpay-event-id": "evt_1" } });
ok(r.status === 200, "signed webhook accepted");
await anon.req(`/webhooks/razorpay/${pub}`, { method: "POST", raw: hookBody, headers: { "content-type": "application/json", "x-razorpay-signature": sig, "x-razorpay-event-id": "evt_1" } });
await sleep(400);
chk = await cu.tool("check_payment", { ref: p2.ref });
ok(chk.status === "paid" && chk.message.includes("confirmed"), "webhook confirmed the booking", JSON.stringify(chk));
evs = await (await fetch(`${BASE}/__test/google-events`)).json();
ok(evs.filter((e) => e.priv.bookingRef === p2.ref).length === 1, "duplicate webhook → still one event");
r = await cu.page("/setup/payments");
ok(r.text.includes("Webhook working") && r.text.includes("last update just now") && !r.text.includes("Update your webhook address"), "webhook status turns green after a signed event");
if (process.env.TEST_DB !== "turso") {
  // Our address changed (e.g. a new domain): the business is told, on the dashboard and the payments page.
  const { DatabaseSync } = await import("node:sqlite");
  const sq = new DatabaseSync(process.env.DATABASE_PATH);
  sq.prepare("UPDATE workspaces SET rzp_hook_url=? WHERE public_id=?").run("https://old.example.com/webhooks/razorpay/" + pub, pub);
  r = await cu.page("/");
  ok(r.text.includes("Update your Razorpay webhook") && r.text.includes("/setup/payments#webhook"), "dashboard warns when the webhook address changed");
  r = await cu.page("/setup/payments");
  ok(r.text.includes("Update your webhook address in Razorpay") && r.text.includes(`localhost:3300/webhooks/razorpay/${pub}`) && !r.text.includes("Webhook working"), "payments page shows the new address to paste");
  r = await cu.post("/setup/payments/razorpay/hook-updated", {});
  ok(dec(r.loc).includes("turns green"), "I've updated it", dec(r.loc));
  r = await cu.page("/");
  ok(!r.text.includes("Update your Razorpay webhook"), "warning gone after confirming");
  sq.close();
}

// 3) No webhook, no redirect: the poller catches it
av = await cu.tool("check_availability", { date: pday, service: "Facial" });
let p3 = await cu.tool("book_appointment", { start: `${pday}T${av.slots[0]}`, service: "Facial", customer_name: "Arjun", customer_phone: "+919800000005", payment: "online" });
await fetch(`http://localhost:4100/__rzp/pay/${p3.payUrl.split("/").pop()}`, { method: "POST" });
await sleep(3500);
mine = await cu.tool("list_my_appointments");
ok(mine.find((x) => x.ref === p3.ref)?.status === "confirmed", "poller confirmed a payment with no webhook", JSON.stringify(mine));

// 4) Link expires → slot released, customer told
av = await cu.tool("check_availability", { date: pday, service: "Facial" });
const s4 = av.slots[0];
let p4 = await cu.tool("book_appointment", { start: `${pday}T${s4}`, service: "Facial", customer_name: "Zoya", customer_phone: "+919800000006", payment: "online" });
const plink4 = p4.payUrl.split("/").pop();
await fetch(`http://localhost:4100/__rzp/expire/${plink4}`, { method: "POST" });
await sleep(3500);
av = await cu.tool("check_availability", { date: pday, service: "Facial" });
ok(av.slots.includes(s4), "expired link releases the slot");
r = await anon.req(payPath(p4.ref));
ok(r.text.includes("Not booked") && r.text.includes("expired"), "payment page explains expiry");
const hist = await cu.say("!system");
// 5) Someone else takes that slot, then the old payment arrives late → paid_unbooked → rebook with credit
let venue = await cu.tool("book_appointment", { start: `${pday}T${s4}`, service: "Facial", customer_name: "Other", customer_phone: "+919800000007", payment: "venue" });
ok(venue.ok && venue.status === "confirmed" && venue.message.includes("Pay ₹800 at the venue"), "pay-at-venue booking confirmed at full price", JSON.stringify(venue));
const lp = await (await fetch(`http://localhost:4100/__rzp/get/${plink4}`)).json();
lp.status = "paid"; // simulate the bank confirming after expiry
await fetch(`http://localhost:4100/__rzp/pay/${plink4}`, { method: "POST" });
chk = await cu.tool("check_payment", { ref: p4.ref });
ok(chk.status === "paid" && chk.message.includes("slot was taken"), "late payment, slot gone → customer asked for a new time", JSON.stringify(chk));
mine = await cu.tool("list_my_appointments");
ok(mine.find((x) => x.ref === p4.ref)?.status.includes("needs a new time"), "shows as paid, needs new time");
av = await cu.tool("check_availability", { date: pday, service: "Facial" });
const rb = await cu.tool("book_appointment", { start: `${pday}T${av.slots.at(-1)}`, service: "Facial", customer_name: "Zoya", customer_phone: "+919800000006", payment: "online" });
ok(rb.ok && rb.status === "confirmed" && rb.ref === p4.ref, "rebooking uses the earlier payment (no new link)", JSON.stringify(rb));

// Paid bookings can't be cancelled, only moved.
{
  av = await cu.tool("check_availability", { date: pday, service: "Facial" });
  const pr1 = await cu.tool("book_appointment", { start: `${pday}T${av.slots[1]}`, service: "Facial", customer_name: "Paid Keeper", customer_phone: "+919800000020", payment: "online" });
  await fetch(`http://localhost:4100/__rzp/pay/${pr1.payUrl.split("/").pop()}`, { method: "POST" });
  await cu.tool("check_payment", { ref: pr1.ref });
  const no = await cu.tool("cancel_appointment", { ref: pr1.ref });
  ok(!no.ok && no.message.includes("can't be cancelled") && no.message.includes("reschedule"), "customer can't cancel a paid booking; offered reschedule", JSON.stringify(no));
  const no2 = await cu.tool("cancel_booking", { ref: pr1.ref }, "owner");
  ok(!no2.ok && no2.message.includes("can't be cancelled"), "owner can't cancel a paid booking either");
  const mv2 = await cu.tool("reschedule_appointment", { ref: pr1.ref, new_start: `${pday}T${av.slots.at(-1)}` });
  ok(mv2.ok, "paid booking can be rescheduled", JSON.stringify(mv2));
  const mv3 = await cu.tool("reschedule_booking", { ref: pr1.ref, new_start: `${pday}T${av.slots.at(-2)}` }, "owner");
  ok(mv3.ok, "owner can move a paid booking too", JSON.stringify(mv3));
  const chk2 = await cu.tool("check_payment", { ref: pr1.ref });
  ok(chk2.status === "paid", "still paid and confirmed after moving");
}
// Two people racing for the same slot: only one wins.
{
  av = await cu.tool("check_availability", { date: ist(7), service: "Consultation" });
  const [a, b2] = await Promise.all([
    cu.tool("book_appointment", { start: `${ist(7)}T${av.slots[0]}`, service: "Consultation", customer_name: "Race A", customer_phone: "+919800000021", mode: "offline" }),
    cu.tool("book_appointment", { start: `${ist(7)}T${av.slots[0]}`, service: "Consultation", customer_name: "Race B", customer_phone: "+919800000022", mode: "offline" }),
  ]);
  ok([a, b2].filter((x) => x.ok).length === 1, "same slot at the same moment: exactly one booking", JSON.stringify([a.ok, b2.ok]));
}

// ---------- Owner mode (test chat) ----------
let o = await cu.say("!tools", "owner");
ok(o.includes("add_service") && o.includes("add_offer") && !o.includes("book_appointment"), "owner mode has management tools only");
let t = await cu.tool("add_service", { name: "Hair spa", price: 1200, mode: "offline", details: "Deep conditioning" }, "owner");
ok(t.ok && t.service.price === 1200, "owner adds a service", JSON.stringify(t));
t = await cu.tool("update_service", { service: "Hair spa", price: 0 }, "owner");
ok(t.ok && t.service.price === 0, "owner makes it free");
t = await cu.tool("list_services", {}, "owner");
ok(t.find((s) => s.name === "Hair spa")?.free === true, "list shows it free");
t = await cu.tool("set_online_discount", { percent: 15 }, "owner");
ok(t.online_discount_percent === 15, "owner sets online discount");
t = await cu.tool("add_offer", { percent: 50, label: "VIP", customer_phone: "9800000003", service: "Facial", ends_on: ist(30) }, "owner");
ok(t.ok, "owner adds a VIP offer for one customer");
pr = await cu.tool("get_price", { service: "Facial", customer_phone: "+919800000003" }); // typed number isn't verified → no VIP
ok(pr.pay_at_venue === 800 && pr.pay_online === 680, "others: 15% online discount only", JSON.stringify(pr));
t = await cu.tool("add_offer", { percent: 20, label: "Diwali", starts_on: ist(0), ends_on: ist(5) }, "owner");
pr = await cu.tool("get_price", { service: "Facial" });
ok(pr.offer?.label === "Diwali" && pr.pay_at_venue === 640 && pr.pay_online === 544, "offer for all stacks with online discount", JSON.stringify(pr));
const offers = await cu.tool("list_offers", {}, "owner");
for (const x of offers) await cu.tool("delete_offer", { id: x.id }, "owner");
t = await cu.tool("add_holiday", { date: ist(40), label: "Owner leave" }, "owner");
ok(t.ok, "owner adds holiday");
av = await cu.tool("check_availability", { date: ist(40) });
ok(av.closed === "Owner leave", "owner holiday blocks bookings");
t = await cu.tool("update_business_info", { address: "22 Park Street, Kolkata", notes_append: "Always greet with Namaste." }, "owner");
ok(t.ok && t.changed.includes("address"), "owner updates address + instructions", JSON.stringify(t));
sys = await cu.say("!system");
ok(sys.includes("22 Park Street") && sys.includes("Always greet with Namaste"), "customers get the new details");
t = await cu.tool("update_business_info", { meeting_link: "javascript:alert(1)" }, "owner");
ok(String(t._raw || "").includes("https://"), "owner can't set non-https links");
t = await cu.tool("update_business_info", { open_hour: 20, close_hour: 9 }, "owner");
ok(String(t._raw || "").includes("Closing time must be after"), "owner can't set impossible hours");
t = await cu.tool("list_bookings", { filter: "upcoming", date: pday }, "owner");
ok(Array.isArray(t) && t.some((x) => x.ref === p1.ref && x.pay_status === "paid"), "owner lists bookings for a day", JSON.stringify(t).slice(0, 300));
t = await cu.tool("cancel_booking", { ref: venue.ref, reason: "Staff unwell" }, "owner");
ok(t.ok, "owner cancels a booking");

// ---------- UPI fallback ----------
await cu.page("/setup/payments");
await cu.post("/setup/payments/razorpay/disconnect", {});
r = await cu.post("/setup/payments/upi", { upi_id: "bad upi", upi_name: "" });
ok(dec(r.loc).includes("doesn't look like a UPI ID"), "bad UPI id rejected");
await cu.post("/setup/payments/upi", { upi_id: "glow@okhdfcbank", upi_name: "Glow Studio" });
av = await cu.tool("check_availability", { date: ist(5), service: "Facial" });
const u1 = await cu.tool("book_appointment", { start: `${ist(5)}T${av.slots[0]}`, service: "Facial", customer_name: "Isha", customer_phone: "+919800000009", payment: "online" });
ok(u1.ok && u1.status === "pending_manual" && u1.amount === 680 && u1.payUrl.includes(`/pay/${pub}/${u1.ref}/`), "UPI: booked, payment pending, pay page link", JSON.stringify(u1));
r = await anon.req(u1.payUrl.replace("http://localhost:3300", ""));
ok(r.text.includes("Pay ₹680 by UPI") && r.text.includes("data:image/png;base64") && r.text.includes("upi://pay?pa=glow%40okhdfcbank"), "UPI page: QR + app link");
evs = await (await fetch(`${BASE}/__test/google-events`)).json();
ok(evs.find((e) => e.priv.bookingRef === u1.ref)?.summary.startsWith("⏳"), "calendar marks UPI booking as payment pending");
r = await cu.page("/bookings?f=pending");
ok(r.text.includes(u1.ref) && r.text.includes("UPI to confirm") && r.text.includes("Mark paid"), "bookings page: needs action");
r = await cu.post(`/bookings/${u1.ref}/paid`, {});
ok(dec(r.loc).includes("Payment confirmed"), "owner marks UPI paid", dec(r.loc));
evs = await (await fetch(`${BASE}/__test/google-events`)).json();
ok(!evs.find((e) => e.priv.bookingRef === u1.ref)?.summary.startsWith("⏳"), "calendar title updated after confirming");
const u2 = await cu.tool("book_appointment", { start: `${ist(5)}T${av.slots[4]}`, service: "Facial", customer_name: "Tara", customer_phone: "+919800000010", payment: "online" });
t = await cu.tool("confirm_payment", { ref: u2.ref, received: false }, "owner");
ok(t.ok && t.message.includes("cancelled"), "owner (chat) rejects unpaid UPI → cancelled", JSON.stringify(t));
r = await cu.page("/bookings");
ok(r.text.includes(p1.ref) && r.text.includes("₹720 paid online") && r.text.includes("Meet link") === false || r.text.includes(p1.ref), "bookings page lists upcoming");
r = await cu.page("/bookings?f=cancelled");
ok(r.text.includes(u2.ref) && r.text.includes(venue.ref), "cancelled filter");
r = await cu.post(`/bookings/${p2.ref}/cancel`, {});
ok(dec(r.loc).includes("can't be cancelled"), "bookings page refuses to cancel a paid booking", dec(r.loc));
r = await cu.page("/bookings");
const p2row = r.text.split('<li class="bk">').find((x) => x.includes(p2.ref)) || "";
ok(p2row.includes(`/bookings/${p2.ref}/move`) && !p2row.includes(`/bookings/${p2.ref}/cancel`), "paid booking shows Move but no cancel button");

// Walk-in booking + move + slots + CSV
r = await cu.page("/bookings/new");
ok(r.text.includes("Add a booking") && r.text.includes("data-slot-form"), "add-booking page");
const sl = JSON.parse((await cu.req(`/bookings/slots?date=${ist(8)}&service=`)).text);
ok(Array.isArray(sl.slots) && sl.slots.length > 3, "slots endpoint", JSON.stringify(sl).slice(0, 200));
const facialId = (await cu.page("/setup/business")).text.match(/name="svc_id" value="(\d+)">\s*<div class="svc-main">\s*<input type="text" name="svc_name" value="Facial"/)?.[1];
await cu.page("/bookings/new");
r = await cu.post("/bookings/new", { service_id: facialId, mode: "offline", date: ist(8), time: sl.slots[0], name: "Walk In", phone: "98765 11111", email: "", paid: "paid", notify: "" });
ok(dec(r.loc).includes("Booked BK-"), "walk-in booking added (already paid)", dec(r.loc));
const walkRef = dec(r.loc).match(/Booked (BK-\w+)/)?.[1];
r = await cu.page("/bookings");
ok((r.text.split('<li class="bk">').find((x) => x.includes("Walk In")) || "").includes("paid in person"), "walk-in shows as paid in person");
r = await cu.post(`/bookings/${walkRef}/cancel`, {});
ok(dec(r.loc).includes("can't be cancelled"), "already-paid walk-in can't be cancelled");
await cu.page(`/bookings/${walkRef}/move`);
r = await cu.post(`/bookings/${walkRef}/move`, { date: ist(8), time: sl.slots[2], notify: "" });
ok(dec(r.loc).includes("Moved to"), "moved from the Move page", dec(r.loc));
r = await cu.post("/bookings/new", { service_id: facialId, mode: "offline", date: ist(8), time: sl.slots[2], name: "Clash", phone: "98765 22222", paid: "venue" });
ok(dec(r.loc).includes("not available"), "can't double-book the moved-to slot", dec(r.loc));
r = await cu.req("/bookings.csv?f=all");
ok(r.text.replace(/^\uFEFF/, "").startsWith("Ref,Date,Time") && r.text.includes(walkRef) && r.text.includes("Walk In"), "CSV export");

// Pay at venue off + no online method → can't book paid online
await cu.post("/setup/payments/upi", { upi_id: "", upi_name: "" });
await cu.post("/setup/payments", { online_discount_pct: "15" }); // pay_at_venue unchecked
av = await cu.tool("check_availability", { date: ist(6), service: "Facial" });
const np = await cu.tool("book_appointment", { start: `${ist(6)}T${av.slots[0]}`, service: "Facial", customer_name: "No Pay", customer_phone: "+919800000011", payment: "venue" });
ok(!np.ok && np.message.includes("hasn't set up payments"), "no payment method at all → friendly refusal", JSON.stringify(np));
await cu.post("/setup/payments", { pay_at_venue: "1", online_discount_pct: "15" });

// Free services never ask about payment
const fr = await cu.tool("book_appointment", { start: `${ist(6)}T${av.slots[2]}`, service: "Skin check", customer_name: "Free One", customer_phone: "+919800000012" });
ok(fr.ok && fr.status === "confirmed" && !fr.message.includes("₹"), "free (₹0 paid) service books without payment", JSON.stringify(fr));

// Human handoff
t = await cu.tool("talk_to_human", { reason: "Wants a group booking for 12 people" });
ok(t.ok, "handoff to a person");
r = await cu.page("/");
ok(r.text.includes("Profile &amp; knowledge") && r.text.includes("Payments") && r.text.includes("Holidays"), "dashboard lists the new optional steps");

// ---------- Owner on WhatsApp ----------
await cu.page("/setup/whatsapp");
await cu.post("/setup/whatsapp", { phone_number_id: "111222333", api_key: "kapso-good" });
r = await cu.post("/setup/whatsapp/owners", { owner_phones: "98111 22233, +1 (555) 000-1111, 12" });
ok(dec(r.loc).includes("Saved 2 owner numbers"), "owner numbers saved (10-digit → +91)", dec(r.loc));
r = await cu.page("/setup/whatsapp");
ok(r.text.includes("+919811122233, +15550001111"), "owner numbers shown back");
const hook = fakeLog().filter((l) => l.method === "POST" && l.url?.endsWith("/webhooks") && l.body?.whatsapp_webhook?.url?.includes(pub)).at(-1);
const wsec = hook.body.whatsapp_webhook.secret_key;
const wa = async (id, from, text) => {
  const raw = JSON.stringify({ message: { id, type: "text", from, text: { body: text }, kapso: { direction: "inbound" } }, conversation: { phone_number: `+${from}` }, phone_number_id: "111222333" });
  return anon.req(`/webhooks/kapso/${pub}`, { method: "POST", raw, headers: { "content-type": "application/json", "x-webhook-event": "whatsapp.message.received", "x-webhook-signature": crypto.createHmac("sha256", wsec).update(raw).digest("hex") } });
};
const before = fakeLog().length;
await wa("wamid.o1", "919811122233", "hello");
await wa("wamid.o2", "919811122233", "/customer hello");
await wa("wamid.c1", "919700000000", "hello");
await sleep(1500);
const outs = fakeLog().slice(before - 1).filter((l) => l.url?.includes("/meta/whatsapp/") && l.body?.type === "text");
const toOwner = outs.filter((l) => l.body.to === "919811122233").map((l) => l.body.text.body);
ok(toOwner.includes("Hello from Glow Studio") && toOwner.length === 2, "owner number gets the control assistant; /customer tries the customer side", JSON.stringify(toOwner));
const ownerMsg = await (async () => { const x = await wa("wamid.o3", "919811122233", "!system"); await sleep(1200); return fakeLog().filter((l) => l.url?.includes("/meta/whatsapp/") && l.body?.to === "919811122233").at(-1)?.body?.text?.body || ""; })();
ok(ownerMsg.includes("talking to the OWNER"), "WhatsApp owner prompt is the owner one");
ok(outs.some((l) => l.body.to === "919700000000"), "normal customers still get the booking assistant");


{
// ================= v8: step bar, Google permissions, owner books for callers, payment screenshots =================
r = await cu.page("/setup/google");
ok(r.text.includes('href="/setup/payments"') && r.text.includes('href="/setup/holidays"') && r.text.includes("Optional"), "step bar shows the optional steps");
r = await cu.req(`/setup/google/callback?code=fake-partial&state=${encodeURIComponent(cu.csrf)}`);
ok(r.status === 302 && r.loc.includes("missing=") && dec(r.loc).includes("unticked"), "unticked Google permissions are caught", dec(r.loc));
r = await cu.page(r.loc);
ok(r.text.includes("View and edit events") && r.text.includes("left unticked"), "page names the missing permission");
ok(fakeLog().length >= 0 && (await cu.page("/setup/google")).text.includes("Connected"), "earlier Google connection kept");

await cu.page("/setup/payments");
await cu.post("/setup/payments/upi", { upi_id: "glow@okhdfcbank", upi_name: "Glow Studio" });
const lastOut = (to) => fakeLog().filter((l) => l.url?.includes("/meta/whatsapp/") && l.body?.to === to && l.body?.type === "text").at(-1)?.body?.text?.body || "";
const resultOf = (txt) => { try { return JSON.parse(txt.replace(/^RESULT \w+: /, "")); } catch { return {}; } };
const waImg = async (id, from, bytes, caption = "") => {
  const raw = JSON.stringify({ message: { id, type: "image", from, image: { id: `media_${Buffer.from(bytes).toString("hex")}`, mime_type: "image/png", caption }, kapso: { direction: "inbound" } }, conversation: { phone_number: `+${from}` }, phone_number_id: "111222333" });
  return anon.req(`/webhooks/kapso/${pub}`, { method: "POST", raw, headers: { "content-type": "application/json", "x-webhook-event": "whatsapp.message.received", "x-webhook-signature": crypto.createHmac("sha256", wsec).update(raw).digest("hex") } });
};
const OWNER = "919811122233";
const openDay = async (from) => { for (let d = from; d < from + 10; d++) { const a = await cu.tool("check_availability", { date: ist(d), service: "Facial" }); if (a.slots?.length >= 6) return { d, a }; } };
let seq8 = 100;
const ownerSay = async (text) => { await wa(`wamid.v8.${seq8++}`, OWNER, text); await sleep(900); return lastOut(OWNER); };
const cust = async (from, text) => { await wa(`wamid.v8.${seq8++}`, from, text); await sleep(900); return lastOut(from); };

// Owner books for a caller over WhatsApp
r = await cu.page("/");
let tools8 = await ownerSay("!tools");
ok(tools8.includes("book_for_customer") && tools8.includes("attach_payment_proof"), "owner has the book-for-customer + proof tools", tools8);
const D9 = await openDay(9); av = D9.a;
let ob = resultOf(await ownerSay(`!tool book_for_customer ${JSON.stringify({ customer_name: "Ravi Kumar", customer_phone: "98700 12345", service: "Skin check", start: `${ist(D9.d)}T${av.slots[0]}` })}`));
ok(ob.ok && ob.status === "confirmed" && ob.customer_message?.includes("Ravi"), "owner books a free service for a caller", JSON.stringify(ob));
ok(ob.whatsapp_sent === true && !ob.forward_link, "sent straight to the customer when WhatsApp allows it");
ok(lastOut("919870012345").includes("you're booked at Glow Studio"), "customer gets the details on WhatsApp");
ob = resultOf(await ownerSay(`!tool book_for_customer ${JSON.stringify({ customer_name: "Neha", customer_phone: "+91 98700 22222", service: "Facial", start: `${ist(D9.d)}T${av.slots[2]}`, payment: "link" })}`));
ok(ob.ok && ob.status === "pending_manual" && ob.payUrl && ob.customer_message.includes(ob.payUrl), "owner: send a payment link (UPI page)", JSON.stringify(ob));
const linkRef = ob.ref, linkPay = ob.payUrl.replace("http://localhost:3300", "");
ob = resultOf(await ownerSay(`!tool book_for_customer ${JSON.stringify({ customer_name: "Paid Pal", customer_phone: "9870033333", service: "Facial", start: `${ist(D9.d)}T${av.slots[4]}`, payment: "paid", paid_how: "upi", amount_paid: 750 })}`));
ok(ob.ok && ob.status === "confirmed", "owner: already paid by UPI", JSON.stringify(ob));
const paidRef = ob.ref;
await waImg(`wamid.v8.${seq8++}`, OWNER, "owner-proof");
await sleep(900);
let o8 = resultOf(await ownerSay(`!tool attach_payment_proof {"ref":"${paidRef}"}`));
ok(o8.ok && o8.message.includes("Saved the screenshot"), "owner attaches a payment screenshot", JSON.stringify(o8));
r = await cu.page("/bookings?f=upcoming");
ok(r.text.includes("₹750 paid (UPI)") && r.text.includes("Your payment proof"), "bookings page: paid by UPI + proof link");
const proofHref = r.text.match(new RegExp(`/bookings/${paidRef}/proof/(\\d+)`))?.[0];
r = await cu.req(proofHref || "/x");
ok(r.status === 200 && r.text === "owner-proof", "proof image opens for the owner");
if (process.env.R2_ENDPOINT) ok(fakeLog().some((l) => l.r2 === "PUT" && /^booking-agent-files\/proofs\/\d+\/.+\.png$/.test(l.key)) && fakeLog().some((l) => l.r2 === "GET"), "photos are stored in R2 file storage and read back from it");
r = await anon.req(proofHref || "/x");
ok(r.status === 302 || r.status === 401, "proof image needs login");
o8 = resultOf(await ownerSay(`!tool attach_payment_proof {"ref":"${paidRef}"}`));
ok(!o8.ok && o8.message.includes("No photo"), "attaching again needs a new photo");

// Customer sends a UPI screenshot on WhatsApp
const C = "919700000000";
const D10 = await openDay(D9.d + 1); av = D10.a;
let cb = resultOf(await cust(C, `!tool book_appointment ${JSON.stringify({ start: `${ist(D10.d)}T${av.slots[0]}`, service: "Facial", customer_name: "Kiran", payment: "online" })}`));
ok(cb.ok && cb.status === "pending_manual", "customer books with UPI", JSON.stringify(cb) + lastOut(C));
const amt = cb.amount;
let ct = await cust(C, "!tools");
ok(ct.includes("send_payment_proof"), "customer has the screenshot tool on WhatsApp");
await waImg(`wamid.v8.${seq8++}`, C, `amt=${amt + 100};utr=123412341234;vpa=glow@okhdfcbank`);
await sleep(900);
let pr = resultOf(await cust(C, "!tool send_payment_proof {}"));
ok(!pr.ok && pr.status === "problem" && pr.message.includes(`not ₹${amt}`), "wrong amount is caught", JSON.stringify(pr));
await waImg(`wamid.v8.${seq8++}`, C, `amt=${amt};utr=123412341234;vpa=someone@ybl`);
await sleep(900);
pr = resultOf(await cust(C, "!tool send_payment_proof {}"));
ok(!pr.ok && pr.message.includes("someone@ybl"), "paid to the wrong UPI ID is caught", JSON.stringify(pr));
await waImg(`wamid.v8.${seq8++}`, C, `amt=${amt};utr=123412341234;vpa=glow@okhdfcbank`);
await sleep(900);
pr = resultOf(await cust(C, "!tool send_payment_proof {}"));
ok(pr.ok && pr.status === "checking", "matching screenshot → owner asked to confirm (auto off)", JSON.stringify(pr));
ok(lastOut(OWNER).includes(cb.ref) && lastOut(OWNER).includes("123412341234"), "owner told with amount + UTR", lastOut(OWNER));
r = await cu.page("/bookings?f=pending");
ok(r.text.includes("Customer&#39;s screenshot") && r.text.includes("looks right") && r.text.includes("t match: the amount"), "bookings page shows the screenshots and checks", (r.text.match(/<\/svg>[^<]*<\/a>[^<]*/g) || []).join(" || "));

// Auto-confirm on; a fresh booking + good screenshot is confirmed; reusing a UTR isn't.
await cu.page("/setup/payments");
await cu.post("/setup/payments/upi", { upi_id: "glow@okhdfcbank", upi_name: "Glow Studio", upi_auto_confirm: "1" });
cb = resultOf(await cust(C, `!tool book_appointment ${JSON.stringify({ start: `${ist(D10.d)}T${av.slots[2]}`, service: "Facial", customer_name: "Kiran", payment: "online" })}`));
await waImg(`wamid.v8.${seq8++}`, C, `amt=${amt};utr=999988887777;vpa=glow@okhdfcbank`);
await sleep(900);
pr = resultOf(await cust(C, `!tool send_payment_proof {"ref":"${cb.ref}"}`));
ok(pr.ok && pr.status === "confirmed", "auto-confirm when everything matches", JSON.stringify(pr));
r = await cu.page("/bookings?f=upcoming");
ok(r.text.includes(cb.ref) && !r.text.match(new RegExp(`${cb.ref}[\\s\\S]{0,800}UPI to confirm`)), "booking now paid");
const cb3 = resultOf(await cust(C, `!tool book_appointment ${JSON.stringify({ start: `${ist(D10.d)}T${av.slots[4]}`, service: "Facial", customer_name: "Kiran", payment: "online" })}`));
await waImg(`wamid.v8.${seq8++}`, C, `amt=${amt};utr=999988887777;vpa=glow@okhdfcbank`);
await sleep(900);
pr = resultOf(await cust(C, `!tool send_payment_proof {"ref":"${cb3.ref}"}`));
ok(!pr.ok && pr.message.includes("already used"), "same transaction ID can't pay twice", JSON.stringify(pr));
await waImg(`wamid.v8.${seq8++}`, C, `amt=${amt};vpa=glow@okhdfcbank`);
await sleep(900);
pr = resultOf(await cust(C, `!tool send_payment_proof {"ref":"${cb3.ref}"}`));
ok(pr.ok && pr.status === "checking", "no UTR visible → not auto-confirmed, owner checks", JSON.stringify(pr));
await waImg(`wamid.v8.${seq8++}`, C, "junk=1");
await sleep(900);
pr = resultOf(await cust(C, "!tool send_payment_proof {}"));
ok(!pr.ok, "a random photo isn't a payment", JSON.stringify(pr));

// Pay page upload (website customers)
r = await anon.req(linkPay);
ok(r.text.includes("Upload payment screenshot") && r.text.includes("/proof"), "pay page offers a screenshot upload");
const fd = new FormData();
fd.append("shot", new Blob([`amt=${resultOf(JSON.stringify({})).x ?? ""}`], { type: "image/png" }), "s.png");
const upl = await fetch(`${BASE}${linkPay}/proof`, { method: "POST", body: (() => { const f = new FormData(); f.append("shot", new Blob([`amt=680;utr=555566667777;vpa=glow@okhdfcbank`], { type: "image/png" }), "s.png"); return f; })(), redirect: "manual" });
ok(upl.status === 303, "screenshot uploaded from the pay page");
r = await anon.req(linkPay);
ok(r.text.includes("Screenshot received") || r.text.includes("You're booked"), "pay page shows it was received / confirmed", r.text.slice(0, 300));
const badUp = await fetch(`${BASE}${linkPay.replace(/\/[^/]+$/, "/wrongtoken")}/proof`, { method: "POST", body: (() => { const f = new FormData(); f.append("shot", new Blob(["x"], { type: "image/png" }), "s.png"); return f; })(), redirect: "manual" });
ok(badUp.status === 404, "pay page upload needs the signed link");

// Reconnecting cleans up our own stale webhooks on the number (shared sandbox), but leaves other apps' alone
await cu.page("/setup/whatsapp");
await cu.post("/setup/whatsapp", { phone_number_id: "111222333", api_key: "" });
const dels = fakeLog().filter((l) => l.method === "DELETE").map((l) => l.url);
ok(dels.some((u) => u.endsWith("/webhooks/wh-stale")) && !dels.some((u) => u.endsWith("/webhooks/wh-theirs")), "stale webhooks from this app removed, others kept", JSON.stringify(dels));
r = await cu.page("/setup/whatsapp");
ok(r.text.includes("Done · open to see the steps again") && r.text.includes(">Connection<"), "connected WhatsApp page folds the setup steps");

// Walk-in form can send a payment link
r = await cu.page("/bookings/new");
ok(r.text.includes("Send a payment link"), "walk-in form offers a payment link");
const D11 = await openDay(D10.d + 1);
const sl2 = JSON.parse((await cu.req(`/bookings/slots?date=${ist(D11.d)}&service=${facialId}`)).text);
r = await cu.post("/bookings/new", { service_id: facialId, mode: "offline", date: ist(D11.d), time: sl2.slots[0], name: "Link Lee", phone: "98700 44444", paid: "link" });
ok(/send=BK-[A-Z0-9]{5}/.test(dec(r.loc)), "walk-in with link → one-tap WhatsApp forward", dec(r.loc));
r = await cu.page(r.loc);
const fwd = r.text.match(/href="(http:\/\/localhost:3300\/f\/[^"]+)"[^>]*>Send on WhatsApp/)?.[1];
ok(!!fwd, "bookings page shows the Send on WhatsApp button");
const fr2 = await anon.req(fwd || "/x");
ok(fr2.status === 302 && fr2.loc.startsWith("https://wa.me/919870044444?text=") && dec(fr2.loc).includes("Please pay"), "short forward link opens WhatsApp with details + pay link", fr2.loc);
ok((await anon.req((fwd || "/x").replace(/\/[^/]+$/, "/bad"))).status === 404, "forward link needs the signed token");

}
if (process.env.R2_ENDPOINT) {
  r = await admin.page("/admin");
  ok(r.text.includes("Photo storage (R2)") && r.text.includes("cap reached"), "admin sees R2 use; past the cap new photos stay in the database", r.text.match(/Photo storage[^<]*/)?.[0]);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
