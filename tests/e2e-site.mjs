// Phase 3 end-to-end: the business website (AI words, editor, publish, auto-republish, photos, address).
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



// ---------- Phase 3: website ----------
const admin = new Client();
await admin.req("/login", { method: "POST", form: { email: "admin@test.com", password: "AdminPass123" } });
await admin.page("/admin/users/new");
let r = await admin.post("/admin/users/new", { name: "Tara Iyer", email: "tara@glowstudio.in", phone: "9844455566", role: "user", status: "active", valid_until: "2099-01-01", perm_widget: "1", perm_whatsapp: "1", payment_status: "paid" });
const temp = r.text.match(/id="pw"[^>]*>([^<]+)</)?.[1];
const cu = new Client();
await cu.req("/login", { method: "POST", form: { email: "tara@glowstudio.in", password: temp } });
await cu.page("/account/password?first=1");
await cu.post("/account/password", { current: temp, password: "Glow2026!site", password2: "Glow2026!site" });

r = await cu.page("/setup/website");
ok(r.text.includes("Your website") && r.text.includes("Finish your business details"), "website needs business details and AI first");

const biz = (facialPrice) => {
  const f = new URLSearchParams({ business_name: "Glow Studio", open_hour: "10", close_hour: "20", slot_minutes: "30", timezone: "Asia/Kolkata", extra_info: "" });
  ["1", "2", "3", "4", "5", "6"].forEach((d) => f.append("days", d));
  for (const [n, k, p, m] of [["Facial", "paid", facialPrice, "offline"], ["Consultation", "free", "", "both"]]) { f.append("svc_id", ""); f.append("svc_name", n); f.append("svc_kind", k); f.append("svc_price", p); f.append("svc_mode", m); f.append("svc_details", "60 minute glow"); f.append("svc_minutes", ""); }
  return f;
};
await cu.page("/setup/business");
await cu.post("/setup/business", biz("800"));
await cu.page("/setup/claude");
await cu.post("/setup/claude", { provider: "anthropic", api_key: "sk-ant-good-key-tara", model: "claude-sonnet-5-5" });
r = await cu.req("/setup/google/start");
await cu.req(r.loc.replace("http://localhost:3300", ""));
await cu.page("/setup/profile");
await cu.post("/setup/profile", { contact_phone: "+91 98444 55566", contact_email: "hi@glowstudio.in", address: "12 MG Road, Bengaluru", maps_url: "", website: "" });
await cu.page("/setup/payments");
await cu.post("/setup/payments", { pay_at_venue: "1", online_discount_pct: "10" });
await cu.page("/setup/widget");
await cu.post("/setup/widget", { enabled: "1", color: "#0f766e", greeting: "Hi" });

r = await cu.page("/setup/website");
ok(r.text.includes("Create my website") && r.text.includes("live prices"), "start page explains and offers to create");
r = await cu.post("/setup/website/create", { tone: "friendly" });
ok(dec(r.loc).includes("ready to check"), "AI wrote the website", dec(r.loc));
r = await cu.page("/setup/website");
ok(r.text.includes("Not published yet") && r.text.includes('name="headline"') && r.text.includes("Our facial treatment."), "editor shows the AI's words, service lines and status");
ok(!r.text.includes("Invented service"), "a service the AI made up is dropped");
const slug = r.text.match(/name="slug" value="([^"]+)"/)?.[1];
ok(slug === "glow-studio", "address made from the business name", slug);

r = await cu.req("/setup/website/preview");
ok(r.status === 200 && !r.text.includes("<script>alert(1)") && r.text.includes("&lt;script&gt;alert(1)&lt;/script&gt; Glow Studio"), "AI text is escaped on the page (no script can run)");
ok(r.text.includes("₹720 online · ₹800 at venue") && r.text.includes(">Free<"), "live prices with the online discount");
ok(r.text.includes("Mon–Sat, 10 am – 8 pm") && r.text.includes("12 MG Road, Bengaluru") && r.text.includes("tel:+919844455566"), "hours, address and call button from the business details");
ok(r.text.includes('"@type":"LocalBusiness"') && r.text.includes("Content-Security-Policy") && !/<script(?! type="application\/ld\+json")/.test(r.text), "Google business markup; no scripts at all");
ok(r.text.includes(`/w/`) && r.text.includes("Book now"), "book button opens the website chat (WhatsApp not connected)");
r = await cu.req(`/p/${slug}`);
ok(r.status === 404, "nothing public before publishing");

// Edit and publish
const form = (over = {}) => {
  const f = new URLSearchParams({ headline: "Glow Studio, Bengaluru", subheadline: "Facials that make you glow.", cta: "Book a slot", about: "Friendly studio on MG Road.\n\nOpen six days a week.",
    "blurb:Facial": "Deep-cleansing 60-minute facial.", "blurb:Consultation": "Free skin check.", seo_title: "Glow Studio · Facials on MG Road", seo_description: "Book a facial in Bengaluru.",
    color: "#7c3aed", hero: "color", slug, sec_services: "1", sec_about: "1", sec_gallery: "1", sec_location: "1", action: "publish", ...over });
  f.append("faq_q", "Do you take walk-ins?"); f.append("faq_a", "Yes, if a slot is free.");
  f.append("faq_q", ""); f.append("faq_a", "");
  return f;
};
r = await cu.post("/setup/website", form());
ok(dec(r.loc).includes(`Published. Your website is live at localhost:3300/p/${slug}`), "published", dec(r.loc));
const pub = await fetch(`${BASE}/p/${slug}`);
let page1 = await pub.text();
ok(pub.status === 200 && page1.includes("Glow Studio, Bengaluru") && page1.includes("--b:#7c3aed") && page1.includes("Book a slot"), "public page live with the owner's words and colour");
ok(!page1.includes('id="faq"'), "a section switched off is left out");
ok((pub.headers.get("content-security-policy") || "").includes("default-src 'none'") && pub.headers.get("cache-control") === "public, max-age=60", "public page sent with a strict CSP and short cache");
r = await cu.page("/");
ok(r.text.includes("Your website") && r.text.includes("Live · updates itself"), "dashboard shows the website as live");

// A price change republishes by itself; a draft edit doesn't leak out.
r = await cu.post("/setup/website", form({ headline: "DRAFT HEADLINE", action: "draft" }));
ok(dec(r.loc).includes("Draft saved"), "draft saved");
r = await cu.page("/setup/website");
ok(r.text.includes("you have unpublished changes"), "unpublished changes flagged");
await cu.page("/setup/business");
await cu.post("/setup/business", biz("900"));
let page2 = "";
for (let i = 0; i < 25; i++) { await sleep(300); page2 = await (await fetch(`${BASE}/p/${slug}`)).text(); if (page2.includes("₹900")) break; }
ok(page2.includes("₹810 online · ₹900 at venue"), "new price on the website within moments (auto-republish)");
ok(page2.includes("Glow Studio, Bengaluru") && !page2.includes("DRAFT HEADLINE"), "auto-republish keeps the published words, not the draft");

// Address rules
r = await cu.post("/setup/website", form({ slug: "admin", action: "draft" }));
ok(dec(r.loc).includes("isn't allowed"), "reserved address refused");
r = await cu.post("/setup/website", form({ slug: "glow-studio-mg-road" }));
ok((await fetch(`${BASE}/p/glow-studio-mg-road`)).status === 200 && (await fetch(`${BASE}/p/${slug}`)).status === 404, "address change moves the page");

// Photos
const sharp = (await import("sharp")).default;
const png = await sharp({ create: { width: 640, height: 400, channels: 3, background: "#d8b4fe" } }).png().toBuffer();
const fd = new FormData(); fd.append("photos", new Blob([png], { type: "image/png" }), "a.png"); fd.append("photos", new Blob([Buffer.from("not an image")], { type: "text/plain" }), "x.txt");
r = await cu.req(`/setup/website/photos?_csrf=${cu.csrf}`, { method: "POST", multipart: fd });
ok(dec(r.loc).includes("Added 1 photo") && dec(r.loc).includes("JPG, PNG or WebP"), "photo added; a non-image refused", dec(r.loc));
r = await cu.page("/setup/website");
const photoId = r.text.match(/\/setup\/website\/photo\/([a-f0-9]+)"/)?.[1];
ok(!!photoId && r.text.includes("Cover"), "photo listed as the cover");
r = await cu.post("/setup/website", form({ slug: "glow-studio-mg-road", hero: "photo" }));
page1 = await (await fetch(`${BASE}/p/glow-studio-mg-road`)).text();
ok(page1.includes(`/p/glow-studio-mg-road/img/${photoId}`), "published page uses the photo");
const img = await fetch(`${BASE}/p/glow-studio-mg-road/img/${photoId}`);
ok(img.status === 200 && /^image\//.test(img.headers.get("content-type") || "") && (await img.arrayBuffer()).byteLength > 100, "photo served publicly");
ok((await fetch(`${BASE}/p/glow-studio-mg-road/img/deadbeef1234`)).status === 404, "unknown photo 404");

// Rewrite, then take offline
r = await cu.post("/setup/website/rewrite", { tone: "premium" });
ok(dec(r.loc).includes("New words written"), "rewrite with AI");
r = await cu.page("/setup/website");
ok(r.text.includes("premium"), "new words in the draft");
r = await cu.post("/setup/website/unpublish", {});
ok((await fetch(`${BASE}/p/glow-studio-mg-road`)).status === 404, "taken offline");
r = await cu.page("/");
ok(!r.text.includes("Live · updates itself"), "dashboard no longer shows it live");

r = await cu.post("/setup/website", form({ slug: "glow-studio-mg-road", hero: "photo" }));
ok((await fetch(`${BASE}/p/glow-studio-mg-road`)).status === 200, "published again (left live for the edge checks)");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
