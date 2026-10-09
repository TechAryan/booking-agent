// One fast, self-contained page per business: no scripts, inline CSS, every value escaped, strict CSP.
// Prices, hours and contact details come live from the business's settings; only the words come from the AI.
import type { Workspace } from "../db.js";
import type { Quote, Service } from "../catalog.js";
import type { SiteCopy } from "./copy.js";

export interface SiteConfig {
  color: string;
  sections: { services: boolean; about: boolean; gallery: boolean; faq: boolean; location: boolean };
  photos: string[];            // photo ids, first one is the hero image
  hero: "photo" | "color";
}
export const DEFAULT_CONFIG: SiteConfig = { color: "#0f766e", sections: { services: true, about: true, gallery: true, faq: true, location: true }, photos: [], hero: "color" };
export const SITE_COLORS = ["#0f766e", "#2563eb", "#7c3aed", "#db2777", "#dc2626", "#ea580c", "#ca8a04", "#16a34a", "#0f172a"];

export function cleanConfig(x: any): SiteConfig {
  const c = { ...DEFAULT_CONFIG, ...(x && typeof x === "object" ? x : {}) };
  const s = { ...DEFAULT_CONFIG.sections, ...(c.sections ?? {}) };
  return {
    color: /^#[0-9a-f]{6}$/i.test(c.color) ? c.color.toLowerCase() : DEFAULT_CONFIG.color,
    sections: { services: !!s.services, about: !!s.about, gallery: !!s.gallery, faq: !!s.faq, location: !!s.location },
    photos: (Array.isArray(c.photos) ? c.photos : []).map(String).filter((p: string) => /^[a-z0-9]{6,40}$/.test(p)).slice(0, 8),
    hero: c.hero === "photo" ? "photo" : "color",
  };
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const paras = (s: string) => s.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const hourText = (h: number) => (h === 0 || h === 24 ? "12 am" : h === 12 ? "12 pm" : h < 12 ? `${h} am` : `${h - 12} pm`);

/** "Mon–Sat, 10 am – 8 pm" */
export function hoursText(ws: Pick<Workspace, "working_days" | "open_hour" | "close_hour">) {
  const d = ws.working_days.split(",").map(Number).filter((n) => n >= 1 && n <= 7).sort();
  const runs: string[] = [];
  for (let i = 0; i < d.length; ) {
    let j = i;
    while (j + 1 < d.length && d[j + 1] === d[j]! + 1) j++;
    runs.push(j - i >= 2 ? `${DAYS[d[i]! - 1]}–${DAYS[d[j]! - 1]}` : d.slice(i, j + 1).map((x) => DAYS[x - 1]).join(", "));
    i = j + 1;
  }
  return `${runs.join(", ") || "By appointment"}, ${hourText(ws.open_hour)} – ${hourText(ws.close_hour)}`;
}

/** Lighter/darker shades of the brand colour (no CSS colour-mix, for older phones). */
function shade(hex: string, amt: number) {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(amt < 0 ? c * (1 + amt) : c + (255 - c) * amt)));
  const r = f(n >> 16), g = f((n >> 8) & 255), b = f(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

export interface RenderInput {
  ws: Workspace;
  copy: SiteCopy;
  config: SiteConfig;
  services: (Service & { quote: Quote })[];
  slug: string;
  pageUrl: string;            // canonical address of this page
  chatUrl: string | null;     // website chat (if the widget is on)
  whatsapp: string | null;    // digits, if WhatsApp is on
  mapUrl: string;
  imgBase: string;            // e.g. "/p/glow-salon/img/"
  appName: string;
  appUrl: string;
}

export function renderSite(i: RenderInput): string {
  const { ws, copy, config: c } = i;
  const name = ws.business_name || "Our business";
  const brand = c.color, dark = shade(brand, -0.35), light = shade(brand, 0.9);
  const wa = (text: string) => `https://wa.me/${i.whatsapp}?text=${encodeURIComponent(text)}`;
  const bookHref = i.whatsapp ? wa(`Hi ${name}, I'd like to book an appointment.`) : i.chatUrl ?? (ws.contact_phone ? `tel:${ws.contact_phone.replace(/[^\d+]/g, "")}` : "#contact");
  const cta = copy.cta || "Book now";
  const tel = ws.contact_phone ? ws.contact_phone.replace(/[^\d+]/g, "") : "";
  const hero = c.photos[0] && c.hero === "photo" ? `${i.imgBase}${c.photos[0]}` : "";
  const gallery = c.photos.slice(hero ? 1 : 0);
  const blurb = new Map(copy.services.map((s) => [s.name.toLowerCase(), s.blurb]));
  const priceOf = (s: (typeof i.services)[number]) => {
    if (!(s.price > 0)) return "Free";
    const q = s.quote;
    return q.online < q.venue ? `₹${fmt(q.online)} online · ₹${fmt(q.venue)} at venue` : `₹${fmt(q.venue)}`;
  };
  const ld: Record<string, unknown> = {
    "@context": "https://schema.org", "@type": "LocalBusiness", name, url: i.pageUrl,
    description: copy.seo_description || copy.subheadline,
    ...(ws.address ? { address: ws.address } : {}),
    ...(tel ? { telephone: tel } : {}),
    ...(hero ? { image: i.pageUrl.replace(/\/p\/[^/]+$/, "") + hero } : {}),
    openingHoursSpecification: [{ "@type": "OpeningHoursSpecification", dayOfWeek: ws.working_days.split(",").map((d) => ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][Number(d) - 1]).filter(Boolean), opens: `${String(ws.open_hour).padStart(2, "0")}:00`, closes: `${String(ws.close_hour % 24).padStart(2, "0")}:00` }],
  };
  const ldJson = JSON.stringify(ld).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${esc(copy.seo_title || name)}</title>
<meta name="description" content="${esc(copy.seo_description || copy.subheadline)}">
<link rel="canonical" href="${esc(i.pageUrl)}">
<meta property="og:title" content="${esc(copy.seo_title || name)}"><meta property="og:description" content="${esc(copy.seo_description || copy.subheadline)}">
<meta property="og:type" content="website"><meta property="og:url" content="${esc(i.pageUrl)}">${hero ? `<meta property="og:image" content="${esc(i.pageUrl.replace(/\/p\/[^/]+$/, "") + hero)}">` : ""}
<meta name="theme-color" content="${brand}">
<script type="application/ld+json">${ldJson}</script>
<style>
:root{--b:${brand};--d:${dark};--l:${light};--t:#14171a;--m:#5b6470;--line:#e7e9ec;--bg:#fff;--card:#f7f8f9}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans",sans-serif;color:var(--t);background:var(--bg)}
a{color:var(--d)}img{max-width:100%;display:block}
.w{max-width:1040px;margin:0 auto;padding:0 20px}
header.top{position:sticky;top:0;z-index:5;background:rgba(255,255,255,.92);backdrop-filter:saturate(1.6) blur(10px);-webkit-backdrop-filter:saturate(1.6) blur(10px);border-bottom:1px solid var(--line)}
header.top .w{display:flex;align-items:center;gap:12px;height:60px}
.logo{font-weight:800;font-size:18px;letter-spacing:-.01em;color:var(--t);text-decoration:none;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:46px;padding:0 20px;border-radius:999px;font-weight:700;text-decoration:none;border:0;cursor:pointer;font-size:16px;white-space:nowrap}
.btn.p{background:var(--b);color:#fff}.btn.p:hover{background:var(--d)}
.btn.g{background:#fff;color:var(--d);box-shadow:inset 0 0 0 1.5px var(--line)}
.btn.s{min-height:38px;padding:0 16px;font-size:14px}
.hero{background:${hero ? `linear-gradient(180deg,rgba(0,0,0,.25),rgba(0,0,0,.6)),url("${esc(hero)}") center/cover` : `radial-gradient(1200px 400px at 80% -10%,${shade(brand, 0.35)} 0,transparent 60%),linear-gradient(135deg,var(--b),var(--d))`};color:#fff}
.hero .w{padding-top:72px;padding-bottom:72px}
.hero h1{font-size:clamp(32px,6vw,54px);line-height:1.08;letter-spacing:-.02em;margin:0 0 14px;max-width:780px}
.hero p{font-size:clamp(17px,2.4vw,20px);opacity:.92;margin:0 0 26px;max-width:640px}
.hero .acts{display:flex;flex-wrap:wrap;gap:10px}.hero .btn.g{background:rgba(255,255,255,.14);color:#fff;box-shadow:inset 0 0 0 1.5px rgba(255,255,255,.45)}
.hero .btn.p{background:#fff;color:var(--d)}
.facts{display:flex;flex-wrap:wrap;gap:8px 18px;margin-top:26px;font-size:14px;opacity:.9}
section{padding:56px 0}section+section{border-top:1px solid var(--line)}
h2{font-size:clamp(24px,3.4vw,32px);letter-spacing:-.015em;margin:0 0 22px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
.svc{background:var(--card);border-radius:18px;padding:20px;display:flex;flex-direction:column;gap:6px}
.svc h3{margin:0;font-size:18px}.svc p{margin:0;color:var(--m);font-size:15px;flex:1}
.svc .row{display:flex;align-items:center;gap:12px;margin-top:12px}.svc .pr{flex:1;min-width:0;display:flex;flex-direction:column;align-items:flex-start;gap:6px}
.price{font-weight:800;color:var(--d)}.tag{font-size:12px;font-weight:700;color:var(--d);background:var(--l);border-radius:999px;padding:3px 10px}
.about{max-width:720px;font-size:17px}.about p{margin:0 0 14px}
.gal{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}.gal img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:14px;background:var(--card)}
details{background:var(--card);border-radius:14px;padding:4px 18px;margin-bottom:10px}summary{cursor:pointer;font-weight:700;padding:12px 0;list-style:none}summary::-webkit-details-marker{display:none}
summary::after{content:"+";float:right;color:var(--m);font-weight:400}details[open] summary::after{content:"–"}details p{margin:0 0 14px;color:var(--m)}
.loc{display:grid;grid-template-columns:1fr 1fr;gap:14px}.box{background:var(--card);border-radius:18px;padding:22px}.box b{display:block;margin-bottom:6px}
footer{padding:36px 0 110px;color:var(--m);font-size:14px;text-align:center}footer a{color:var(--m)}
.bar{position:fixed;left:0;right:0;bottom:0;z-index:6;display:none;gap:10px;padding:10px 14px calc(10px + env(safe-area-inset-bottom));background:rgba(255,255,255,.96);border-top:1px solid var(--line);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}
.bar .btn{flex:1;min-width:0}
@media (max-width:720px){.bar{display:flex}header.top .btn{display:none}.loc{grid-template-columns:1fr}.hero .w{padding-top:52px;padding-bottom:56px}section{padding:44px 0}}
@media (prefers-color-scheme:dark){:root{--t:#eef0f2;--m:#a3abb5;--line:#262a30;--bg:#0f1114;--card:#181b20;--l:${shade(brand, -0.6)}}header.top,.bar{background:rgba(15,17,20,.9)}.btn.g{background:#181b20;color:#fff}a{color:${shade(brand, 0.45)}}.price,.tag{color:${shade(brand, 0.55)}}}
</style></head><body>
<header class="top"><div class="w"><a class="logo" href="#">${esc(name)}</a>${tel ? `<a class="btn g s" href="tel:${esc(tel)}">Call</a>` : ""}<a class="btn p s" href="${esc(bookHref)}">${esc(cta)}</a></div></header>
<main>
<div class="hero"><div class="w">
<h1>${esc(copy.headline || name)}</h1>
${copy.subheadline ? `<p>${esc(copy.subheadline)}</p>` : ""}
<div class="acts"><a class="btn p" href="${esc(bookHref)}">${esc(cta)}</a>${i.whatsapp && i.chatUrl ? `<a class="btn g" href="${esc(i.chatUrl)}">Chat on website</a>` : ""}${tel ? `<a class="btn g" href="tel:${esc(tel)}">Call ${esc(ws.contact_phone)}</a>` : ""}</div>
<div class="facts"><span>🕒 ${esc(hoursText(ws))}</span>${ws.address ? `<span>📍 ${esc(ws.address.split("\n")[0]!.slice(0, 80))}</span>` : ""}</div>
</div></div>
${c.sections.services && i.services.length ? `<section id="services"><div class="w"><h2>Services</h2><div class="grid">${i.services.map((s) => `<div class="svc"><h3>${esc(s.name)}</h3><p>${esc(blurb.get(s.name.toLowerCase()) || s.details.slice(0, 160))}</p><div class="row"><div class="pr"><span class="price">${esc(priceOf(s))}</span>${s.mode !== "offline" ? `<span class="tag">${s.mode === "online" ? "Online" : "Online or in person"}</span>` : ""}</div>${i.whatsapp ? `<a class="btn g s" href="${esc(wa(`Hi ${name}, I'd like to book ${s.name}.`))}">Book</a>` : ""}</div></div>`).join("")}</div></div></section>` : ""}
${c.sections.about && copy.about ? `<section id="about"><div class="w"><h2>About us</h2><div class="about">${paras(copy.about)}</div></div></section>` : ""}
${c.sections.gallery && gallery.length ? `<section id="gallery"><div class="w"><h2>Gallery</h2><div class="gal">${gallery.map((p) => `<img src="${esc(i.imgBase + p)}" alt="${esc(name)}" loading="lazy" width="400" height="300">`).join("")}</div></div></section>` : ""}
${c.sections.faq && copy.faqs.length ? `<section id="faq"><div class="w"><h2>Questions</h2>${copy.faqs.map((f) => `<details><summary>${esc(f.q)}</summary>${paras(f.a)}</details>`).join("")}</div></section>` : ""}
${c.sections.location ? `<section id="contact"><div class="w"><h2>Visit or contact us</h2><div class="loc">
<div class="box"><b>Opening hours</b>${esc(hoursText(ws))}</div>
<div class="box"><b>${ws.address ? "Address" : "Contact"}</b>${ws.address ? `${esc(ws.address).replace(/\n/g, "<br>")}${i.mapUrl ? `<br><a href="${esc(i.mapUrl)}" rel="noopener">Open in Google Maps</a>` : ""}` : ""}${tel ? `<br><a href="tel:${esc(tel)}">${esc(ws.contact_phone)}</a>` : ""}${ws.contact_email ? `<br><a href="mailto:${esc(ws.contact_email)}">${esc(ws.contact_email)}</a>` : ""}</div>
</div></div></section>` : ""}
</main>
<footer><div class="w">© ${new Date().getFullYear()} ${esc(name)} · Booking by <a href="${esc(i.appUrl)}" rel="noopener">${esc(i.appName)}</a></div></footer>
<div class="bar">${tel ? `<a class="btn g" href="tel:${esc(tel)}">Call</a>` : ""}<a class="btn p" href="${esc(bookHref)}">${esc(cta)}</a></div>
</body></html>`;
}

const fmt = (n: number) => Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 });
