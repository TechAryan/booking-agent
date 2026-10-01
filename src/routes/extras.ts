import { Router, Request } from "express";
import multer from "multer";
import { DateTime } from "luxon";
import { checkCsrf, requireLogin } from "../auth.js";
import { claudeFor } from "../agent.js";
import { db, logActivity, Workspace } from "../db.js";
import { env } from "../env.js";
import {
  addHoliday, addKnowledge, addService, deleteHoliday, deleteKnowledge, fileToText, inr, KNOWLEDGE_MAX_CHARS, listHolidays, listKnowledge,
  listServices, mapsLink, parseHolidays, quote, SOCIALS, socialsOf, todayIn, updateKnowledge,
} from "../catalog.js";
import { calendarApi, HOLIDAY_CALENDARS, publicHolidays } from "../calendar.js";
import { book, Booking, BookingFilter, cancelBooking, checkPayment, confirmManualPayment, getBooking, isPaidLocked, listBookings, payPageUrl, reschedule, notifyCustomer, whenText } from "../bookings.js";
import { WorkspaceCalendar } from "../calendar.js";
import { razorpayReady, upiReady, verifyRazorpay } from "../payments.js";
import { crawlSite, socialPreview, summarizeBusiness } from "../importer.js";
import { getWorkspaceForUser, updateWorkspace } from "../models.js";
import { decrypt, encrypt, mask, randomToken, rateLimited } from "../security.js";
import { html, raw, Safe } from "../views/html.js";
import { icon, tile } from "../views/icons.js";
import { csrfField, page, withMsg } from "../views/layout.js";

export const extraRoutes = Router();
const docsUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 8 } });
const textUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 512 * 1024, files: 1 } });

const ws = (req: Request) => getWorkspaceForUser(req.user!.id);
const BACK = html`<nav class="stepper"><a class="back" href="/">${raw('<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>')} Dashboard</a></nav>`;
const head = (ic: string, eyebrow: string, title: string) => html`<div class="page-head">${tile(ic, "lg")}<div><p class="eyebrow">${eyebrow}</p><h1>${title}</h1></div></div>`;
const cleanUrl = (u: string) => {
  const v = String(u || "").trim().slice(0, 300);
  if (!v) return "";
  const withProto = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  try { const x = new URL(withProto); return /^https?:$/.test(x.protocol) && (x.hostname.includes(".") || process.env.ALLOW_PRIVATE_FETCH === "1") ? x.toString() : ""; } catch { return ""; }
};

// ============================================================ Profile & knowledge

extraRoutes.get("/setup/profile", requireLogin, async (req, res) => {
  const w = await ws(req);
  const socials = socialsOf(w);
  const items = await listKnowledge(w);
  const map = mapsLink(w);
  res.send(
    page(req, {
      title: "Profile & knowledge",
      body: html`${BACK}
        ${head("profile", "Optional · everything here can be left blank", "Profile & knowledge")}
        <p class="sub">Everything the assistant should know about your business: where you are, how to reach you, and any details it can use to answer questions.</p>

        <div class="card">
          <h2>${icon("pin", 18)} Contact & location</h2>
          <form method="post" action="/setup/profile" data-busy="Saving…">
            ${csrfField(req)}
            <div class="grid">
              <div><label>Business phone</label><input type="tel" name="contact_phone" value="${w.contact_phone}" placeholder="+91 98765 43210" maxlength="30"></div>
              <div><label>Business email</label><input type="email" name="contact_email" value="${w.contact_email}" placeholder="hello@yourbusiness.com" maxlength="120"></div>
            </div>
            <label>Address <span class="hint">sent to customers who book in person</span></label>
            <textarea name="address" rows="2" maxlength="400" placeholder="12 MG Road, 2nd floor, Indiranagar, Bengaluru 560038" data-address>${w.address}</textarea>
            <label>Google Maps link <span class="hint">optional · if empty we make one from your address</span></label>
            <input type="text" inputmode="url" autocapitalize="off" spellcheck="false" data-url name="maps_url" value="${w.maps_url}" placeholder="https://maps.app.goo.gl/…" maxlength="300">
            <p class="hint" data-map-preview>${map ? html`Customers will get: <a href="${map}" target="_blank" rel="noopener">${w.maps_url ? "your map link" : "a map search for your address"} ↗</a>` : "Add an address to share a map link."}</p>
            <label>Online meeting link <span class="hint">only needed without Google sign-in: your fixed Zoom / Meet room</span></label>
            <input type="text" inputmode="url" autocapitalize="off" spellcheck="false" data-url name="meeting_link" value="${w.meeting_link}" placeholder="https://meet.google.com/abc-defg-hij" maxlength="300">
            <h3>Website & social</h3>
            <div class="grid">
              <div><label>Website</label><input type="text" inputmode="url" autocapitalize="off" spellcheck="false" data-url name="website" value="${w.website}" placeholder="https://yourbusiness.com" maxlength="300"></div>
              ${SOCIALS.map(([k, l]) => html`<div><label>${l}</label><input type="text" inputmode="url" autocapitalize="off" spellcheck="false" data-url name="social_${k}" value="${socials[k] ?? ""}" placeholder="${k === "instagram" ? "https://instagram.com/yourname" : k === "youtube" ? "https://youtube.com/@yourchannel" : "https://…"}" maxlength="300"></div>`)}
            </div>
            <div class="row"><button>Save</button></div>
          </form>
        </div>

        <div class="card" id="import">
          <h2>${icon("globe", 18)} Learn from your website</h2>
          <p class="muted">We read your website (home page plus pages like About, Services, Pricing, Contact) and let Claude write notes for the assistant. We also try your social profiles, but Instagram and Facebook often hide details from anyone not logged in, so paste anything important below.</p>
          <form method="post" action="/setup/profile/import" data-busy="Reading your website… this can take a minute">
            ${csrfField(req)}
            <label>Website to read</label>
            <input type="text" inputmode="url" autocapitalize="off" spellcheck="false" data-url name="url" value="${w.website}" placeholder="https://yourbusiness.com" required>
            <div class="row"><button>${w.claude_ok ? "Import" : "Import (connect Claude first)"}</button></div>
          </form>
        </div>

        <div class="card" id="knowledge">
          <h2>${icon("file", 18)} Files & notes</h2>
          <p class="muted">Upload anything that describes your business: a price list, FAQ, menu, policies. Any language works. Accepted: .md, .txt, .csv, .html, and .json chat exports (for example, a chat where you explained your business to Claude or ChatGPT). Up to 2 MB each.</p>
          <form method="post" action="/setup/profile/files?_csrf=${req.csrf}" enctype="multipart/form-data" data-busy="Uploading…">
            <label class="dropzone" data-filedrop>
              <input type="file" name="files" multiple accept=".md,.markdown,.txt,.csv,.json,.html,.htm,text/*,application/json">
              <span class="dz-icon" aria-hidden="true">${icon("inbox", 26)}</span>
              <b data-dz-title>Drop files here</b>
              <span data-dz-sub>or click to choose</span>
            </label>
            <div class="row"><button>Upload</button></div>
          </form>
          <form method="post" action="/setup/profile/note" data-busy="Saving…" class="note-form">
            ${csrfField(req)}
            <label>Or write a note</label>
            <input type="text" name="title" placeholder="Title, e.g. Refund policy" maxlength="120">
            <textarea name="content" rows="4" maxlength="20000" placeholder="Anything customers often ask: parking, what to bring, languages you speak, cancellation policy…" required></textarea>
            <div class="row"><button class="secondary">Add note</button></div>
          </form>
          ${items.length
            ? html`<ul class="k-list">${items.map((k) => html`<li>
                <span class="tile sm" style="--tile:${k.kind === "website" ? "#007aff" : k.kind === "note" ? "#ff9500" : "#8e8e93"}">${icon(k.kind === "website" ? "globe" : k.kind === "note" ? "test" : "file", 17)}</span>
                <details class="grow"><summary><b>${k.title || k.kind}</b><small>${k.kind === "website" ? "Website import" : k.kind === "note" ? "Note" : "File"} · ${k.content.length < 1000 ? `${k.content.length} characters` : `${Math.round(k.content.length / 1000)}k characters`} · updated ${k.updated_at.slice(0, 10)}</small></summary>
                  <form method="post" action="/setup/profile/knowledge/${k.id}" data-busy="Saving…">
                    ${csrfField(req)}
                    <textarea name="content" rows="10" maxlength="${KNOWLEDGE_MAX_CHARS}">${k.content}</textarea>
                    <div class="row"><button class="small">Save changes</button></div>
                  </form>
                </details>
                <form method="post" action="/setup/profile/knowledge/${k.id}/delete" data-confirm="Remove “${k.title || k.kind}”?" data-confirm-detail="The assistant won't use it any more." data-confirm-ok="Remove">
                  ${csrfField(req)}<button class="icon-btn danger-ghost" aria-label="Remove">${icon("trash", 16)}</button>
                </form>
              </li>`)}</ul>`
            : html`<div class="empty small">${tile("file", "lg")}<b>Nothing yet</b><span>The assistant already knows your services, hours and the instructions on the Business page.</span></div>`}
        </div>`,
    })
  );
});

extraRoutes.post("/setup/profile", requireLogin, checkCsrf, async (req, res) => {
  const w = await ws(req);
  const b = req.body as Record<string, string>;
  const socials: Record<string, string> = {};
  for (const [k] of SOCIALS) { const v = cleanUrl(b[`social_${k}`] || ""); if (v) socials[k] = v; }
  const email = String(b.contact_email || "").trim().toLowerCase();
  await updateWorkspace(w.id, {
    contact_phone: String(b.contact_phone || "").replace(/[^\d+\s-]/g, "").trim().slice(0, 30),
    contact_email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "",
    address: String(b.address || "").trim().slice(0, 400),
    maps_url: cleanUrl(b.maps_url || ""),
    meeting_link: cleanUrl(b.meeting_link || ""),
    website: cleanUrl(b.website || ""),
    socials: JSON.stringify(socials),
  });
  res.redirect(withMsg("/setup/profile", "ok", "Profile saved."));
});

extraRoutes.post("/setup/profile/files", requireLogin, checkCsrf, docsUpload.array("files", 8), async (req, res) => {
  const w = await ws(req);
  const files = (req.files as Express.Multer.File[]) || [];
  if (!files.length) return res.redirect(withMsg("/setup/profile#knowledge", "err", "Choose a file first."));
  const ok: string[] = [], bad: string[] = [];
  for (const f of files) {
    if (!/\.(md|markdown|txt|csv|json|html?)$/i.test(f.originalname) && !/^text\//.test(f.mimetype)) { bad.push(f.originalname); continue; }
    try {
      const text = fileToText(f.originalname, f.buffer);
      if (!text.trim()) { bad.push(f.originalname); continue; }
      await addKnowledge(w, "file", f.originalname.replace(/\.[^.]+$/, ""), text);
      ok.push(f.originalname);
    } catch {
      bad.push(f.originalname);
    }
  }
  const msg = [ok.length ? `Added ${ok.length} file${ok.length === 1 ? "" : "s"}.` : "", bad.length ? `Couldn't read: ${bad.join(", ")} (use .md, .txt, .csv, .html or .json).` : ""].filter(Boolean).join(" ");
  res.redirect(withMsg("/setup/profile#knowledge", ok.length ? "ok" : "err", msg));
});

extraRoutes.post("/setup/profile/note", requireLogin, checkCsrf, async (req, res) => {
  const w = await ws(req);
  const content = String(req.body.content || "").trim();
  if (!content) return res.redirect(withMsg("/setup/profile#knowledge", "err", "Write something first."));
  await addKnowledge(w, "note", String(req.body.title || "").trim() || content.split("\n")[0]!.slice(0, 60), content);
  res.redirect(withMsg("/setup/profile#knowledge", "ok", "Note added."));
});

extraRoutes.post("/setup/profile/knowledge/:id", requireLogin, checkCsrf, async (req, res) => {
  await updateKnowledge(await ws(req), Number(req.params.id), String(req.body.content || ""));
  res.redirect(withMsg("/setup/profile#knowledge", "ok", "Saved."));
});

extraRoutes.post("/setup/profile/knowledge/:id/delete", requireLogin, checkCsrf, async (req, res) => {
  await deleteKnowledge(await ws(req), Number(req.params.id));
  res.redirect(withMsg("/setup/profile#knowledge", "ok", "Removed."));
});

extraRoutes.post("/setup/profile/import", requireLogin, checkCsrf, async (req, res) => {
  const w = await ws(req);
  const back = "/setup/profile#import";
  const url = cleanUrl(req.body.url || "");
  if (!url) return res.redirect(withMsg(back, "err", "Enter your website address."));
  if (!w.claude_ok) return res.redirect(withMsg("/setup/claude", "err", "Connect Claude first. It writes the notes from your website."));
  if (rateLimited(`import:${w.id}`, 6, 60 * 60_000)) return res.redirect(withMsg(back, "err", "You've imported a few times already. Try again in an hour."));
  try {
    const pages = await crawlSite(url);
    const socials = await Promise.all(Object.values(socialsOf(w)).slice(0, 5).map(async (s) => { const p = await socialPreview(s); return p ? `${s}: ${p}` : ""; }));
    const { client, model } = await claudeFor(w);
    const r = await summarizeBusiness(client, model, w, pages, socials);
    if (!r.summary) throw new Error("Couldn't find useful information on that site.");
    await db.run("DELETE FROM knowledge WHERE workspace_id=? AND kind='website' AND source_url=?", w.id, url);
    await addKnowledge(w, "website", `Website: ${new URL(url).hostname}`, r.summary, url);
    // Offer the contact details and services it found, without overwriting anything.
    const patch: Partial<Workspace> = {};
    if (!w.contact_phone && r.contact.phone) patch.contact_phone = String(r.contact.phone).slice(0, 30);
    if (!w.contact_email && r.contact.email && /@/.test(r.contact.email)) patch.contact_email = String(r.contact.email).slice(0, 120);
    if (!w.address && r.contact.address) patch.address = String(r.contact.address).slice(0, 400);
    if (!w.website) patch.website = url;
    if (Object.keys(patch).length) await updateWorkspace(w.id, patch);
    const have = new Set((await listServices(w)).map((s) => s.name.toLowerCase()));
    const suggested = r.services.filter((s) => !have.has(s.name.toLowerCase()));
    await logActivity(w.id, "setup", "", `Imported ${r.pages} page${r.pages === 1 ? "" : "s"} from ${url}`);
    if (!suggested.length) return res.redirect(withMsg("/setup/profile#knowledge", "ok", `Read ${r.pages} page${r.pages === 1 ? "" : "s"} and saved the notes below. Check them and edit anything that's wrong.`));
    res.send(
      page(req, {
        title: "Services found",
        flash: { type: "ok", text: `Read ${r.pages} page${r.pages === 1 ? "" : "s"} and saved notes for the assistant.` },
        body: html`${BACK}${head("business", "Website import", "Add these services?")}
          <p class="sub">We found these on your website. Tick the ones customers can book. You can edit them later on the Business page.</p>
          <div class="card">
            <form method="post" action="/setup/profile/add-services" data-busy="Adding…">
              ${csrfField(req)}
              <ul class="pick-list">${suggested.map((s, i) => html`<li><label class="switch-row"><input type="checkbox" name="pick" value="${i}" checked>
                <span><b>${s.name}</b><small>${s.price ? inr(s.price) : "No price found"} · ${s.mode === "online" ? "Online" : s.mode === "both" ? "Online or in person" : "In person"}${s.details ? ` · ${s.details}` : ""}</small></span></label>
                <input type="hidden" name="svc_${i}" value="${JSON.stringify(s)}"></li>`)}</ul>
              <div class="row"><button>Add selected</button><a class="btn secondary" href="/setup/profile#knowledge">Skip</a></div>
            </form>
          </div>`,
      })
    );
  } catch (e: any) {
    await logActivity(w.id, "error", "", `Website import failed: ${e.message}`);
    res.redirect(withMsg(back, "err", `Couldn't import: ${e.message}`));
  }
});

extraRoutes.post("/setup/profile/add-services", requireLogin, checkCsrf, async (req, res) => {
  const w = await ws(req);
  const picks = ([] as string[]).concat(req.body.pick || []);
  let n = 0;
  for (const i of picks) {
    try {
      const s = JSON.parse(String(req.body[`svc_${i}`] || "{}"));
      await addService(w, { name: s.name, price: s.price ?? 0, details: s.details, mode: s.mode });
      n++;
    } catch {}
  }
  res.redirect(withMsg("/setup/business", "ok", n ? `Added ${n} service${n === 1 ? "" : "s"}. Check prices and details below.` : "Nothing added."));
});

// ============================================================ Holidays

extraRoutes.get("/setup/holidays", requireLogin, async (req, res) => {
  const w = await ws(req);
  const list = await listHolidays(w, todayIn(w));
  const country = String(req.query.country || "");
  let found: { date: string; label: string }[] | null = null;
  let findErr = "";
  if (country && HOLIDAY_CALENDARS.some(([id]) => id === country)) {
    try { found = await publicHolidays(w, country); } catch (e: any) { findErr = e.message; }
  }
  const have = new Set(list.map((h) => h.date));
  const fmt = (d: string) => DateTime.fromISO(d).toFormat("ccc d LLL yyyy");
  res.send(
    page(req, {
      title: "Holidays",
      body: html`${BACK}
        ${head("holiday", "Optional", "Holidays & days off")}
        <p class="sub">No bookings are offered on these days, and customers who ask are told you're closed. All-day events in your Google Calendar called “Holiday”, “Leave”, “Closed” or “Vacation” also count automatically.</p>
        <div class="card">
          <h2>Add a day off</h2>
          <form method="post" action="/setup/holidays" data-busy="Adding…" class="grid holiday-form">
            ${csrfField(req)}
            <div><label>From</label><input type="date" name="date" required min="${todayIn(w)}"></div>
            <div><label>To <span class="hint">optional, for several days</span></label><input type="date" name="end_date" min="${todayIn(w)}"></div>
            <div><label>Name</label><input type="text" name="label" placeholder="e.g. Diwali" maxlength="80"></div>
            <div class="end"><button>Add</button></div>
          </form>
        </div>
        <div class="card">
          <h2>Upcoming (${list.length})</h2>
          ${list.length
            ? html`<ul class="hol-list">${list.map((h) => html`<li>
                <span class="hol-date"><b>${DateTime.fromISO(h.date).toFormat("d")}</b><small>${DateTime.fromISO(h.date).toFormat("LLL")}</small></span>
                <span class="grow"><b>${h.label}</b><small>${fmt(h.date)}${h.end_date ? ` → ${fmt(h.end_date)}` : ""}${h.source !== "manual" ? ` · from ${h.source}` : ""}</small></span>
                <form method="post" action="/setup/holidays/${h.id}/delete">${csrfField(req)}<button class="icon-btn danger-ghost" aria-label="Remove ${h.label}">${icon("trash", 16)}</button></form>
              </li>`)}</ul>`
            : html`<div class="empty small">${tile("holiday", "lg")}<b>No days off yet</b><span>Add them above, import public holidays, or upload a list.</span></div>`}
        </div>
        <div class="card" id="public">
          <h2>Public holidays</h2>
          ${calendarApi(w)
            ? html`<form method="get" action="/setup/holidays#public" class="row tight" data-silent>
                <select name="country" aria-label="Country">${HOLIDAY_CALENDARS.map(([id, name]) => html`<option value="${id}" ${id === (country || HOLIDAY_CALENDARS[0]![0]) ? "selected" : ""}>${name}</option>`)}</select>
                <button class="secondary">Show holidays</button>
              </form>
              ${findErr ? html`<p class="field-hint bad">${findErr}</p>` : ""}
              ${found
                ? html`<form method="post" action="/setup/holidays/import" data-busy="Adding…">
                    ${csrfField(req)}
                    <p class="muted">Tick the ones you close for.</p>
                    <ul class="pick-list">${found.map((h) => html`<li><label class="switch-row"><input type="checkbox" name="pick" value="${h.date}|${h.label}" ${have.has(h.date) ? "checked disabled" : ""}><span><b>${h.label}</b><small>${fmt(h.date)}${have.has(h.date) ? " · already added" : ""}</small></span></label></li>`)}</ul>
                    <div class="row"><button>Add selected</button></div>
                  </form>`
                : ""}`
            : html`<p class="muted">Connect Google Calendar first to load your country's holidays.</p>`}
        </div>
        <div class="card">
          <h2>Upload or paste a list</h2>
          <p class="muted">One per line, any common date format: “2026-10-20 Diwali”, “25/12/2026 Christmas”, “Holi 4 Mar 2027”, or a range “1 Nov 2026 to 5 Nov 2026 Family trip”.</p>
          <form method="post" action="/setup/holidays/text?_csrf=${req.csrf}" enctype="multipart/form-data" data-busy="Reading…">
            <textarea name="text" rows="4" placeholder="2026-10-20 Diwali&#10;25/12/2026 Christmas"></textarea>
            <label>or a .txt / .csv file</label>
            <input type="file" name="file" accept=".txt,.csv,text/plain,text/csv">
            <div class="row"><button class="secondary">Add from list</button></div>
          </form>
        </div>`,
    })
  );
});

extraRoutes.post("/setup/holidays", requireLogin, checkCsrf, async (req, res) => {
  const w = await ws(req);
  try {
    const added = await addHoliday(w, String(req.body.date || ""), String(req.body.label || "").trim() || "Holiday", String(req.body.end_date || "") || null);
    res.redirect(withMsg("/setup/holidays", "ok", added ? "Day off added." : "That day is already there."));
  } catch (e: any) {
    res.redirect(withMsg("/setup/holidays", "err", e.message));
  }
});

extraRoutes.post("/setup/holidays/import", requireLogin, checkCsrf, async (req, res) => {
  const w = await ws(req);
  let n = 0;
  for (const p of ([] as string[]).concat(req.body.pick || [])) {
    const [date, ...rest] = p.split("|");
    if (await addHoliday(w, date!, rest.join("|") || "Holiday", null, "Google").catch(() => false)) n++;
  }
  res.redirect(withMsg("/setup/holidays", "ok", `Added ${n} holiday${n === 1 ? "" : "s"}.`));
});

extraRoutes.post("/setup/holidays/text", requireLogin, checkCsrf, textUpload.single("file"), async (req, res) => {
  const w = await ws(req);
  const text = [String(req.body.text || ""), req.file ? req.file.buffer.toString("utf8") : ""].join("\n");
  const rows = parseHolidays(text);
  let n = 0;
  for (const r of rows) if (r.date >= todayIn(w) && (await addHoliday(w, r.date, r.label, r.end_date, "list").catch(() => false))) n++;
  res.redirect(withMsg("/setup/holidays", rows.length ? "ok" : "err", rows.length ? `Found ${rows.length} date${rows.length === 1 ? "" : "s"}, added ${n} upcoming.` : "Couldn't find any dates. Put one date per line."));
});

extraRoutes.post("/setup/holidays/:id/delete", requireLogin, checkCsrf, async (req, res) => {
  await deleteHoliday(await ws(req), Number(req.params.id)).catch(() => undefined);
  res.redirect(withMsg("/setup/holidays", "ok", "Removed."));
});

// ============================================================ Payments

extraRoutes.get("/setup/payments", requireLogin, async (req, res) => {
  const w = await ws(req);
  const services = await listServices(w);
  const paid = services.filter((s) => s.price > 0);
  const example = paid[0];
  const q = example ? await quote(w, example) : null;
  const rzSecret = decrypt(w.razorpay_secret_enc);
  const hookSecret = decrypt(w.razorpay_webhook_secret_enc);
  const hookUrl = `${env.publicUrl}/webhooks/razorpay/${w.public_id}`;
  res.send(
    page(req, {
      title: "Payments",
      body: html`${BACK}
        ${head("wallet", "Optional", "Payments")}
        <p class="sub">For paid services the assistant asks customers to pay online now or at your place. Free services (price 0) skip all of this.</p>
        ${!paid.length ? html`<div class="flash info">All your services are free right now. Set prices on the <a href="/setup/business">Business page</a> to take payments.</div>` : ""}

        <div class="card">
          <h2>How customers can pay</h2>
          <form method="post" action="/setup/payments" data-busy="Saving…">
            ${csrfField(req)}
            <label class="switch-row"><input type="checkbox" name="pay_at_venue" value="1" ${w.pay_at_venue ? "checked" : ""}><span><b>Allow paying at the venue / later</b><small>Turn off to require online payment for paid services.</small></span></label>
            <label>Discount for paying online <span class="hint">encourages advance payment</span></label>
            <div class="affix suffix"><input type="number" name="online_discount_pct" value="${w.online_discount_pct || ""}" min="0" max="90" step="1" placeholder="0" data-discount><span>%</span></div>
            ${q ? html`<div class="price-preview" data-price-preview data-list="${q.venue}">
                <span class="muted">Customers see, for ${example!.name}:</span>
                <b>${inr(q.venue)} at the venue</b> · <b data-online-price>${inr(q.online)} online</b>
              </div>` : ""}
            <div class="row"><button>Save</button></div>
          </form>
        </div>

        <div class="card" id="razorpay">
          <div class="page-head tight">${tile("wallet")}<div><h2>Razorpay <span class="tag">Recommended</span></h2></div></div>
          <p class="muted">Customers get a secure payment link (UPI, cards, netbanking, wallets). The booking confirms by itself the moment they pay, and money goes straight to your Razorpay account.</p>
          ${razorpayReady(w)
            ? html`<div class="done-line">${tile("check")}<span>Connected: <span class="mono">${w.razorpay_key_id}</span> ${w.razorpay_key_id.startsWith("rzp_test_") ? html`<span class="tag warn">Test mode: no real money</span>` : html`<span class="tag">Live</span>`}</span></div>
              <h3>Last step: add the webhook in Razorpay</h3>
              <ol class="guide">
                <li>Razorpay Dashboard → <b>Account & Settings → Webhooks → + Add New Webhook</b>.</li>
                <li>Webhook URL: <span class="mono" style="user-select:all">${hookUrl}</span> <button type="button" class="secondary small" data-copy="${hookUrl}">Copy</button></li>
                <li>Secret: <span class="mono" style="user-select:all">${hookSecret ?? ""}</span> <button type="button" class="secondary small" data-copy="${hookSecret ?? ""}">Copy</button></li>
                <li>Tick events <b>payment_link.paid</b>, <b>payment_link.expired</b> and <b>payment_link.cancelled</b>, then <b>Create Webhook</b>.</li>
              </ol>
              <p class="hint">Even without the webhook we check every minute, and again when a customer says they've paid. The webhook just makes it instant.</p>
              <form method="post" action="/setup/payments/razorpay/disconnect" class="row" data-confirm="Disconnect Razorpay?" data-confirm-detail="New bookings can't be paid online by link. Existing payment links stop being confirmed automatically." data-confirm-ok="Disconnect">
                ${csrfField(req)}<button class="secondary small">Disconnect</button>
              </form>`
            : html`<ol class="guide">
                <li>Sign up at <a href="https://dashboard.razorpay.com/signup" target="_blank" rel="noopener">razorpay.com</a> and finish KYC (needed for live payments; test mode works right away).</li>
                <li>Go to <b>Account & Settings → API Keys → Generate Key</b>.</li>
                <li>Paste the Key ID and Key Secret below.</li>
              </ol>
              <form method="post" action="/setup/payments/razorpay" data-busy="Checking keys…">
                ${csrfField(req)}
                <div class="grid">
                  <div><label>Key ID</label><input type="text" name="key_id" placeholder="rzp_live_…" required autocomplete="off"></div>
                  <div><label>Key Secret</label><input type="password" name="key_secret" required autocomplete="off"></div>
                </div>
                <div class="row"><button>Test and connect</button></div>
              </form>`}
        </div>

        <div class="card" id="upi">
          <div class="page-head tight">${tile("send")}<div><h2>UPI ${razorpayReady(w) ? html`<span class="tag">Backup</span>` : ""}</h2></div></div>
          <p class="muted">${razorpayReady(w) ? "Used only if Razorpay isn't connected." : "No sign-up needed."} Customers get a page with your UPI QR code and a “Pay with UPI app” button. You confirm the payment from the Bookings page, or from WhatsApp by telling the assistant “BK-… paid”.</p>
          <form method="post" action="/setup/payments/upi" data-busy="Saving…">
            ${csrfField(req)}
            <div class="grid">
              <div><label>UPI ID</label><input type="text" name="upi_id" value="${w.upi_id}" placeholder="yourname@okhdfcbank" autocomplete="off"></div>
              <div><label>Name shown to payers</label><input type="text" name="upi_name" value="${w.upi_name}" placeholder="${w.business_name || "Your business"}" maxlength="50"></div>
            </div>
            <div class="row"><button class="secondary">Save UPI</button>${upiReady(w) ? html`<span class="pill ok">Ready</span>` : ""}</div>
          </form>
        </div>
        ${rzSecret ? "" : ""}`,
    })
  );
});

extraRoutes.post("/setup/payments", requireLogin, checkCsrf, async (req, res) => {
  const w = await ws(req);
  const pct = Math.max(0, Math.min(90, Math.round(Number(req.body.online_discount_pct) || 0)));
  await updateWorkspace(w.id, { pay_at_venue: req.body.pay_at_venue === "1" ? 1 : 0, online_discount_pct: pct });
  if (req.body.pay_at_venue !== "1" && !razorpayReady(w) && !upiReady(w)) {
    return res.redirect(withMsg("/setup/payments", "err", "Saved. Note: with paying at the venue off, connect Razorpay or UPI so customers can pay."));
  }
  res.redirect(withMsg("/setup/payments", "ok", "Saved."));
});

extraRoutes.post("/setup/payments/razorpay", requireLogin, checkCsrf, async (req, res) => {
  const w = await ws(req);
  const back = "/setup/payments#razorpay";
  const keyId = String(req.body.key_id || "").trim(), secret = String(req.body.key_secret || "").trim();
  if (rateLimited(`rzp:${w.id}`, 10, 10 * 60_000)) return res.redirect(withMsg(back, "err", "Too many tries. Wait a few minutes."));
  try {
    const r = await verifyRazorpay(keyId, secret);
    await updateWorkspace(w.id, { razorpay_key_id: keyId, razorpay_secret_enc: encrypt(secret), razorpay_webhook_secret_enc: w.razorpay_webhook_secret_enc || encrypt(randomToken(18)) });
    res.redirect(withMsg(back, "ok", r.mode === "test" ? "Razorpay connected in TEST mode. Switch to live keys before real customers pay." : "Razorpay connected. Add the webhook below."));
  } catch (e: any) {
    res.redirect(withMsg(back, "err", e.message));
  }
});

extraRoutes.post("/setup/payments/razorpay/disconnect", requireLogin, checkCsrf, async (req, res) => {
  await updateWorkspace((await ws(req)).id, { razorpay_key_id: "", razorpay_secret_enc: null });
  res.redirect(withMsg("/setup/payments", "ok", "Razorpay disconnected."));
});

extraRoutes.post("/setup/payments/upi", requireLogin, checkCsrf, async (req, res) => {
  const w = await ws(req);
  const id = String(req.body.upi_id || "").trim();
  if (id && !/^[\w.\-]{2,}@[a-zA-Z][\w.]{1,}$/.test(id)) return res.redirect(withMsg("/setup/payments#upi", "err", "That doesn't look like a UPI ID (name@bank)."));
  await updateWorkspace(w.id, { upi_id: id, upi_name: String(req.body.upi_name || "").trim().slice(0, 50) });
  res.redirect(withMsg("/setup/payments#upi", "ok", id ? "UPI saved." : "UPI removed."));
});

// ============================================================ Bookings

const FILTERS: [BookingFilter, string][] = [["upcoming", "Upcoming"], ["pending", "Needs action"], ["past", "Past"], ["cancelled", "Cancelled"]];

function statusChip(b: Booking): Safe {
  if (b.status === "cancelled") return html`<span class="pill">${b.pay_status === "refund_due" ? "Cancelled · refund due" : b.pay_status === "expired" ? "Link expired" : "Cancelled"}</span>`;
  if (b.status === "held") return html`<span class="pill pay-pending"><i class="sdot"></i>Waiting for payment</span>`;
  if (b.status === "paid_unbooked") return html`<span class="pill pay-pending">Paid · needs new time</span>`;
  if (b.pay_status === "pending_manual") return html`<span class="pill pay-pending"><i class="sdot"></i>UPI to confirm</span>`;
  return html`<span class="pill ok"><i class="sdot"></i>Confirmed</span>`;
}

function payLabel(b: Booking) {
  if (b.pay_method === "free") return "Free";
  const a = inr(b.amount);
  if (b.pay_method === "venue") return b.pay_status === "paid" ? `${a} paid in person` : `${a} at venue`;
  if (b.pay_status === "paid") return `${a} paid ${b.pay_method === "upi" ? "(UPI)" : "online"}`;
  return `${a} ${b.pay_method === "upi" ? "UPI" : "online"}`;
}

extraRoutes.get("/bookings", requireLogin, async (req, res) => {
  const w = await ws(req);
  const f = (FILTERS.some(([k]) => k === req.query.f) ? req.query.f : "upcoming") as BookingFilter;
  const rows = await listBookings(w, f, 200);
  const counts = Object.fromEntries(await Promise.all(FILTERS.map(async ([k]) => [k, (await listBookings(w, k, 500)).length])));
  let lastDay = "";
  res.send(
    page(req, {
      title: "Bookings",
      wide: true,
      body: html`
        <div class="page-head spread"><div><p class="eyebrow">${w.business_name || "Your business"}</p><h1>Bookings</h1></div>
          <div class="row tight">
            <a class="btn secondary" href="/bookings.csv?f=${f}" download>Export CSV</a>
            ${w.google_ok ? html`<a class="btn" href="/bookings/new">${icon("plus", 16)} Add booking</a>` : ""}
          </div>
        </div>
        <div class="chips" role="tablist" aria-label="Filter bookings">
          ${FILTERS.map(([k, l]) => html`<a role="tab" aria-selected="${k === f ? "true" : "false"}" class="chip ${k === f ? "on" : ""} ${k === "pending" && counts[k] ? "attn" : ""}" href="/bookings?f=${k}">${l}<i>${counts[k]}</i></a>`)}
        </div>
        ${rows.length
          ? html`<div class="card list"><ul class="bk-list">${rows.map((b) => {
              const day = DateTime.fromISO(b.start_at).setZone(w.timezone).toFormat("cccc d LLLL");
              const showDay = day !== lastDay;
              lastDay = day;
              return html`${showDay ? html`<li class="bk-day">${day}</li>` : ""}<li class="bk">
                <span class="bk-time"><b>${DateTime.fromISO(b.start_at).setZone(w.timezone).toFormat("h:mm")}</b><small>${DateTime.fromISO(b.start_at).setZone(w.timezone).toFormat("a")}</small></span>
                <div class="grow">
                  <b>${b.customer_name}</b> <span class="muted">· ${b.service_name}${b.mode === "online" ? " · online" : ""}</span>
                  <small>${b.ref} · ${payLabel(b)}${b.customer_phone ? html` · <a href="https://wa.me/${b.customer_phone}" target="_blank" rel="noopener">+${b.customer_phone}</a>` : ""}${b.customer_email ? ` · ${b.customer_email}` : ""}${b.meet_link ? html` · <a href="${b.meet_link}" target="_blank" rel="noopener">Meet link</a>` : ""}</small>
                  ${b.note ? html`<small class="muted">${b.note}</small>` : ""}
                </div>
                ${statusChip(b)}
                <div class="bk-actions">
                  ${b.pay_status === "pending_manual" && b.status !== "cancelled"
                    ? html`<form method="post" action="/bookings/${b.ref}/paid">${csrfField(req)}<button class="small">Mark paid</button></form>
                      <form method="post" action="/bookings/${b.ref}/not-paid" data-confirm="Payment not received?" data-confirm-detail="${b.ref} is cancelled and ${b.customer_name} is told." data-confirm-ok="Cancel booking">${csrfField(req)}<button class="secondary small">Not received</button></form>`
                    : ""}
                  ${b.status === "held" ? html`<form method="post" action="/bookings/${b.ref}/check">${csrfField(req)}<button class="secondary small">Check payment</button></form>` : ""}
                  ${b.status === "confirmed" && f !== "past" ? html`<a class="btn secondary small" href="/bookings/${b.ref}/move">Move</a>` : ""}
                  ${b.status !== "cancelled" && f !== "past" && !isPaidLocked(b)
                    ? html`<form method="post" action="/bookings/${b.ref}/cancel" data-confirm="Cancel ${b.ref}?" data-confirm-detail="${b.customer_name} (${b.service_name}, ${DateTime.fromISO(b.start_at).setZone(w.timezone).toFormat("d LLL, h:mm a")}) is told on WhatsApp if possible.${b.pay_status === "paid" ? " They paid online: refund from your Razorpay dashboard." : ""}" data-confirm-ok="Cancel booking">${csrfField(req)}<button class="icon-btn danger-ghost" aria-label="Cancel booking">${icon("trash", 16)}</button></form>`
                    : ""}
                </div>
              </li>`;
            })}</ul></div>`
          : html`<div class="card"><div class="empty">${tile("book", "lg")}<b>${f === "upcoming" ? "No upcoming bookings" : "Nothing here"}</b><span>${f === "upcoming" ? "Bookings from WhatsApp and your website appear here as they come in." : "All clear."}</span></div></div>`}`,
    })
  );
});

async function bookingAction(req: Request, fn: (w: Workspace, b: Booking) => Promise<{ message: string }>) {
  const w = await ws(req);
  const b = await getBooking(w, String(req.params.ref));
  if (!b) return withMsg("/bookings", "err", "Booking not found.");
  try {
    const r = await fn(w, b);
    return withMsg(req.get("referer")?.includes("f=pending") ? "/bookings?f=pending" : "/bookings", "ok", r.message);
  } catch (e: any) {
    return withMsg("/bookings", "err", e.message);
  }
}

// ---- Slots for the booking forms (JSON)
extraRoutes.get("/bookings/slots", requireLogin, async (req, res) => {
  const w = await ws(req);
  const date = String(req.query.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !w.google_ok) return res.json({ slots: [] });
  const svc = (await listServices(w)).find((x) => String(x.id) === String(req.query.service));
  const ignore = req.query.ignore ? await getBooking(w, String(req.query.ignore)) : undefined;
  const minutes = ignore ? Math.round(DateTime.fromISO(ignore.end_at).diff(DateTime.fromISO(ignore.start_at), "minutes").minutes) : svc?.duration_minutes || w.slot_minutes;
  try {
    const r = await new WorkspaceCalendar(w).availableSlots(date, minutes, ignore?.id);
    res.json(r);
  } catch (e: any) {
    res.json({ slots: [], note: e.message });
  }
});

function slotPicker(w: Workspace, date: string) {
  return html`<div class="grid">
      <div><label>Date</label><input type="date" name="date" value="${date}" min="${todayIn(w)}" required data-slot-date></div>
    </div>
    <label>Time</label>
    <div class="slot-pick" data-slot-pick aria-live="polite"><span class="muted">Pick a date to see free times.</span></div>
    <input type="hidden" name="time" required data-slot-time>`;
}

// ---- Add a booking by hand (walk-ins, phone calls)
extraRoutes.get("/bookings/new", requireLogin, async (req, res) => {
  const w = await ws(req);
  if (!w.google_ok) return res.redirect(withMsg("/setup/google", "err", "Connect Google Calendar first."));
  const services = await listServices(w);
  res.send(
    page(req, {
      title: "Add booking",
      body: html`<nav class="stepper"><a class="back" href="/bookings">${raw('<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>')} Bookings</a></nav>
        ${head("book", "Walk-in or phone booking", "Add a booking")}
        <p class="sub">For customers who called or walked in. It goes into your calendar like any other booking, and blocks the slot for the assistant.</p>
        <div class="card">
          <form method="post" action="/bookings/new" data-busy="Booking…" data-slot-form>
            ${csrfField(req)}
            <div class="grid">
              <div><label>Service</label><select name="service_id" data-slot-service>${services.map((x) => html`<option value="${x.id}" data-price="${x.price}" data-mode="${x.mode}">${x.name}${x.price > 0 ? ` · ${inr(x.price)}` : " · free"}</option>`)}</select></div>
              <div data-mode-field><label>Where</label><select name="mode"><option value="offline">In person</option><option value="online">Online</option></select></div>
            </div>
            ${slotPicker(w, todayIn(w))}
            <div class="grid">
              <div><label>Customer name</label><input type="text" name="name" required maxlength="80"></div>
              <div><label>Phone</label><input type="tel" name="phone" required placeholder="+91 98765 43210"></div>
              <div><label>Email <span class="hint">optional · for the calendar invite</span></label><input type="email" name="email"></div>
            </div>
            <div data-paid-field>
              <label>Payment</label>
              <div class="segmented pay two">
                <label><input type="radio" name="paid" value="venue" checked><span>Will pay at the venue</span></label>
                <label><input type="radio" name="paid" value="paid"><span>Already paid</span></label>
              </div>
            </div>
            <label class="switch-row"><input type="checkbox" name="notify" value="1" checked><span><b>Message them on WhatsApp</b><small>Sends the booking details if WhatsApp is connected (only works if they've messaged you in the last 24 hours).</small></span></label>
            <div class="row"><button>Add booking</button></div>
          </form>
        </div>`,
    })
  );
});

extraRoutes.post("/bookings/new", requireLogin, checkCsrf, async (req, res) => {
  const w = await ws(req);
  const b = req.body as Record<string, string>;
  const phone = String(b.phone || "").replace(/\D/g, "");
  const full = phone.length === 10 ? `91${phone}` : phone;
  if (!/^\d{2}:\d{2}$/.test(b.time || "") || !/^\d{4}-\d{2}-\d{2}$/.test(b.date || "")) return res.redirect(withMsg("/bookings/new", "err", "Pick a date and a free time."));
  if (full.length < 10 || !String(b.name || "").trim()) return res.redirect(withMsg("/bookings/new", "err", "Add the customer's name and phone number."));
  const svc = (await listServices(w)).find((x) => String(x.id) === String(b.service_id));
  const r = await book(w, {
    start: `${b.date}T${b.time}`, serviceName: svc?.name, customerName: String(b.name).trim(), phone: full, email: b.email, mode: b.mode,
    payment: "venue", paidInPerson: b.paid === "paid", channel: "manual", owner: `manual:${full}`,
  });
  if (!r.ok) return res.redirect(withMsg("/bookings/new", "err", r.message));
  if (b.notify === "1") {
    const bk = await getBooking(w, r.ref);
    if (bk) await notifyCustomer(w, { ...bk, channel: "whatsapp" }, `Hi ${bk.customer_name}, you're booked at ${w.business_name}: ${r.message}`);
  }
  res.redirect(withMsg("/bookings", "ok", `Booked ${r.ref} for ${r.when}.`));
});

// ---- Move a booking (always allowed, also for paid ones)
extraRoutes.get("/bookings/:ref/move", requireLogin, async (req, res) => {
  const w = await ws(req);
  const b = await getBooking(w, String(req.params.ref));
  if (!b) return res.redirect(withMsg("/bookings", "err", "Booking not found."));
  res.send(
    page(req, {
      title: `Move ${b.ref}`,
      body: html`<nav class="stepper"><a class="back" href="/bookings">${raw('<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>')} Bookings</a></nav>
        ${head("book", b.ref, `Move ${b.customer_name}'s booking`)}
        <p class="sub">${b.service_name} · now ${whenText(w, b.start_at)}. ${b.customer_email ? "Their calendar invite updates automatically." : ""}</p>
        <div class="card">
          <form method="post" action="/bookings/${b.ref}/move" data-busy="Moving…" data-slot-form data-ignore="${b.ref}">
            ${csrfField(req)}
            ${slotPicker(w, DateTime.fromISO(b.start_at).setZone(w.timezone).toISODate()! < todayIn(w) ? todayIn(w) : DateTime.fromISO(b.start_at).setZone(w.timezone).toISODate()!)}
            <label class="switch-row"><input type="checkbox" name="notify" value="1" checked><span><b>Tell the customer</b><small>On WhatsApp, if they booked there.</small></span></label>
            <div class="row"><button>Move booking</button><a class="btn secondary" href="/bookings">Cancel</a></div>
          </form>
        </div>`,
    })
  );
});

extraRoutes.post("/bookings/:ref/move", requireLogin, checkCsrf, async (req, res) => {
  const w = await ws(req);
  const b = await getBooking(w, String(req.params.ref));
  if (!b) return res.redirect(withMsg("/bookings", "err", "Booking not found."));
  const { date, time } = req.body as Record<string, string>;
  if (!/^\d{2}:\d{2}$/.test(time || "")) return res.redirect(withMsg(`/bookings/${b.ref}/move`, "err", "Pick a free time."));
  const r = await reschedule(w, b, `${date}T${time}`);
  if (!r.ok) return res.redirect(withMsg(`/bookings/${b.ref}/move`, "err", r.message));
  if (req.body.notify === "1") await notifyCustomer(w, b, `Your ${b.service_name} booking (ref ${b.ref}) at ${w.business_name} has been moved to ${whenText(w, `${date}T${time}`)}. Reply here if that doesn't suit you.`);
  res.redirect(withMsg("/bookings", "ok", r.message));
});

// ---- CSV export
extraRoutes.get("/bookings.csv", requireLogin, async (req, res) => {
  const w = await ws(req);
  const f = (FILTERS.some(([k]) => k === req.query.f) ? req.query.f : "all") as BookingFilter;
  const rows = await listBookings(w, f === "upcoming" || f === "pending" || f === "past" || f === "cancelled" ? f : "all", 5000);
  const cell = (v: unknown) => {
    let x = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(x)) x = `'${x}`; // no spreadsheet formulas
    return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
  };
  const head = ["Ref", "Date", "Time", "Customer", "Phone", "Email", "Service", "Where", "Amount", "Payment", "Payment status", "Status", "Booked via", "Meet link"];
  const lines = rows.map((b) => {
    const d = DateTime.fromISO(b.start_at).setZone(w.timezone);
    return [b.ref, d.toISODate(), d.toFormat("HH:mm"), b.customer_name, b.customer_phone ? `+${b.customer_phone}` : "", b.customer_email, b.service_name, b.mode, b.amount, b.pay_method, b.pay_status, b.status, b.channel, b.meet_link].map(cell).join(",");
  });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="bookings-${f}-${todayIn(w)}.csv"`);
  res.send("\uFEFF" + [head.join(","), ...lines].join("\n"));
});

extraRoutes.post("/bookings/:ref/paid", requireLogin, checkCsrf, async (req, res) => res.redirect(await bookingAction(req, (w, b) => confirmManualPayment(w, b, true))));
extraRoutes.post("/bookings/:ref/not-paid", requireLogin, checkCsrf, async (req, res) => res.redirect(await bookingAction(req, (w, b) => confirmManualPayment(w, b, false))));
extraRoutes.post("/bookings/:ref/check", requireLogin, checkCsrf, async (req, res) => res.redirect(await bookingAction(req, (w, b) => checkPayment(w, b))));
extraRoutes.post("/bookings/:ref/cancel", requireLogin, checkCsrf, async (req, res) => res.redirect(await bookingAction(req, (w, b) => cancelBooking(w, b, "owner"))));

export { payPageUrl, mask };
