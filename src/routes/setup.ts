import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import { DateTime } from "luxon";
import { checkCsrf, requireLogin } from "../auth.js";
import { reply, resetConversation } from "../agent.js";
import { aiConnection, listModels, saveAIConnection, savedKeyFor, testAI, usageThisMonth } from "../ai/registry.js";
import { DEFAULT_PROVIDER, PROVIDERS, providerById, versionLabel } from "../ai/providers.js";
import { razorpayHookMoved } from "../payments.js";
import { savedValues, saveValues, waConnection, waHookUrl, waProvider, WA_PROVIDERS } from "../wa/registry.js";
import { missingGoogleScopes, googleAuthUrl, googleExchange, googleRevoke, googleSignInEnabled, listWritableCalendars, parseServiceAccount, testCalendarFor } from "../calendar.js";
import { db, logActivity, Workspace } from "../db.js";
import { env } from "../env.js";
import { createWebhook, deleteWebhook, listOurWebhooks, verifyKapso } from "../kapso.js";
import { countPending } from "../bookings.js";
import { getWorkspaceForUser, recentActivity, updateWorkspace } from "../models.js";
import { decrypt, encrypt, mask, randomToken, rateLimited } from "../security.js";
import { esc, html, raw, Safe } from "../views/html.js";
import { icon, tile } from "../views/icons.js";
import { csrfField, page, withMsg } from "../views/layout.js";
import { stepNav } from "../views/stepper.js";
import { CAT_MODE, CATEGORIES, TEMPLATES } from "../templates.js";
import { inr, listServices, normIndian, ownerPhones, saveServices, Service } from "../catalog.js";

export const setupRoutes = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024, files: 1 } });

/** Claude versions for the admin's shared keys. */
export const MODELS = DEFAULT_PROVIDER.versions.map((v) => ({ id: v.id, label: `Claude ${v.label}${v.tag ? ` (${v.tag.toLowerCase()})` : ""}` }));

const TIMEZONES = ["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Europe/London", "America/New_York", "America/Los_Angeles", "Australia/Sydney"];

async function ws(req: Request): Promise<Workspace> {
  return await getWorkspaceForUser(req.user!.id);
}

function isReady(w: Workspace) {
  return !!(w.business_done && w.claude_ok && w.google_ok);
}

// ---------- Dashboard ----------

setupRoutes.get("/", requireLogin, async (req, res) => {
  const w = await ws(req);
  const u = req.user!;
  const services = await listServices(w);
  const anyPaid = services.some((x) => x.price > 0);
  const knowledgeN = Number((await db.get("SELECT COUNT(*) AS c FROM knowledge WHERE workspace_id=?", w.id))?.c ?? 0);
  const holidaysN = Number((await db.get("SELECT COUNT(*) AS c FROM holidays WHERE workspace_id=? AND COALESCE(end_date, date) >= date('now')", w.id))?.c ?? 0);
  const payReady = !!(w.razorpay_key_id || w.upi_id);
  const pendingN = await countPending(w);
  let today: Safe | string = "";
  if (w.google_ok) {
    const now = DateTime.now().setZone(w.timezone || "Asia/Kolkata");
    const todays = await db.all<{ ref: string; start_at: string; customer_name: string; service_name: string; mode: string; pay_status: string; status: string }>(
      "SELECT ref, start_at, customer_name, service_name, mode, pay_status, status FROM bookings WHERE workspace_id=? AND status IN ('confirmed','held') AND start_at >= ? AND start_at < ? ORDER BY start_at LIMIT 6",
      w.id, now.startOf("day").toISO()!, now.endOf("day").toISO()!
    );
    const month = Number((await db.get("SELECT COALESCE(SUM(amount),0) AS s FROM bookings WHERE workspace_id=? AND pay_status='paid' AND created_at >= ?", w.id, now.startOf("month").toUTC().toSQL({ includeOffset: false })!))?.s ?? 0);
    today = html`<div class="card today">
      <div>
        <h2>${tile("book")} Today${todays.length ? ` · ${todays.length} booking${todays.length === 1 ? "" : "s"}` : ""}</h2>
        ${todays.length
          ? html`<ul>${todays.map((b) => html`<li><b class="t">${DateTime.fromISO(b.start_at).setZone(w.timezone).toFormat("h:mm a")}</b><span class="grow">${b.customer_name} <small>· ${b.service_name}${b.mode === "online" ? " · online" : ""}${b.status === "held" ? " · awaiting payment" : b.pay_status === "pending_manual" ? " · UPI to confirm" : ""}</small></span></li>`)}</ul>`
          : html`<p class="muted">Nothing booked for today${services.length ? "" : " yet"}.</p>`}
        <div class="actions"><a class="btn small" href="/bookings">All bookings</a><a class="btn small secondary" href="/bookings/new">${icon("plus", 14)} Add booking</a>${pendingN ? html`<a class="btn small secondary attn" href="/bookings?f=pending">${pendingN} need${pendingN === 1 ? "s" : ""} action</a>` : ""}</div>
      </div>
      <div class="money">
        <span>Paid this month</span>
        <b>${inr(month)}</b>
        <span>${anyPaid ? (payReady ? "Online and confirmed payments." : "Connect payments to get paid online.") : "All your services are free."}</span>
      </div>
    </div>`;
  }
  const steps: { key: string; title: string; desc: string; done: boolean; show: boolean; optional?: boolean; extra?: boolean; href?: string }[] = [
    { key: "business", title: "Business details", desc: "Name, services, working hours", done: !!w.business_done, show: true },
    { key: "claude", title: "Connect your AI", desc: w.shared_key_id ? "Included in your plan, nothing to do" : "Claude recommended; other AIs available", done: !!w.claude_ok, show: true },
    { key: "google", title: "Connect Google Calendar", desc: "Where bookings are saved", done: !!w.google_ok, show: true },
    { key: "test", title: "Test your assistant", desc: "Chat with it and make a test booking", done: !!w.tested, show: true },
    { key: "profile", title: "Profile & knowledge", desc: knowledgeN || w.address ? `${w.address ? "Address added" : "No address yet"} · ${knowledgeN} file${knowledgeN === 1 ? "" : "s"} or notes` : "Address, map, contact, website, files so it knows your business", done: !!(w.address || w.contact_phone || knowledgeN), show: true, optional: true, extra: true },
    { key: "payments", title: "Payments", desc: payReady ? (w.razorpay_key_id ? "Razorpay connected" : "UPI set up") + (w.online_discount_pct ? ` · ${w.online_discount_pct}% online discount` : "") : anyPaid ? "You have paid services: let customers pay online" : "Online payment, pay at venue, discount", done: payReady, show: true, optional: true, extra: true },
    { key: "holidays", title: "Holidays", desc: holidaysN ? `${holidaysN} upcoming closed day${holidaysN === 1 ? "" : "s"}` : "Days you're closed: no bookings then", done: holidaysN > 0, show: true, optional: true, extra: true },
    { key: "widget", title: "Website chat widget", desc: "A booking chat on your website", done: !!w.widget_enabled, show: !!u.perm_widget, optional: true },
    { key: "website", title: "Your website", desc: w.site_live ? "Live · updates itself when prices or hours change" : "A free one-page website made from your details", done: !!w.site_live, show: true, optional: true, extra: true },
    { key: "whatsapp", title: "Connect WhatsApp", desc: "Customers book by messaging you", done: !!w.whatsapp_enabled, show: !!u.perm_whatsapp, optional: true },
    { key: "calling", title: "Calling agent", desc: w.voice_provider ? "Connected · confirmation and reminder calls" : "An AI voice that confirms and reminds by phone", done: !!w.voice_provider, show: !!u.perm_calling, optional: true, extra: true },
  ];
  const shown = steps.filter((s) => s.show);
  const core = steps.filter((s) => !s.optional);
  const coreDone = core.filter((s) => s.done).length;
  const next = shown.find((s) => !s.done && !s.extra);
  const live = [w.widget_enabled ? "Widget" : "", w.whatsapp_enabled ? "WhatsApp" : ""].filter(Boolean);
  const act = await recentActivity(w.id, 8);
  const weekBookings = Number((await db.get("SELECT COUNT(*) AS c FROM activity WHERE workspace_id=? AND kind='booking' AND channel!='test' AND created_at >= datetime('now','-7 days')", w.id))?.c ?? 0);
  const allBookings = Number((await db.get("SELECT COUNT(*) AS c FROM activity WHERE workspace_id=? AND kind='booking' AND channel!='test'", w.id))?.c ?? 0);
  const chats = Number((await db.get("SELECT COUNT(*) AS c FROM conversations WHERE workspace_id=? AND channel!='test'", w.id))?.c ?? 0);
  const pct = Math.round((coreDone / core.length) * 100);
  const R = 34, C = 2 * Math.PI * R;
  const hour = DateTime.now().setZone(w.timezone || "Asia/Kolkata").hour;
  const greet = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const kindIcon: Record<string, string> = { reschedule: "calendar", payment: "wallet", handoff: "bell", booking: "calendar", cancel: "calendar", error: "bolt", setup: "check", message: "test" };
  res.send(
    page(req, {
      title: "Dashboard",
      body: html`
        <p class="eyebrow">${greet}${firstName(u.name) ? `, ${firstName(u.name)}` : ""}</p>
        <h1>${w.business_name || "Your booking assistant"}</h1>
        ${razorpayHookMoved(w) ? html`<a class="hook-moved-banner" href="/setup/payments#webhook">${icon("bell", 15)} <span><b>Update your Razorpay webhook</b><small>Our address changed. Payments still confirm within a minute; it's a 1-minute fix to make them instant again.</small></span>${icon("chevron", 14)}</a>` : ""}
        ${u.role === "admin" && !w.business_done ? html`<div class="flash info" data-toast="info">You're an admin. Manage accounts in Admin, or set up a business here to try the product yourself.</div>` : ""}
        ${coreDone === 0 && !live.length
          ? html`<div class="card welcome">
              <h2>Get live in 4 simple steps</h2>
              <p class="muted">About 20 minutes. Every step checks your details before saving, so nothing breaks.</p>
              <ol class="journey">
                ${[["business", "Tell us about your business", "Name, services and hours"], ["claude", "Connect the AI", w.shared_key_id ? "Already included for you" : "Paste one key"], ["calendar", "Connect your calendar", "Where bookings land"], ["test", "Try it yourself", "Book a test slot"]].map(
                  ([ic, t, d], i) => html`<li style="--i:${i}" data-n="${i + 1}">${tile(ic!, "lg")}<b>${t}</b><span>${d}</span></li>`
                )}
              </ol>
              <a class="btn big" href="/setup/business">Start setup ${icon("chevron", 16)}</a>
            </div>`
          : ""}
        <div class="card hero" ${coreDone === 0 && !live.length ? html`hidden` : ""}>
          <div class="ring" style="--pct:${pct}">
            <svg viewBox="0 0 80 80" aria-hidden="true"><circle class="track" cx="40" cy="40" r="${R}"/><circle class="bar" cx="40" cy="40" r="${R}" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${C.toFixed(1)}" data-offset="${(C * (1 - pct / 100)).toFixed(1)}"/></svg>
            <b>${coreDone}<small>/${core.length}</small></b>
          </div>
          <div class="grow">
            ${live.length
              ? html`<h2><span class="live-dot"></span> Live on ${live.join(" & ")}</h2><p class="muted">Your assistant is answering customers right now.</p>`
              : coreDone === core.length
                ? html`<h2>Ready to go live</h2><p class="muted">Turn on the website widget or WhatsApp so customers can book.</p>`
                : html`<h2>${coreDone === 0 ? "Let's set up your assistant" : "Nice progress"}</h2><p class="muted">${core.length - coreDone} of ${core.length} setup steps left. About ${Math.max(5, (core.length - coreDone) * 5)} minutes.</p>`}
            ${next ? html`<a class="btn" href="/setup/${next.key}">${next.done ? "Edit" : "Continue"}: ${next.title} ${icon("chevron", 14)}</a>` : ""}
          </div>
        </div>
        <div class="stats" ${coreDone === 0 && !live.length ? html`hidden` : ""}>
          <div class="stat card"><span class="tile sm" style="--tile:#34c759">${icon("calendar", 17)}</span><b data-count="${weekBookings}">${weekBookings}</b><span>Bookings this week</span></div>
          <div class="stat card"><span class="tile sm" style="--tile:#5856d6">${icon("test", 17)}</span><b data-count="${chats}">${chats}</b><span>Conversations</span></div>
          <div class="stat card"><span class="tile sm" style="--tile:#ff9500">${icon("bolt", 17)}</span><b data-count="${allBookings}">${allBookings}</b><span>Total bookings</span></div>
        </div>
        ${today}
        <h3 class="section-title">Setup</h3>
        <div class="card list">
          <ul class="steps">
            ${shown.map(
              (s) => html`<li>
                <a class="row-link" href="/setup/${s.key}">
                  ${tile(s.key === "google" ? "calendar" : s.key === "profile" ? "profile" : s.key === "payments" ? "wallet" : s.key === "holidays" ? "holiday" : s.key === "website" ? "globe" : s.key === "calling" ? "send" : s.key)}
                  <span class="grow"><b>${s.title}</b>${s.optional ? html` <span class="tag">Optional</span>` : ""}<small>${s.desc}</small></span>
                  ${s.done ? html`<span class="state done">${icon("check", 14)} Done</span>` : s.key === next?.key ? html`<span class="state next">Next</span>` : ""}
                  <span class="chev">${icon("chevron", 16)}</span>
                </a>
              </li>`
            )}
          </ul>
        </div>
        <h3 class="section-title">Recent activity</h3>
        <div class="card list">
          ${act.length
            ? html`<ul class="feed">${act.map(
                (a) => html`<li>${tile(kindIcon[a.kind] ?? "inbox")}<span class="grow"><b>${({ booking: "New booking", cancel: "Cancelled", error: "Problem", reschedule: "Moved", payment: "Payment", handoff: "Needs you" } as Record<string, string>)[a.kind] ?? "Update"}</b><small>${a.detail}</small></span><span class="when" title="${a.created_at} UTC">${ago(a.created_at)}</span></li>`
              )}</ul>`
            : html`<div class="empty">${tile("inbox", "lg")}<b>No activity yet</b><span>Bookings and cancellations will appear here as they happen.</span></div>`}
        </div>`,
    })
  );
});

/** "Dr Priya Sharma" → "Priya"; "Aryan (Test Clinic)" → "Aryan". */
function firstName(name: string): string {
  const parts = (name || "").replace(/\(.*?\)/g, " ").trim().split(/\s+/).filter(Boolean);
  const p = parts.find((w) => !/^(dr|mr|mrs|ms|miss|prof)\.?$/i.test(w));
  return p ?? "";
}

/** "5 min ago" for a millisecond timestamp. */
function agoMs(ms: number) {
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} days ago`;
}

function ago(sqliteUtc: string): string {
  const t = DateTime.fromSQL(sqliteUtc, { zone: "utc" });
  const mins = Math.max(0, Math.round(-t.diffNow("minutes").minutes));
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
}

// ---------- Step 1: Business ----------

setupRoutes.get("/setup/business", requireLogin, async (req, res) => {
  const w = await ws(req);
  const services = await listServices(w);
  const days = new Set(w.working_days.split(",").map(Number));
  const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const hours = Array.from({ length: 24 }, (_, h) => h);
  res.send(
    page(req, {
      title: "Business details",
      body: html`${stepNav(req, "business", w)}
        <div class="page-head">${tile("business", "lg")}<div><p class="eyebrow">Required</p><h1>Business details</h1></div></div>
        <p class="sub">The assistant uses these to answer customers and to decide which slots are free.</p>
        ${quickStart(!!w.business_done)}
        <div class="card">
          <form method="post" action="/setup/business" data-busy="Saving…" id="business-form">
            ${csrfField(req)}
            <label>Business name</label>
            <input type="text" name="business_name" value="${w.business_name}" placeholder="Smile Dental Clinic" required maxlength="100">
            <input type="hidden" name="business_type" value="${w.business_type}" data-business-type>
            <label>Services <span class="hint">what customers can book. Price, online/in person and details are optional</span></label>
            ${servicesEditor(services)}
            <label>Working days</label>
            <div class="checks chips">${dayNames.map((d, i) => html`<label><input type="checkbox" name="days" value="${i + 1}" ${days.has(i + 1) ? "checked" : ""}> ${d}</label>`)}</div>
            <div class="grid">
              <div><label>Opens at</label><select name="open_hour">${hours.map((h) => html`<option value="${h}" ${h === w.open_hour ? "selected" : ""}>${fmtHour(h)}</option>`)}</select></div>
              <div><label>Closes at</label><select name="close_hour">${hours.map((h) => html`<option value="${h}" ${h === w.close_hour ? "selected" : ""}>${fmtHour(h)}</option>`)}</select></div>
              <div><label>Slot length <span class="hint">per booking</span></label><select name="slot_minutes">${[15, 20, 30, 45, 60, 90, 120].map((m) => html`<option value="${m}" ${m === w.slot_minutes ? "selected" : ""}>${m} minutes</option>`)}</select></div>
              <div><label>Time zone</label><select name="timezone">${TIMEZONES.map((t) => html`<option ${t === w.timezone ? "selected" : ""}>${t}</option>`)}</select></div>
            </div>
            <div class="slot-preview" data-slot-preview aria-live="polite"></div>
            <label>Extra information for the assistant <span class="hint">address, parking, prices it may share, what it must never do, languages</span></label>
            <textarea name="extra_info" ${TEMPLATES.some((t) => t.extra && t.extra.trim() === w.extra_info.trim()) ? html`data-tpl-fill="${w.extra_info}"` : ""} maxlength="3000" placeholder="We're at 12 MG Road, 2nd floor. Parking in the basement.&#10;Don't give medical advice.&#10;Reply in Hindi if the customer writes in Hindi.">${w.extra_info}</textarea>
            <div class="row"><button>Save and continue</button></div>
          </form>
        </div>`,
    })
  );
});


function fmtHour(h: number) {
  return DateTime.fromObject({ hour: h }).toFormat("h a");
}

setupRoutes.post("/setup/business", requireLogin, checkCsrf, async (req, res) => {
  const b = req.body as Record<string, any>;
  const days = ([] as string[]).concat(b.days || []).map(Number).filter((d) => d >= 1 && d <= 7).sort();
  const open = Number(b.open_hour), close = Number(b.close_hour);
  const back = "/setup/business";
  const rows = readServiceRows(b);
  if (!String(b.business_name || "").trim() || !rows.length) return res.redirect(withMsg(back, "err", "Add your business name and at least one service."));
  if (!days.length) return res.redirect(withMsg(back, "err", "Pick at least one working day."));
  if (!(close > open)) return res.redirect(withMsg(back, "err", "Closing time must be after opening time."));
  const w = await ws(req);
  await updateWorkspace(w.id, {
    business_name: String(b.business_name).trim().slice(0, 100),
    business_type: String(b.business_type || "").trim().slice(0, 60),
    working_days: days.join(","),
    open_hour: open,
    close_hour: close,
    slot_minutes: [15, 20, 30, 45, 60, 90, 120].includes(Number(b.slot_minutes)) ? Number(b.slot_minutes) : 30,
    timezone: TIMEZONES.includes(b.timezone) ? b.timezone : "Asia/Kolkata",
    extra_info: String(b.extra_info || "").slice(0, 3000),
    business_done: 1,
    services_migrated: 1,
  });
  await saveServices({ ...w, services_migrated: 1 }, rows);
  const after = await ws(req);
  res.redirect(withMsg(!after.claude_ok ? "/setup/claude" : !after.google_ok ? "/setup/google" : "/", "ok", "Business details saved."));
});

/** Service rows from the form (repeated fields), or the old comma-separated text. */
function readServiceRows(b: Record<string, any>) {
  const arr = (k: string) => ([] as string[]).concat(b[k] ?? []);
  const names = arr("svc_name");
  if (!names.length && b.services) return String(b.services).split(",").map((n) => ({ name: n.trim() })).filter((r) => r.name);
  const ids = arr("svc_id"), kinds = arr("svc_kind"), prices = arr("svc_price"), modes = arr("svc_mode"), details = arr("svc_details"), mins = arr("svc_minutes");
  return names.map((name, i) => ({
    id: ids[i], name, details: details[i], mode: modes[i],
    price: kinds[i] === "paid" ? prices[i] : 0, // "Paid" with no amount (or 0) is saved as free
    duration_minutes: mins[i] || null,
  })).filter((r) => String(r.name || "").trim()).slice(0, 60);
}

const MODE_LABEL = { offline: "In person", online: "Online", both: "Both" } as const;

function serviceRow(s: Partial<Service> | null) {
  const paid = !!s && (s.price ?? 0) > 0;
  return html`<div class="svc-row" data-svc-row>
    <input type="hidden" name="svc_id" value="${s?.id ?? ""}">
    <div class="svc-main">
      <input type="text" name="svc_name" value="${s?.name ?? ""}" placeholder="e.g. Consultation" maxlength="80" aria-label="Service name" class="svc-name">
      <select name="svc_kind" aria-label="Free or paid" class="svc-kind" data-svc-kind><option value="free" ${paid ? "" : "selected"}>Free</option><option value="paid" ${paid ? "selected" : ""}>Paid</option></select>
      <div class="affix svc-price" ${paid ? "" : html`hidden`} data-svc-price><span>₹</span><input type="text" name="svc_price" value="${paid ? String(s!.price) : ""}" inputmode="decimal" placeholder="500" aria-label="Price"></div>
      <select name="svc_mode" aria-label="Online or in person" class="svc-mode">${(["offline", "online", "both"] as const).map((m) => html`<option value="${m}" ${(s?.mode ?? "offline") === m ? "selected" : ""}>${MODE_LABEL[m]}</option>`)}</select>
      <button type="button" class="icon-btn" data-svc-more aria-label="Details" title="Details and length">${icon("chevron", 16)}</button>
      <button type="button" class="icon-btn danger-ghost" data-svc-remove aria-label="Remove service" title="Remove">${icon("trash", 16)}</button>
    </div>
    <div class="svc-more" hidden data-svc-details>
      <textarea name="svc_details" maxlength="1000" placeholder="Details the assistant can share: what's included, who it's for, what to bring… (optional)">${s?.details ?? ""}</textarea>
      <select name="svc_minutes" aria-label="Length">
        <option value="">Default length</option>
        ${[15, 20, 30, 45, 60, 75, 90, 120, 150, 180, 240].map((m) => html`<option value="${m}" ${s?.duration_minutes === m ? "selected" : ""}>${m < 60 ? `${m} min` : `${m / 60} hour${m === 60 ? "" : "s"}`.replace(".5 hours", "½ hours")}</option>`)}
      </select>
    </div>
  </div>`;
}

function servicesEditor(list: Service[]) {
  return html`<div class="svc-editor" data-svc-editor>
    <div class="svc-head" aria-hidden="true"><span>Service</span><span>Price</span><span></span><span>Where</span></div>
    <div data-svc-list>${(list.length ? list : [null]).map((s) => serviceRow(s))}</div>
    <template data-svc-template>${serviceRow(null)}</template>
    <button type="button" class="secondary small" data-svc-add>${icon("plus", 14)} Add service</button>
    <p class="hint">"Paid" with no price is treated as free. Online sessions get a Google Meet link when you sign in with Google.</p>
  </div>`;
}

// ---------- Step 2: AI (Claude recommended; other AIs under "Other AI options") ----------

/** Guide text: escapes everything, then allows **bold**, `code` and [links](https://…). */
function md(s: string): Safe {
  return raw(
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
      .replace(/`(.+?)`/g, "<code>$1</code>")
      .replace(/\[(.+?)\]\((https:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
  );
}

const TAG_CLASS: Record<string, string> = { Recommended: "rec", Cheaper: "cheap", Smartest: "smart" };

setupRoutes.get("/setup/ai", requireLogin, (req, res) => res.redirect(`/setup/claude${req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""}`));

setupRoutes.get("/setup/claude", requireLogin, async (req, res) => {
  const w = await ws(req);
  if (w.shared_key_id) {
    return res.send(
      page(req, {
        title: "AI",
        body: html`${stepNav(req, "claude", w)}
          <div class="page-head">${tile("claude", "lg")}<div><p class="eyebrow">Required</p><h1>Claude is included</h1></div></div>
          <div class="card provided">
            <div class="done-line big">${tile("check", "lg")}<span><b>Nothing to do here</b><small>Your plan includes the AI. Your account manager has connected it for you, and usage is covered.</small></span></div>
            <div class="row"><a class="btn" href="${w.google_ok ? "/" : "/setup/google"}">Continue ${icon("chevron", 14)}</a></div>
          </div>`,
      })
    );
  }
  const conn = await aiConnection(w);
  const p = providerById(String(req.query.p || "")) ?? conn?.provider ?? DEFAULT_PROVIDER;
  const saved = await savedKeyFor(w, p.id);
  const isCurrent = conn?.provider.id === p.id;
  const curModel = isCurrent ? conn!.model : p.versions[0]!.id;
  const custom = !p.versions.some((v) => v.id === curModel);
  const usage = conn ? await usageThisMonth(w.id) : null;
  const others = PROVIDERS.filter((x) => x.id !== DEFAULT_PROVIDER.id);
  const name = p.id === "anthropic" ? "Claude" : p.name;
  res.send(
    page(req, {
      title: "Connect your AI",
      body: html`${stepNav(req, "claude", w)}
        <div class="page-head">${tile("claude", "lg")}<div><p class="eyebrow">Required</p><h1>Connect your AI</h1></div></div>
        <p class="sub">The AI chats with your customers and books for them. You pay the AI company directly for what it uses, usually a few rupees per conversation.</p>
        ${conn
          ? html`<div class="ai-current">
              <div class="done-line">${tile("check")}<span><b>${conn.provider.id === "anthropic" ? "Claude" : conn.provider.name} · ${versionLabel(conn.provider, conn.model)}</b>
              <small>Key <span class="mono">${mask(conn.key)}</span>${w.claude_ok ? html` · <span class="pill ok">Working</span>` : ""}${usage && usage.requests ? html` · ${usage.requests} AI replies this month` : ""}</small></span></div>
            </div>`
          : ""}
        <div class="ai-pick">
          <a class="ai-rec ${p.id === "anthropic" ? "on" : ""}" href="/setup/claude?p=anthropic#connect">
            ${tile("claude", "lg")}
            <span class="grow"><b>Claude <span class="tag rec">Recommended</span></b>
            <small>Claude is our recommended AI. We test every option below before offering it.</small></span>
            ${p.id === "anthropic" ? html`<span class="sn-tick">${icon("check", 13)}</span>` : icon("chevron", 14)}
          </a>
          <details class="ai-others" ${p.id !== "anthropic" ? "open" : ""}>
            <summary>Other AI options ${icon("chevron", 13)}</summary>
            <div class="chips ai-chips">
              ${others.map((x) => html`<a class="chip ${x.id === p.id ? "on" : ""}" href="/setup/claude?p=${x.id}#connect">${x.name}${conn?.provider.id === x.id ? html` <i>connected</i>` : ""}</a>`)}
            </div>
          </details>
        </div>

        <div class="card" id="connect">
          <h2>Connect ${name}</h2>
          ${p.note ? html`<p class="ai-note">${p.note}</p>` : ""}
          <ol class="guide">${p.steps.map((s) => html`<li>${md(s)}</li>`)}</ol>
          <p class="muted small">Prices change; check <a href="${p.pricingUrl}" target="_blank" rel="noopener">${name}'s pricing page</a>.</p>
        </div>
        <div class="card">
          <form method="post" action="/setup/claude" data-busy="Running a practice booking…">
            ${csrfField(req)}
            <input type="hidden" name="provider" value="${p.id}">
            <label>${name} API key ${saved ? html`<span class="hint">saved: <span class="mono">${mask(saved)}</span> · leave empty to keep it</span>` : ""}</label>
            <input type="password" name="api_key" placeholder="${p.keyPlaceholder}" autocomplete="off" ${saved ? "" : "required"}
              data-prefix="${p.keyPrefix ?? ""}" data-who="${name}">
            <label>Version</label>
            <div class="ver-list" role="radiogroup">
              ${p.versions.map((v) => html`<label class="ver ${v.id === curModel ? "on" : ""}">
                <input type="radio" name="model" value="${v.id}" ${v.id === curModel ? "checked" : ""}>
                <span class="grow">${v.label}<small class="vid">${v.id}</small></span>
                ${v.tag ? html`<span class="tag ${TAG_CLASS[v.tag] ?? ""}">${v.tag}</span>` : ""}
              </label>`)}
              <label class="ver ${custom ? "on" : ""}">
                <input type="radio" name="model" value="other" ${custom ? "checked" : ""}>
                <span class="grow">More versions<small>Any other version your key can use</small></span>
              </label>
            </div>
            <div class="more-ver" ${custom ? "" : "hidden"}>
              <input name="model_other" list="ai-models" placeholder="Type or pick a version name" value="${custom ? curModel : ""}" autocomplete="off" spellcheck="false">
              <datalist id="ai-models"></datalist>
              <button type="button" class="secondary small" data-load-models="${p.id}">Show the versions my key can use</button>
              <p class="muted small" data-models-msg>We only list versions we can check. Others may not handle bookings well; the test below tells you.</p>
            </div>
            <p class="muted small">Test and save checks the key, then runs a practice booking (check a time → book it → reply) with pretend tools. Your calendar isn't touched.</p>
            <div class="row"><button>Test and save</button></div>
          </form>
        </div>`,
    })
  );
});

setupRoutes.post("/setup/claude", requireLogin, checkCsrf, async (req, res) => {
  const w = await ws(req);
  if (w.shared_key_id) return res.redirect(withMsg("/setup/google", "msg", "Claude is already included in your plan."));
  const p = providerById(String(req.body.provider || "anthropic"));
  if (!p) return res.redirect(withMsg("/setup/claude", "err", "Pick an AI."));
  const back = `/setup/claude?p=${p.id}`;
  const name = p.id === "anthropic" ? "Claude" : p.name;
  if (rateLimited(`claude-test:${w.id}`, Number(process.env.AI_TEST_LIMIT || 10), 10 * 60_000)) return res.redirect(withMsg(back, "err", "Too many tries. Wait a few minutes."));
  const key = String(req.body.api_key || "").trim() || (await savedKeyFor(w, p.id)) || "";
  const picked = String(req.body.model || "");
  const model = picked === "other" ? String(req.body.model_other || "").trim() : p.versions.some((v) => v.id === picked) ? picked : p.versions[0]!.id;
  if (!key) return res.redirect(withMsg(back, "err", "Paste your API key."));
  if (/\s/.test(key) || key.length < 10 || (p.id === "anthropic" && !key.startsWith("sk-ant-")))
    return res.redirect(withMsg(back, "err", p.id === "anthropic" ? "That doesn't look like a Claude key. It should start with sk-ant-" : `That doesn't look like a ${name} API key. Copy it again.`));
  if (!/^[\w.:\/@-]{2,120}$/.test(model)) return res.redirect(withMsg(back, "err", "Pick a version, or type a version name exactly as the provider shows it."));
  let note: string | null = null;
  try {
    note = (await testAI(p, key, model)).note;
  } catch (e: any) {
    return res.redirect(withMsg(back, "err", e?.message || `Couldn't reach ${name}.`));
  }
  await saveAIConnection(w, p.id, key, model);
  await logActivity(w.id, "setup", "", `AI connected: ${name} · ${versionLabel(p, model)}`);
  res.redirect(withMsg(w.google_ok ? "/" : "/setup/google", "ok", `${name} is connected and working. The practice booking went through.${note ? ` ${note}.` : ""}`));
});

/** Live version list for the "More versions" picker (uses the pasted key, or the saved one). */
setupRoutes.post("/setup/ai/models", requireLogin, checkCsrf, async (req, res) => {
  const w = await ws(req);
  const p = providerById(String(req.body.provider || ""));
  if (!p || w.shared_key_id) return res.status(400).json({ error: "Pick an AI first." });
  if (rateLimited(`ai-models:${w.id}`, 20, 10 * 60_000)) return res.status(429).json({ error: "Too many tries. Wait a few minutes." });
  const key = String(req.body.api_key || "").trim() || (await savedKeyFor(w, p.id)) || "";
  if (!key) return res.status(400).json({ error: "Paste your API key first, then press this again." });
  try {
    const models = (await listModels(p, key)).slice(0, 300);
    res.json({ models });
  } catch (e: any) {
    res.status(400).json({ error: e?.message || "Couldn't load the list." });
  }
});

// ---------- Step 3: Google Calendar ----------

setupRoutes.get("/setup/google", requireLogin, async (req, res) => {
  const w = await ws(req);
  const signIn = googleSignInEnabled();
  const viaGoogle = !!w.google_refresh_enc;
  let calendars: { id: string; name: string; primary: boolean }[] = [];
  let listError = "";
  const missing = String(req.query.missing || "").split("|").map((x) => x.trim()).filter(Boolean).slice(0, 3);
  if (viaGoogle) {
    try { calendars = await listWritableCalendars(w); } catch (e: any) { listError = /invalid_grant/i.test(e?.message) ? "Google access was removed. Sign in again." : e?.message || "Couldn't load your calendars."; }
  }
  const keyCards = html`<div class="card">
          <h2>Part A: create a key in Google Cloud</h2>
          <ol class="guide">
            <li>Open <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener">Google Cloud → New project</a>. Name it <code>booking-assistant</code> and click <b>Create</b>. Make sure it's selected in the project picker at the top.</li>
            <li>Open <a href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com" target="_blank" rel="noopener">Google Calendar API</a> and click <b>Enable</b>.</li>
            <li>Open <a href="https://console.cloud.google.com/iam-admin/serviceaccounts" target="_blank" rel="noopener">Service accounts</a> → <b>+ Create service account</b>. Name it <code>booking-bot</code>, click <b>Create and continue</b>, skip the optional steps and click <b>Done</b>.</li>
            <li>Click the new service account → <b>Keys</b> tab → <b>Add key → Create new key → JSON</b>. A file downloads. Upload it below.</li>
          </ol>
          <p class="hint">If Google says key creation is disabled, you're on a company Google account. Use a personal Gmail account instead.</p>
          <form method="post" action="/setup/google/key?_csrf=${req.csrf}" enctype="multipart/form-data" data-busy="Uploading…">
            <label class="dropzone" data-dropzone>
              <input type="file" name="keyfile" accept=".json,application/json" required>
              <span class="dz-icon" aria-hidden="true">${icon("inbox", 26)}</span>
              <b data-dz-title>${w.google_sa_email ? "Replace the key file" : "Drop the key file here"}</b>
              <span data-dz-sub>or click to choose the .json file you downloaded</span>
            </label>
            <div class="row"><button>Upload key</button></div>
          </form>
          ${w.google_sa_email ? html`<div class="done-line">${tile("check")}<span>Key uploaded for <span class="mono">${w.google_sa_email}</span></span></div>` : ""}
        </div>
        <div class="card" ${w.google_sa_email ? "" : html`style="opacity:.6"`}>
          <h2>Part B: share your calendar</h2>
          <ol class="guide">
            <li>Open <a href="https://calendar.google.com" target="_blank" rel="noopener">Google Calendar</a>. We suggest a separate calendar: left side → <b>+</b> next to "Other calendars" → <b>Create new calendar</b>, named e.g. "Bookings".</li>
            <li>Hover the calendar → <b>⋮ → Settings and sharing</b>.</li>
            <li>Under <b>Share with specific people</b>, click <b>+ Add people</b> and paste
              ${w.google_sa_email
                ? html`<span class="mono" style="user-select:all">${w.google_sa_email}</span> <button type="button" class="secondary" data-copy="${w.google_sa_email}">Copy</button>`
                : html`<i>the service account email (shown after you upload the key)</i>`}.
              Set permission to <b>Make changes to events</b> and click <b>Send</b>.</li>
            <li>Scroll to <b>Integrate calendar</b> and copy the <b>Calendar ID</b>. Paste it below.</li>
          </ol>
          <form method="post" action="/setup/google" data-busy="Checking your calendar…">
            ${csrfField(req)}
            <label>Calendar ID</label>
            <input type="text" name="calendar_id" value="${w.google_calendar_id ?? ""}" placeholder="abc123@group.calendar.google.com" required ${w.google_sa_email ? "" : "disabled"}>
            <div class="row"><button ${w.google_sa_email ? "" : "disabled"}>Test and save</button>
              ${w.google_ok ? html`<span class="pill ok">Connected</span>` : ""}</div>
          </form>
        `;
  const googleBtn = html`<a class="btn google-btn" href="/setup/google/start">${raw(GOOGLE_G)} ${viaGoogle ? "Sign in again" : "Sign in with Google"}</a>`;
  res.send(
    page(req, {
      title: "Connect Google Calendar",
      body: html`${stepNav(req, "google", w)}
        <div class="page-head">${tile("calendar", "lg")}<div><p class="eyebrow">Required</p><h1>Connect Google Calendar</h1></div></div>
        <p class="sub">Bookings go into your Google Calendar, and times you're busy there are never offered to customers.${signIn ? " Customers also get an email invite, and online sessions get a Google Meet link." : ""}</p>
        ${missing.length ? html`<div class="flash err inline">On Google's screen these were left unticked: <b>${missing.join(", ")}</b>. The assistant needs all of them. Sign in again and tick <b>Select all</b>.</div>` : ""}
        ${signIn
          ? html`<div class="card google-card">
              ${viaGoogle
                ? html`<div class="done-line big">${tile("check", "lg")}<span><b>Signed in as ${w.google_account_email || "your Google account"}</b><small>Invites and Meet links are on.</small></span></div>
                  ${listError ? html`<p class="field-hint bad">${listError}</p>${googleBtn}` : html`
                  <form method="post" action="/setup/google" data-busy="Checking your calendar…">
                    ${csrfField(req)}
                    <label>Put bookings in</label>
                    <select name="calendar_id">${calendars.map((c) => html`<option value="${c.id}" ${c.id === w.google_calendar_id || (!w.google_calendar_id && c.primary) ? "selected" : ""}>${c.name}${c.primary ? " (main calendar)" : ""}</option>`)}</select>
                    <p class="hint">Tip: a separate "Bookings" calendar keeps things tidy. Create one in Google Calendar, then reload this page.</p>
                    <div class="row"><button>${w.google_ok ? "Save" : "Use this calendar"}</button>${w.google_ok ? html`<span class="pill ok">Connected</span>` : ""}</div>
                  </form>`}
                  <form method="post" action="/setup/google/disconnect" class="row" data-confirm="Disconnect Google?" data-confirm-detail="The assistant stops booking until you connect a calendar again. Existing events stay in your calendar." data-confirm-ok="Disconnect">
                    ${csrfField(req)}<button class="secondary small">Disconnect</button>
                  </form>`
                : html`<h2>One click, no setup</h2>
                  <p class="muted">Sign in with the Google account whose calendar you use. We only ask to see your free/busy times and add booking events. We never read your email.</p>
                  <div class="consent-tip ${missing.length ? "warn" : ""}">
                    <b>On Google's permission screen, tick <u>Select all</u></b>
                    <div class="mock" aria-hidden="true">
                      <span class="all"><i class="box on"></i>Select all</span>
                      <span><i class="box on"></i>View and edit events on your calendars</span>
                      <span><i class="box on"></i>See your free/busy times</span>
                      <span><i class="box on"></i>See your list of calendars</span>
                    </div>
                    <small>Google asks you to tick these yourself (we're not allowed to pre-tick them). If one is missed, we'll tell you and you can just sign in again.</small>
                  </div>
                  <div class="row">${googleBtn}</div>
                  <details class="hint-box"><summary>Seeing “Google hasn't verified this app”?</summary><p>That's normal while our app is under Google's review. Click <b>Advanced</b>, then <b>Go to ${env.appName} (unsafe)</b>, then <b>Continue</b>. On the next screen tick <b>Select all</b>.</p></details>`}
            </div>
            <details class="card advanced-card" ${!viaGoogle && w.google_sa_email ? "open" : ""}>
              <summary><b>Use a service-account key instead</b><span class="hint">Advanced · no invites or Meet links</span></summary>
              ${keyCards}
            </details>`
          : keyCards}`,
    })
  );
});

// Multipart forms can't be CSRF-checked before multer parses them, so the token rides in the query string.
function csrfFromQuery(req: Request, res: Response, next: NextFunction) {
  req.body = { ...(req.body || {}), _csrf: req.query._csrf };
  checkCsrf(req, res, next);
}

setupRoutes.post("/setup/google/key", requireLogin, csrfFromQuery, upload.single("keyfile"), async (req, res) => {
  const back = "/setup/google";
  if (!req.file) return res.redirect(withMsg(back, "err", "Choose the JSON key file first."));
  try {
    const sa = parseServiceAccount(req.file.buffer.toString("utf8"));
    // A key file replaces Google sign-in.
    await updateWorkspace((await ws(req)).id, { google_sa_enc: encrypt(sa.json), google_sa_email: sa.email, google_ok: 0, google_refresh_enc: null, google_account_email: "" });
    res.redirect(withMsg(back, "ok", "Key uploaded. Now share your calendar with the email shown in Part B."));
  } catch (e: any) {
    res.redirect(withMsg(back, "err", e.message));
  }
});

// Sign in with Google: the state is tied to this login session, so nobody can plant their Google account on someone else's workspace.
setupRoutes.get("/setup/google/start", requireLogin, async (req, res) => {
  if (!googleSignInEnabled()) return res.redirect("/setup/google");
  const w = await ws(req);
  res.redirect(googleAuthUrl(req.csrf!, w.google_account_email || req.user!.email));
});

setupRoutes.get("/setup/google/callback", requireLogin, async (req, res) => {
  const back = "/setup/google";
  if (req.query.error) return res.redirect(withMsg(back, "err", req.query.error === "access_denied" ? "Google sign-in was cancelled." : `Google said: ${String(req.query.error).slice(0, 100)}`));
  if (!req.csrf || req.query.state !== req.csrf) return res.redirect(withMsg(back, "err", "That sign-in link expired. Please try again."));
  try {
    const t = await googleExchange(String(req.query.code || ""));
    const missing = missingGoogleScopes(t.scopes);
    if (missing.length) {
      // Google lets people untick boxes. Without all three we can't book reliably, so don't keep a half-working connection.
      await googleRevoke(t.refreshToken);
      return res.redirect(withMsg(`${back}?missing=${encodeURIComponent(missing.join("|"))}`, "err", "Some permissions were unticked. Please sign in again and tick all the boxes."));
    }
    const w = await ws(req);
    const old = decrypt(w.google_refresh_enc);
    await updateWorkspace(w.id, { google_refresh_enc: encrypt(t.refreshToken), google_account_email: t.email, google_ok: 0 });
    if (old && old !== t.refreshToken) await googleRevoke(old);
    // Pick their main calendar straight away; they can change it.
    const fresh = await ws(req);
    const cals = await listWritableCalendars(fresh);
    const pick = cals.find((c) => c.id === fresh.google_calendar_id) || cals.find((c) => c.primary) || cals[0];
    if (pick) {
      const name = await testCalendarFor(fresh, pick.id);
      await updateWorkspace(w.id, { google_calendar_id: pick.id, google_ok: 1 });
      return res.redirect(withMsg(fresh.tested ? back : "/setup/test", "ok", `Google connected. Bookings go to "${name}".`));
    }
    res.redirect(withMsg(back, "ok", "Signed in. Now choose the calendar."));
  } catch (e: any) {
    res.redirect(withMsg(back, "err", e.message || "Google sign-in failed."));
  }
});

setupRoutes.post("/setup/google/disconnect", requireLogin, checkCsrf, async (req, res) => {
  const w = await ws(req);
  const t = decrypt(w.google_refresh_enc);
  if (t) await googleRevoke(t);
  await updateWorkspace(w.id, { google_refresh_enc: null, google_account_email: "", google_ok: 0 });
  res.redirect(withMsg("/setup/google", "ok", "Google disconnected."));
});

setupRoutes.post("/setup/google", requireLogin, checkCsrf, async (req, res) => {
  const w = await ws(req);
  const back = "/setup/google";
  const calId = String(req.body.calendar_id || "").trim();
  if (!w.google_refresh_enc && !decrypt(w.google_sa_enc)) return res.redirect(withMsg(back, "err", "Connect Google first."));
  if (!calId) return res.redirect(withMsg(back, "err", "Choose or paste the calendar."));
  if (rateLimited(`google-test:${w.id}`, 15, 10 * 60_000)) return res.redirect(withMsg(back, "err", "Too many tries. Wait a few minutes."));
  try {
    const name = await testCalendarFor(w, calId);
    await updateWorkspace(w.id, { google_calendar_id: calId, google_ok: 1 });
    res.redirect(withMsg(w.tested ? "/" : "/setup/test", "ok", `Connected to "${name}".`));
  } catch (e: any) {
    await updateWorkspace(w.id, { google_calendar_id: calId, google_ok: 0 });
    res.redirect(withMsg(back, "err", e.message));
  }
});

const GOOGLE_G = '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 38.2 44 33 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';

// ---------- Step 4: Test chat ----------

function notReady(w: Workspace): Safe | null {
  if (isReady(w)) return null;
  const missing = [!w.business_done && "business details", !w.claude_ok && "the AI", !w.google_ok && "Google Calendar"].filter(Boolean).join(", ");
  return html`<div class="flash info">Finish ${missing} first.</div>`;
}

setupRoutes.get("/setup/test", requireLogin, async (req, res) => {
  const w = await ws(req);
  const block = notReady(w);
  const tomorrow = DateTime.now().setZone(w.timezone).plus({ days: 1 }).toFormat("cccc");
  const svc = (w.services.split(",")[0] || "an appointment").trim();
  res.send(
    page(req, {
      title: "Test your assistant",
      body: html`${stepNav(req, "test", w)}
        <div class="page-head">${tile("test", "lg")}<div><p class="eyebrow">Required</p><h1>Test your assistant</h1></div></div>
        <p class="sub">Chat as if you were a customer. Try these, then book a real test slot and check it appears in your calendar.</p>
        ${block ?? html`
          <div class="suggest">
            ${[
              "Hi, what services do you offer?",
              `Do you have anything free tomorrow evening?`,
              `Can I book ${svc} on ${tomorrow}? My name is Test and my number is +919999999999`,
              "What bookings do I have?",
              "Cancel my booking please",
            ].map((s) => html`<button type="button" class="secondary" data-suggest="${s}">${s}</button>`)}
          </div>
          <div class="chat-as" role="radiogroup" aria-label="Chat as">
            <span class="muted">Chat as</span>
            <div class="segmented pay two">
              <label><input type="radio" name="chat_as" value="customer" checked data-chat-as><span>A customer</span></label>
              <label><input type="radio" name="chat_as" value="owner" data-chat-as><span>The owner (you)</span></label>
            </div>
          </div>
          <p class="hint owner-hint" hidden data-owner-hint>This is what happens when you message your WhatsApp number from an owner number: try "show my services", "make Consultation ₹800", "add a 20% Diwali offer till 5 Nov", "close on 25 Dec", "what's booked tomorrow?".</p>
          <div class="chat" id="chat" data-endpoint="/setup/test/message" data-reset="/setup/test/reset" data-csrf="${req.csrf}" data-as="customer">
            <div class="msgs"></div>
            <form><input type="text" placeholder="Type a message…" autocomplete="off" maxlength="1000"><button>Send</button></form>
          </div>
          <form method="post" action="/setup/test/done" class="row">
            ${csrfField(req)}
            <button type="button" class="secondary" data-chat-reset>Start over</button>
            <button>${w.tested ? "Done" : "It works, continue"}</button>
          </form>`}`,
    })
  );
});

setupRoutes.post("/setup/test/message", requireLogin, checkCsrf, async (req, res) => {
  const w = await ws(req);
  if (!isReady(w)) return res.status(400).json({ error: "Finish the setup steps first." });
  if (rateLimited(`test-chat:${w.id}`, Number(process.env.TEST_CHAT_LIMIT || 40), 10 * 60_000)) return res.status(429).json({ error: "Slow down a little, then try again." });
  const text = String(req.body.text || "").trim();
  if (!text) return res.status(400).json({ error: "Empty message" });
  try {
    const asOwner = req.body.as === "owner";
    const before = Number((await db.get("SELECT COUNT(*) AS c FROM activity WHERE workspace_id=? AND channel='test' AND kind='booking'", w.id))?.c ?? 0);
    const out = await reply(w, "test", `user-${req.user!.id}`, text, { asOwner });
    const after = Number((await db.get("SELECT COUNT(*) AS c FROM activity WHERE workspace_id=? AND channel='test' AND kind='booking'", w.id))?.c ?? 0);
    if (after > 0 && !w.tested) await updateWorkspace(w.id, { tested: 1 });
    res.json({ reply: out, booked: after > before, firstBooking: before === 0 && after > 0 });
  } catch (e: any) {
    await logActivity(w.id, "error", "test", e.message);
    res.status(500).json({ error: `Something went wrong: ${e.message}` });
  }
});

setupRoutes.post("/setup/test/reset", requireLogin, checkCsrf, async (req, res) => {
  await resetConversation((await ws(req)).id, "test", `${req.body?.as === "owner" ? "owner:" : ""}user-${req.user!.id}`);
  res.json({ ok: true });
});

setupRoutes.post("/setup/test/done", requireLogin, checkCsrf, async (req, res) => {
  const w = await ws(req);
  if (!isReady(w)) return res.redirect("/setup/test");
  await updateWorkspace(w.id, { tested: 1 });
  res.redirect(withMsg("/", "ok", "Great! Now choose how customers reach you: the website widget, WhatsApp, or both."));
});

// ---------- Channel: Widget ----------

setupRoutes.get("/setup/widget", requireLogin, async (req, res) => {
  const w = await ws(req);
  if (!req.user!.perm_widget) return res.redirect(withMsg("/", "err", "The website widget isn't included in your plan."));
  const block = notReady(w);
  const script = `<script src="${env.publicUrl}/widget.js" data-id="${w.public_id}" async></script>`;
  const iframe = `<iframe src="${env.publicUrl}/w/${w.public_id}" style="width:100%;max-width:420px;height:620px;border:0;border-radius:12px" title="Book an appointment"></iframe>`;
  res.send(
    page(req, {
      title: "Website widget",
      body: html`${stepNav(req, "widget", w)}
        <div class="page-head">${tile("widget", "lg")}<div><p class="eyebrow">Channel · optional</p><h1>Website chat widget</h1></div></div>
        <p class="sub">Put the booking assistant on your own website. It uses the same calendar and settings.</p>
        ${block ?? html`
          <div class="card">
            <form method="post" action="/setup/widget">
              ${csrfField(req)}
              <div class="designer">
                <div class="controls">
                <div>
                  <label>Colour</label>
                  <div class="swatches" data-swatches>
                    ${["#0a84ff", "#34c759", "#ff9500", "#ff375f", "#af52de", "#5856d6", "#1d1d1f"].map((c) => html`<button type="button" class="swatch" style="--c:${c}" data-color="${c}" aria-label="Colour ${c}"></button>`)}
                    <label class="swatch custom" title="Pick any colour"><input type="color" name="color" value="${/^#[0-9a-fA-F]{6}$/.test(w.widget_color) ? w.widget_color : "#0a84ff"}" aria-label="Custom colour"></label>
                  </div>
                </div>
                <div><label>Greeting</label><input type="text" name="greeting" value="${w.widget_greeting}" maxlength="200" placeholder="Hi! Want to book an appointment?" data-preview-greeting></div>
              <div class="checks" style="margin-top:18px"><label><input type="checkbox" name="enabled" value="1" ${w.widget_enabled ? "checked" : ""}> Widget is live on my website</label></div>
              <div class="row"><button>Save</button> <a class="btn secondary" href="/w/${w.public_id}" target="_blank">Open full preview</a></div>
                </div>
                <div class="preview-col">
                  <label>Live preview</label>
              <div class="widget-preview" data-widget-preview style="--accent:${/^#[0-9a-fA-F]{6}$/.test(w.widget_color) ? w.widget_color : "#0a84ff"}">
                <div class="wp-head"><span class="wp-av">${(w.business_name || "B").trim().charAt(0).toUpperCase()}</span><div><b>${w.business_name}</b><small>Usually replies instantly</small></div></div>
                <div class="wp-body">
                  <div class="wp-b" data-greeting-out>${w.widget_greeting || `Hi! I can help you book an appointment at ${w.business_name}. What would you like?`}</div>
                  <div class="wp-u">Anything free tomorrow evening?</div>
                  <div class="wp-b"><span class="typing"><i></i><i></i><i></i></span></div>
                </div>
                <span class="wp-fab">${icon("test", 22)}</span>
              </div>
                </div>
              </div>
            </form>
          </div>
          ${w.widget_enabled
            ? html`<div class="card">
                <h2>Option 1: floating chat button (recommended)</h2>
                <p class="muted">Paste this just before <code>&lt;/body&gt;</code> on every page where you want the chat.</p>
                <pre>${script}</pre><button type="button" class="secondary" data-copy="${script}">Copy code</button>
                <h2 style="margin-top:20px">Option 2: chat inside a page</h2>
                <p class="muted">Paste this where the chat should appear, for example on a "Book now" page.</p>
                <pre>${iframe}</pre><button type="button" class="secondary" data-copy="${iframe}">Copy code</button>
                <h2 style="margin-top:20px">Direct link</h2>
                <p class="muted">Share it on Instagram, Google Maps or anywhere else.</p>
                <pre>${env.publicUrl}/w/${w.public_id}</pre>
              </div>`
            : ""}`}`,
    })
  );
});

setupRoutes.post("/setup/widget", requireLogin, checkCsrf, async (req, res) => {
  const w = await ws(req);
  if (!req.user!.perm_widget || !isReady(w)) return res.redirect("/setup/widget");
  const color = /^#[0-9a-fA-F]{6}$/.test(req.body.color) ? req.body.color : "#16a34a";
  await updateWorkspace(w.id, {
    widget_color: color,
    widget_greeting: String(req.body.greeting || "").slice(0, 200),
    widget_enabled: req.body.enabled === "1" ? 1 : 0,
  });
  res.redirect(withMsg("/setup/widget", "ok", req.body.enabled === "1" ? "Widget is live. Copy the code below." : "Saved. The widget is off."));
});

// ---------- Channel: WhatsApp ----------

setupRoutes.get("/setup/whatsapp", requireLogin, async (req, res) => {
  const w = await ws(req);
  if (!req.user!.perm_whatsapp) return res.redirect(withMsg("/", "err", "WhatsApp isn't included in your plan."));
  const block = notReady(w);
  const conn = w.whatsapp_enabled ? await waConnection(w) : null;
  const current = conn?.provider.id ?? w.wa_provider ?? "kapso";
  const p = waProvider(String(req.query.p || "")) ?? waProvider(current) ?? WA_PROVIDERS[0]!;
  const others = WA_PROVIDERS.filter((x) => x.id !== "kapso");
  const live = !!conn && conn.provider.id === p.id;
  const key = decrypt(w.kapso_key_enc);
  const status = conn
    ? w.wa_hook_at
      ? html`<p class="hook-status ok">${icon("check", 14)} <b>Receiving messages</b> · last one ${agoMs(w.wa_hook_at)}</p>`
      : html`<p class="hook-status wait">${icon("clock", 14)} <b>Waiting for the first message.</b> Send one from your phone to check.</p>`
    : "";
  let section: Safe;
  if (p.id === "kapso") {
    section = html`
      <details class="card advanced-card" ${live ? "" : "open"}>
        <summary><b>Part A: create a Kapso account and connect a number</b>${live ? html`<span class="hint">Done · open to see the steps again</span>` : ""}</summary>
        <ol class="guide">
          <li>Sign up at <a href="https://app.kapso.ai" target="_blank" rel="noopener">app.kapso.ai</a>.</li>
          <li>Go to <b>Phone numbers</b> → <b>Set up</b>. You need a Facebook account for the next part. Then choose one:
            <ul>
              <li><b>Instant setup with US digital number</b>: fastest, no SIM needed. Your customers see a +1 number.</li>
              <li><b>Connect my own SIM card</b>: use your own number. It must <u>not</u> be active on the normal WhatsApp app. You'll get a text code to verify it.</li>
              <li><b>Connect WhatsApp Business App</b>: keep using the Business app on your phone, and the assistant replies too.</li>
            </ul>
          </li>
          <li>Click <b>Get and set up phone number</b> and log in to Facebook in the window that opens.</li>
          <li>Create a <b>business portfolio</b> (your business name), then a <b>WhatsApp Business account</b> with the <b>display name</b> customers will see.</li>
          <li>Pick your number: a <b>+1 "Verified"</b> one for the US option, or enter your own number and type the code you get. Accept the permissions and click <b>Finish</b>.</li>
        </ol>
        <p class="hint">Just testing? Kapso has a free <b>Sandbox</b> number (no Facebook needed). Open it under Phone numbers → Sandbox sessions → Add session, enter your WhatsApp number, then send the activation code from that phone within a few minutes (codes expire).</p>
      </details>
      <div class="card" id="connect">
        <h2>${live ? "Connection" : "Part B: copy two values from Kapso"}</h2>
        ${live ? "" : html`<ol class="guide">
          <li><b>Phone number ID</b>: in Kapso, open <b>Phone numbers</b>, click your number and copy <b>PHONE NUMBER ID</b>. It's a long number, not the phone number itself.</li>
          <li><b>API key</b>: in the left sidebar open <b>API keys → Create API key</b>, name it <code>booking-agent</code> and copy it. It's shown only once.</li>
          <li>Paste both below and click <b>Connect</b>. We set up everything else automatically.</li>
        </ol>`}
        <form method="post" action="/setup/whatsapp" data-busy="Connecting WhatsApp…">
          ${csrfField(req)}
          <label>Phone number ID</label>
          <input type="text" name="phone_number_id" value="${w.kapso_phone_number_id ?? ""}" placeholder="597907523413541" required inputmode="numeric">
          <label>Kapso API key ${key ? html`<span class="hint">connected: ${mask(key)} · leave empty to keep</span>` : ""}</label>
          <input type="password" name="api_key" autocomplete="off" ${key ? "" : "required"}>
          <div class="row"><button>${live ? "Reconnect" : "Connect"}</button></div>
        </form>
        <p class="muted small">Prices change; check <a href="${p.pricingUrl}" target="_blank" rel="noopener">Kapso's pricing page</a>.</p>
      </div>`;
  } else {
    const saved = (await savedValues(w, p.id)) ?? {};
    const secret = live ? decrypt(w.wa_hook_secret_enc) : null;
    const hookUrl = secret ? waHookUrl(w, p.id, secret) : "";
    const fill = (s: string) => s.replace("{url}", "\u0000URL\u0000").replace("{secret}", "\u0000SECRET\u0000").replace("{number}", (saved.number || "").replace(/[^\d]/g, ""));
    const manual = live && p.manualWebhook
      ? html`<div class="card" id="webhook">
          <h2>${p.connectWebhook ? "If messages don't arrive" : "Last step: add the webhook"} in ${p.name}</h2>
          <ol class="guide plain">${p.manualWebhook.map((s) => {
            const parts = fill(s).split(/\u0000(URL|SECRET)\u0000/);
            return html`<li>${parts.map((x, i) => (i % 2 === 0 ? md(x) : x === "URL"
              ? html`<span class="mono" style="user-select:all;overflow-wrap:anywhere">${hookUrl}</span> <button type="button" class="secondary small" data-copy="${hookUrl}">Copy</button>`
              : html`<span class="mono" style="user-select:all">${secret}</span> <button type="button" class="secondary small" data-copy="${secret}">Copy</button>`))}</li>`;
          })}</ol>
        </div>`
      : "";
    section = html`
      <div class="card" id="connect">
        <h2>Connect ${p.name} ${p.tag ? html`<span class="tag ${p.tag === "Beta" ? "warn" : ""}">${p.tag}</span>` : ""}</h2>
        <p class="muted">${p.blurb}</p>
        ${p.note ? html`<p class="ai-note">${p.note}</p>` : ""}
        ${p.tag === "Beta" ? html`<p class="ai-note">Beta: we've built this to ${p.name}'s published docs and checked it with test messages. Tell us if anything looks off after your first real messages.</p>` : ""}
        <ol class="guide">${p.steps.map((s) => html`<li>${md(s)}</li>`)}</ol>
        <p class="muted small">Prices change; check <a href="${p.pricingUrl}" target="_blank" rel="noopener">${p.name}'s pricing page</a>.</p>
      </div>
      <div class="card">
        <form method="post" action="/setup/whatsapp/p/${p.id}" data-busy="Connecting ${p.name}…">
          ${csrfField(req)}
          ${p.fields.map((f) => html`
            <label>${f.label} ${f.secret && saved[f.key] ? html`<span class="hint">saved: <span class="mono">${mask(saved[f.key]!)}</span> · leave empty to keep</span>` : f.hint ? html`<span class="hint">${f.hint}</span>` : ""}</label>
            <input type="${f.secret ? "password" : "text"}" name="${f.key}" value="${f.secret ? "" : saved[f.key] ?? ""}" placeholder="${f.placeholder ?? ""}" autocomplete="off" spellcheck="false" ${f.optional || (f.secret && saved[f.key]) ? "" : "required"}>`)}
          <div class="row"><button>${live ? "Reconnect" : "Connect"}</button></div>
        </form>
      </div>
      ${manual}`;
  }
  res.send(
    page(req, {
      title: "Connect WhatsApp",
      body: html`${stepNav(req, "whatsapp", w)}
        <div class="page-head">${tile("whatsapp", "lg")}<div><p class="eyebrow">Channel · optional</p><h1>Connect WhatsApp</h1></div></div>
        <p class="sub">Customers message your WhatsApp number and the assistant books them in. Pick the WhatsApp provider you use, or start with Kapso.</p>
        ${block ?? html`
          ${conn ? html`<div class="flash ok">WhatsApp is live on <b>${conn.display || "your number"}</b> through ${conn.provider.name}. Send it a message to try it.</div>${status}` : ""}
          <div class="ai-pick">
            <a class="ai-rec ${p.id === "kapso" ? "on" : ""}" href="/setup/whatsapp?p=kapso#connect">
              ${tile("whatsapp", "lg")}
              <span class="grow"><b>Kapso <span class="tag rec">Recommended</span></b>
              <small>Free to start and the simplest setup, with a free sandbox number for testing. Cheapest: Meta direct (no platform fee, harder setup).</small></span>
              ${p.id === "kapso" ? html`<span class="sn-tick">${icon("check", 13)}</span>` : icon("chevron", 14)}
            </a>
            <details class="ai-others" ${p.id !== "kapso" ? "open" : ""}>
              <summary>Already use another WhatsApp provider? ${icon("chevron", 13)}</summary>
              <div class="chips ai-chips">
                ${others.map((x) => html`<a class="chip ${x.id === p.id ? "on" : ""}" href="/setup/whatsapp?p=${x.id}#connect">${x.name}${x.tag === "Cheapest" ? html` <i>cheapest</i>` : x.tag === "Beta" ? html` <i>beta</i>` : ""}${conn?.provider.id === x.id ? html` <i>connected</i>` : ""}</a>`)}
              </div>
              <p class="muted small" style="padding-bottom:12px">Only providers that can receive messages and send normal replies are listed. AiSensy and Interakt can't send normal replies, so the assistant can't chat through them; move your number to Kapso instead (your number and name stay the same).</p>
            </details>
          </div>
          ${section}
          <div class="card" id="owners">
            <div class="page-head tight">${tile("lock")}<div><h2>Owner numbers</h2></div></div>
            <p class="muted">Messages from these numbers are treated as <b>you</b>, not a customer. From WhatsApp you can then ask things like “show my services”, “make Facial ₹900”, “20% off for everyone this Diwali week”, “close on 25 Dec” or “what's booked tomorrow?”. You'll also get alerts for new bookings and payments (within 24 hours of your last message, as WhatsApp only allows that).</p>
            <form method="post" action="/setup/whatsapp/owners" data-busy="Saving…">
              ${csrfField(req)}
              <label>Owner WhatsApp numbers <span class="hint">with country code, separate several with commas</span></label>
              <input type="text" name="owner_phones" value="${ownerPhones(w).map((x) => `+${x}`).join(", ")}" placeholder="+91 98765 43210" autocomplete="off">
              <div class="row"><button class="secondary">Save owner numbers</button></div>
            </form>
          </div>
          ${w.whatsapp_enabled
            ? html`<div class="card">
                <h2>Pause WhatsApp</h2>
                <p class="muted">The assistant stops replying on WhatsApp. You can reconnect any time.</p>
                <form method="post" action="/setup/whatsapp/disable" data-confirm="Pause WhatsApp?" data-confirm-detail="The assistant stops replying on WhatsApp until you reconnect." data-confirm-ok="Pause">${csrfField(req)}<button class="danger">Pause WhatsApp</button></form>
              </div>`
            : ""}
          <div class="card">
            <h2>WhatsApp rules to know</h2>
            <ul>
              <li>Customers must message you first (or have agreed to hear from you).</li>
              <li>You can reply freely for 24 hours after their last message.</li>
              <li>A new number can start a limited number of conversations a day until Meta verifies your business.</li>
            </ul>
          </div>`}`,
    })
  );
});

/** Connect a non-Kapso provider: check the details, point its webhook at us, switch the old provider off. */
setupRoutes.post("/setup/whatsapp/p/:provider", requireLogin, checkCsrf, async (req, res) => {
  const w = await ws(req);
  const p = waProvider(String(req.params.provider));
  if (!p || p.id === "kapso") return res.redirect("/setup/whatsapp");
  const back = `/setup/whatsapp?p=${p.id}`;
  if (!req.user!.perm_whatsapp || !isReady(w)) return res.redirect(back);
  if (rateLimited(`wa:${w.id}`, Number(process.env.AI_TEST_LIMIT || 10), 10 * 60_000)) return res.redirect(withMsg(back, "err", "Too many tries. Wait a few minutes."));
  const saved = (await savedValues(w, p.id)) ?? {};
  const v: Record<string, string> = {};
  for (const f of p.fields) {
    const given = String(req.body[f.key] ?? "").trim();
    const val = given || (f.secret ? saved[f.key] ?? "" : "");
    if (!val && !f.optional) return res.redirect(withMsg(back, "err", `Fill in ${f.label}.`));
    if (val && f.pattern && !f.pattern.test(val)) return res.redirect(withMsg(back, "err", f.patternMsg ?? `${f.label} doesn't look right.`));
    if (val) v[f.key] = val;
  }
  try {
    const { display } = await p.check(v);
    const keepSecret = w.wa_provider === p.id ? decrypt(w.wa_hook_secret_enc) : null;
    const secret = keepSecret || randomToken(24).replace(/[^A-Za-z0-9]/g, "").slice(0, 32);
    const url = waHookUrl(w, p.id, secret);
    if (!/^https:\/\//.test(url) && env.isProd) throw new Error("PUBLIC_URL must be https for WhatsApp.");
    let manualNeeded = !p.connectWebhook;
    await updateWorkspace(w.id, { wa_pending_secret_enc: encrypt(secret) }); // Meta checks the address right away
    if (p.connectWebhook) {
      try {
        await p.connectWebhook(v, url, secret);
      } catch (e: any) {
        if (!p.manualWebhook) throw e;
        manualNeeded = true; // we show the address to paste instead
      }
    }
    await switchOffOtherWhatsApp(w, p.id);
    await saveValues(w, p.id, v);
    await updateWorkspace(w.id, { wa_provider: p.id, wa_hook_secret_enc: encrypt(secret), wa_pending_secret_enc: null, wa_display: display, whatsapp_enabled: 1, wa_hook_at: null });
    await logActivity(w.id, "setup", "whatsapp", `Connected ${p.name}${display ? ` (${display})` : ""}`);
    res.redirect(withMsg(manualNeeded ? `${back}#webhook` : back, "ok", manualNeeded
      ? `${p.name} details work. One step left: add the webhook in ${p.name} (below).`
      : `WhatsApp is live${display ? ` on ${display}` : ""} through ${p.name}. Send it a message from your phone to test.`));
  } catch (e: any) {
    res.redirect(withMsg(back, "err", e.message));
  }
});

/** One provider answers at a time: remove the previous provider's webhook so customers never get two replies. */
async function switchOffOtherWhatsApp(w: Workspace, keep: string) {
  if (keep !== "kapso" && w.kapso_webhook_id && w.kapso_phone_number_id) {
    const k = decrypt(w.kapso_key_enc);
    if (k) await deleteWebhook(k, w.kapso_phone_number_id, w.kapso_webhook_id).catch(() => undefined);
    await updateWorkspace(w.id, { kapso_webhook_id: null, kapso_webhook_secret_enc: null });
  }
  const prev = w.wa_provider && w.wa_provider !== keep ? waProvider(w.wa_provider) : null;
  if (prev?.disconnectWebhook) {
    const pv = await savedValues(w, prev.id);
    if (pv) await prev.disconnectWebhook(pv, "").catch(() => undefined);
  }
}

setupRoutes.post("/setup/whatsapp", requireLogin, checkCsrf, async (req, res) => {
  const w = await ws(req);
  const back = "/setup/whatsapp";
  if (!req.user!.perm_whatsapp || !isReady(w)) return res.redirect(back);
  if (rateLimited(`kapso:${w.id}`, 10, 10 * 60_000)) return res.redirect(withMsg(back, "err", "Too many tries. Wait a few minutes."));
  const phoneId = String(req.body.phone_number_id || "").replace(/\s/g, "");
  const key = String(req.body.api_key || "").trim() || decrypt(w.kapso_key_enc) || "";
  if (!/^\d{6,25}$/.test(phoneId)) return res.redirect(withMsg(back, "err", "The Phone number ID should be a long number, like 597907523413541."));
  if (!key) return res.redirect(withMsg(back, "err", "Paste your Kapso API key."));
  try {
    const { display } = await verifyKapso(key, phoneId);
    const secret = randomToken(24);
    const url = `${env.webhookBase || env.publicUrl}/webhooks/kapso/${w.public_id}`;
    if (!/^https:\/\//.test(url) && env.isProd) throw new Error("PUBLIC_URL must be https for WhatsApp.");
    const hook = await createWebhook(key, phoneId, url, secret, w.kapso_phone_number_id === phoneId ? w.kapso_webhook_id : null);
    if (w.kapso_webhook_id && w.kapso_phone_number_id && w.kapso_phone_number_id !== phoneId) {
      const oldKey = decrypt(w.kapso_key_enc);
      if (oldKey) await deleteWebhook(oldKey, w.kapso_phone_number_id, w.kapso_webhook_id).catch(() => undefined);
    }
    // One number answers for one business. If another account here was using it (common with Kapso's shared
    // sandbox), switch that one off and remove its webhook, or customers would get two replies.
    const others = await db.all<Workspace>("SELECT * FROM workspaces WHERE kapso_phone_number_id=? AND id<>? AND whatsapp_enabled=1", phoneId, w.id);
    for (const o of others) {
      const ok = decrypt(o.kapso_key_enc) || key;
      if (o.kapso_webhook_id) await deleteWebhook(ok, phoneId, o.kapso_webhook_id).catch(() => undefined);
      await updateWorkspace(o.id, { whatsapp_enabled: 0, kapso_webhook_id: null, kapso_webhook_secret_enc: null });
      await logActivity(o.id, "setup", "whatsapp", "WhatsApp switched off: this number was connected to another account");
    }
    for (const base of new Set([env.publicUrl, env.webhookBase].filter(Boolean))) {
      const stale = await listOurWebhooks(key, phoneId, `${base}/webhooks/kapso/`).catch(() => []);
      for (const h of stale) if (h.id !== hook.id) await deleteWebhook(key, phoneId, h.id).catch(() => undefined);
    }
    await switchOffOtherWhatsApp(w, "kapso");
    await updateWorkspace(w.id, {
      wa_provider: "kapso",
      wa_hook_at: w.wa_provider === "kapso" || !w.wa_provider ? w.wa_hook_at : null,
      kapso_key_enc: encrypt(key),
      kapso_phone_number_id: phoneId,
      kapso_display_number: display,
      kapso_webhook_id: hook.id,
      kapso_webhook_secret_enc: encrypt(secret),
      whatsapp_enabled: 1,
    });
    await logActivity(w.id, "setup", "whatsapp", `Connected ${display || phoneId}`);
    res.redirect(withMsg(back, "ok", `WhatsApp is live${display ? ` on ${display}` : ""}. Send it a message from your phone to test.`));
  } catch (e: any) {
    res.redirect(withMsg(back, "err", e.message));
  }
});

setupRoutes.post("/setup/whatsapp/owners", requireLogin, checkCsrf, async (req, res) => {
  const w = await ws(req);
  const list = String(req.body.owner_phones || "").split(/[,;\n]/).map((p) => normIndian(p)).filter((p) => p.length >= 10 && p.length <= 15);
  await updateWorkspace(w.id, { owner_phones: [...new Set(list)].join(",") });
  res.redirect(withMsg("/setup/whatsapp#owners", "ok", list.length ? `Saved ${list.length} owner number${list.length === 1 ? "" : "s"}.` : "Owner numbers cleared."));
});

setupRoutes.post("/setup/whatsapp/disable", requireLogin, checkCsrf, async (req, res) => {
  const w = await ws(req);
  const key = decrypt(w.kapso_key_enc);
  if (key && w.kapso_phone_number_id && w.kapso_webhook_id) await deleteWebhook(key, w.kapso_phone_number_id, w.kapso_webhook_id).catch(() => undefined);
  const other = w.wa_provider && w.wa_provider !== "kapso" ? waProvider(w.wa_provider) : null;
  if (other?.disconnectWebhook) {
    const v = await savedValues(w, other.id);
    if (v) await other.disconnectWebhook(v, "").catch(() => undefined);
  }
  await updateWorkspace(w.id, { whatsapp_enabled: 0, kapso_webhook_id: null, kapso_webhook_secret_enc: null });
  res.redirect(withMsg("/setup/whatsapp", "ok", "WhatsApp paused."));
});

function daysHint(d: number[]) {
  if (d.length === 7) return "all week";
  if (d.length === 6 && !d.includes(7)) return "Mon–Sat";
  if (d.length === 5 && !d.includes(6) && !d.includes(7)) return "Mon–Fri";
  return `${d.length} days`;
}

/** Business-type picker: search + categories + "something else". Only pre-fills the form below. */
function quickStart(done: boolean) {
  const body = html`
    <div class="qs-tools">
      <div class="search qs-search">
        ${raw('<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>')}
        <input type="search" placeholder="Search: influencer, kirana, consultant, turf…" aria-label="Search business types" data-template-search autocomplete="off">
      </div>
      <div class="chips qs-cats" role="tablist" aria-label="Business categories">
        ${CATEGORIES.map(([k, l], i) => html`<button type="button" role="tab" class="chip ${i === 0 ? "on" : ""}" aria-selected="${i === 0 ? "true" : "false"}" data-template-cat="${k}">${l}</button>`)}
      </div>
    </div>
    <div class="templates" data-templates>
      ${TEMPLATES.map((t) => {
        const data = { label: t.label, services: t.services, open: t.open, close: t.close, slot: t.slot, days: t.days, extra: t.extra ?? "", mode: t.mode ?? CAT_MODE[t.cat] ?? "offline" };
        return html`<button type="button" class="template" data-template="${JSON.stringify(data)}" data-cat="${t.cat}${t.popular ? " popular" : ""}" data-search="${`${t.label} ${t.tags ?? ""} ${t.services}`.toLowerCase()}" ${t.popular ? "" : html`hidden`}><span class="emoji" aria-hidden="true">${t.emoji}</span><b>${t.label}</b><small>${t.slot} min · ${daysHint(t.days)}</small></button>`;
      })}
    </div>
    <p class="qs-empty muted" data-templates-empty hidden>No match, and that's fine. Just fill in the form below yourself. It works for any business that takes bookings.</p>`;
  return done
    ? html`<details class="card qs-again"><summary><h2>Start from a business type</h2><span class="hint">Replaces services and hours below</span></summary>${body}</details>`
    : html`<div class="card">
        <div class="qs-head"><h2>What kind of business is it?</h2><span class="tag">Optional</span></div>
        <p class="muted" style="margin-top:-4px">A shortcut: picking one fills in typical services and hours for you, and you can change everything after. Don't see yours? Skip this and <a href="#business-form" data-skip-templates>fill in the form below</a> yourself.</p>
        ${body}
      </div>`;
}
