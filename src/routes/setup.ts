import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import { DateTime } from "luxon";
import { checkCsrf, requireLogin } from "../auth.js";
import { reply, resetConversation, testAnthropicKey } from "../agent.js";
import { parseServiceAccount, testCalendar } from "../calendar.js";
import { db, logActivity, Workspace } from "../db.js";
import { env } from "../env.js";
import { createWebhook, deleteWebhook, verifyKapso } from "../kapso.js";
import { getWorkspaceForUser, recentActivity, updateWorkspace } from "../models.js";
import { decrypt, encrypt, mask, randomToken, rateLimited } from "../security.js";
import { html, Safe } from "../views/html.js";
import { csrfField, page, withMsg } from "../views/layout.js";

export const setupRoutes = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024, files: 1 } });

const MODELS = [
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (recommended: fast and smart)" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 (cheapest)" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (most capable, costs more)" },
];

const TIMEZONES = ["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Europe/London", "America/New_York", "America/Los_Angeles", "Australia/Sydney"];

async function ws(req: Request): Promise<Workspace> {
  return await getWorkspaceForUser(req.user!.id);
}

function isReady(w: Workspace) {
  return !!(w.business_done && w.claude_ok && w.google_ok);
}

function stepNav(active: string) {
  const items = [
    ["business", "1. Business"],
    ["claude", "2. Claude"],
    ["google", "3. Calendar"],
    ["test", "4. Test"],
    ["widget", "Widget"],
    ["whatsapp", "WhatsApp"],
  ];
  return html`<nav class="step-nav" aria-label="Setup steps">${items.map(([k, l]) =>
    k === active ? html`<b aria-current="step">${l}</b>` : html`<a href="/setup/${k}">${l}</a>`
  )}</nav>`;
}

// ---------- Dashboard ----------

setupRoutes.get("/", requireLogin, async (req, res) => {
  const w = await ws(req);
  const u = req.user!;
  const steps: { key: string; title: string; desc: string; done: boolean; show: boolean; optional?: boolean }[] = [
    { key: "business", title: "Business details", desc: "Name, services, working hours", done: !!w.business_done, show: true },
    { key: "claude", title: "Connect Claude", desc: "The AI that talks to your customers", done: !!w.claude_ok, show: true },
    { key: "google", title: "Connect Google Calendar", desc: "Where bookings are saved", done: !!w.google_ok, show: true },
    { key: "test", title: "Test your assistant", desc: "Chat with it and make a test booking", done: !!w.tested, show: true },
    { key: "widget", title: "Website chat widget", desc: "Add a booking chat to your website", done: !!w.widget_enabled, show: !!u.perm_widget, optional: true },
    { key: "whatsapp", title: "Connect WhatsApp", desc: "Customers book by messaging your number", done: !!w.whatsapp_enabled, show: !!u.perm_whatsapp, optional: true },
  ];
  const act = await recentActivity(w.id, 10);
  const bookings = (await db.get("SELECT COUNT(*) c FROM activity WHERE workspace_id=? AND kind='booking' AND channel!='test'", w.id) as any).c;
  res.send(
    page(req, {
      title: "Dashboard",
      body: html`
        <h1>${w.business_name || `Welcome, ${u.name || u.email}`}</h1>
        <p class="sub">${w.widget_enabled || w.whatsapp_enabled ? `Your assistant is live · ${bookings} bookings so far` : "Finish these steps to put your booking assistant live."}</p>
        ${u.role === "admin" && !w.business_done ? html`<div class="flash info">You're an admin. Manage accounts in <a href="/admin">Admin</a>, or set up a business here to try the product yourself.</div>` : ""}
        <div class="card">
          <ul class="steps">
            ${steps
              .filter((s) => s.show)
              .map(
                (s, i, all) => html`<li>
                  <span class="dot ${s.done ? "done" : ""}">${s.done ? "✓" : s.optional ? "+" : i + 1}</span>
                  <span class="grow"><b>${s.title}</b>${s.optional ? html` <span class="hint">optional</span>` : ""}<small>${s.desc}</small></span>
                  <a class="btn ${s.key === all.find((x) => !x.done)?.key ? "" : "secondary"}" href="/setup/${s.key}">${s.done ? "Edit" : "Start"}</a>
                </li>`
              )}
          </ul>
        </div>
        <div class="card">
          <h2>Recent activity</h2>
          ${act.length
            ? html`<table><tbody>${act.map((a) => html`<tr><td class="hint">${a.created_at.slice(0, 16)}</td><td>${a.kind}</td><td>${a.channel}</td><td>${a.detail}</td></tr>`)}</tbody></table>`
            : html`<p class="muted">Bookings and cancellations will show up here.</p>`}
        </div>`,
    })
  );
});

// ---------- Step 1: Business ----------

setupRoutes.get("/setup/business", requireLogin, async (req, res) => {
  const w = await ws(req);
  const days = new Set(w.working_days.split(",").map(Number));
  const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const hours = Array.from({ length: 24 }, (_, h) => h);
  res.send(
    page(req, {
      title: "Business details",
      body: html`${stepNav("business")}
        <h1>Business details</h1>
        <p class="sub">The assistant uses these to answer customers and to decide which slots are free.</p>
        <div class="card">
          <form method="post" action="/setup/business" data-busy="Saving…">
            ${csrfField(req)}
            <label>Business name</label>
            <input type="text" name="business_name" value="${w.business_name}" placeholder="Smile Dental Clinic" required maxlength="100">
            <label>Services <span class="hint">comma separated</span></label>
            <input type="text" name="services" value="${w.services}" placeholder="Consultation, Cleaning, Filling" required maxlength="500">
            <label>Working days</label>
            <div class="checks chips">${dayNames.map((d, i) => html`<label><input type="checkbox" name="days" value="${i + 1}" ${days.has(i + 1) ? "checked" : ""}> ${d}</label>`)}</div>
            <div class="grid">
              <div><label>Opens at</label><select name="open_hour">${hours.map((h) => html`<option value="${h}" ${h === w.open_hour ? "selected" : ""}>${fmtHour(h)}</option>`)}</select></div>
              <div><label>Closes at</label><select name="close_hour">${hours.map((h) => html`<option value="${h}" ${h === w.close_hour ? "selected" : ""}>${fmtHour(h)}</option>`)}</select></div>
              <div><label>Appointment length</label><select name="slot_minutes">${[15, 20, 30, 45, 60, 90, 120].map((m) => html`<option value="${m}" ${m === w.slot_minutes ? "selected" : ""}>${m} minutes</option>`)}</select></div>
              <div><label>Time zone</label><select name="timezone">${TIMEZONES.map((t) => html`<option ${t === w.timezone ? "selected" : ""}>${t}</option>`)}</select></div>
            </div>
            <label>Extra information for the assistant <span class="hint">address, parking, prices it may share, what it must never do, languages</span></label>
            <textarea name="extra_info" maxlength="3000" placeholder="We're at 12 MG Road, 2nd floor. Parking in the basement.&#10;Don't give medical advice.&#10;Reply in Hindi if the customer writes in Hindi.">${w.extra_info}</textarea>
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
  if (!String(b.business_name || "").trim() || !String(b.services || "").trim()) return res.redirect(withMsg(back, "err", "Business name and services are required."));
  if (!days.length) return res.redirect(withMsg(back, "err", "Pick at least one working day."));
  if (!(close > open)) return res.redirect(withMsg(back, "err", "Closing time must be after opening time."));
  await updateWorkspace((await ws(req)).id, {
    business_name: String(b.business_name).trim().slice(0, 100),
    services: String(b.services).trim().slice(0, 500),
    working_days: days.join(","),
    open_hour: open,
    close_hour: close,
    slot_minutes: [15, 20, 30, 45, 60, 90, 120].includes(Number(b.slot_minutes)) ? Number(b.slot_minutes) : 30,
    timezone: TIMEZONES.includes(b.timezone) ? b.timezone : "Asia/Kolkata",
    extra_info: String(b.extra_info || "").slice(0, 3000),
    business_done: 1,
  });
  res.redirect(withMsg((await ws(req)).claude_ok ? "/" : "/setup/claude", "ok", "Business details saved."));
});

// ---------- Step 2: Claude ----------

setupRoutes.get("/setup/claude", requireLogin, async (req, res) => {
  const w = await ws(req);
  const current = decrypt(w.anthropic_key_enc);
  res.send(
    page(req, {
      title: "Connect Claude",
      body: html`${stepNav("claude")}
        <h1>Connect Claude</h1>
        <p class="sub">Claude is the AI that chats with your customers. You pay Anthropic directly for what it uses, usually a few rupees per conversation.</p>
        <div class="card">
          <h2>Get your API key (5 minutes)</h2>
          <ol class="guide">
            <li>Open <a href="https://console.anthropic.com" target="_blank" rel="noopener">console.anthropic.com</a> and sign up or log in.</li>
            <li>Go to <b>Settings → Billing</b> and add credit. $10 is plenty to start.</li>
            <li>Go to <b>Settings → API Keys</b> and click <b>Create Key</b>. Name it <code>booking-assistant</code>.</li>
            <li>Copy the key. It starts with <code>sk-ant-</code> and is shown only once.</li>
            <li>Paste it below and click <b>Test and save</b>.</li>
          </ol>
        </div>
        <div class="card">
          ${current ? html`<p>Connected key: <span class="mono">${mask(current)}</span> ${w.claude_ok ? html`<span class="pill ok">Working</span>` : ""}</p>` : ""}
          <form method="post" action="/setup/claude" data-busy="Testing your key…">
            ${csrfField(req)}
            <label>API key ${current ? html`<span class="hint">leave empty to keep the current key</span>` : ""}</label>
            <input type="password" name="api_key" placeholder="sk-ant-…" autocomplete="off" ${current ? "" : "required"}>
            <label>Model</label>
            <select name="model">${MODELS.map((m) => html`<option value="${m.id}" ${m.id === (w.claude_model || env.defaultModel) ? "selected" : ""}>${m.label}</option>`)}</select>
            <div class="row"><button>Test and save</button></div>
          </form>
        </div>`,
    })
  );
});

setupRoutes.post("/setup/claude", requireLogin, checkCsrf, async (req, res) => {
  const w = await ws(req);
  const back = "/setup/claude";
  if (rateLimited(`claude-test:${w.id}`, 10, 10 * 60_000)) return res.redirect(withMsg(back, "err", "Too many tries. Wait a few minutes."));
  const key = String(req.body.api_key || "").trim() || decrypt(w.anthropic_key_enc) || "";
  const model = MODELS.some((m) => m.id === req.body.model) ? req.body.model : env.defaultModel;
  if (!key) return res.redirect(withMsg(back, "err", "Paste your API key."));
  if (!key.startsWith("sk-ant-")) return res.redirect(withMsg(back, "err", "That doesn't look like an Anthropic key. It should start with sk-ant-"));
  try {
    await testAnthropicKey(key, model);
  } catch (e: any) {
    return res.redirect(withMsg(back, "err", e.message));
  }
  await updateWorkspace(w.id, { anthropic_key_enc: encrypt(key), claude_model: model, claude_ok: 1 });
  res.redirect(withMsg(w.google_ok ? "/" : "/setup/google", "ok", "Claude is connected and working."));
});

// ---------- Step 3: Google Calendar ----------

setupRoutes.get("/setup/google", requireLogin, async (req, res) => {
  const w = await ws(req);
  res.send(
    page(req, {
      title: "Connect Google Calendar",
      body: html`${stepNav("google")}
        <h1>Connect Google Calendar</h1>
        <p class="sub">Bookings go into a Google Calendar you choose, and busy times there are never offered to customers. About 15 minutes, done once.</p>
        <div class="card">
          <h2>Part A: create a key in Google Cloud</h2>
          <ol class="guide">
            <li>Open <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener">Google Cloud → New project</a>. Name it <code>booking-assistant</code> and click <b>Create</b>. Make sure it's selected in the project picker at the top.</li>
            <li>Open <a href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com" target="_blank" rel="noopener">Google Calendar API</a> and click <b>Enable</b>.</li>
            <li>Open <a href="https://console.cloud.google.com/iam-admin/serviceaccounts" target="_blank" rel="noopener">Service accounts</a> → <b>+ Create service account</b>. Name it <code>booking-bot</code>, click <b>Create and continue</b>, skip the optional steps and click <b>Done</b>.</li>
            <li>Click the new service account → <b>Keys</b> tab → <b>Add key → Create new key → JSON</b>. A file downloads. Upload it below.</li>
          </ol>
          <p class="hint">If Google says key creation is disabled, you're on a company Google account. Use a personal Gmail account instead.</p>
          <form method="post" action="/setup/google/key?_csrf=${req.csrf}" enctype="multipart/form-data" data-busy="Uploading…">
            <label>Key file (.json)</label>
            <input type="file" name="keyfile" accept=".json,application/json" required>
            <div class="row"><button>Upload key</button></div>
          </form>
          ${w.google_sa_email ? html`<p class="flash ok" style="margin-top:12px">Key uploaded for <span class="mono">${w.google_sa_email}</span></p>` : ""}
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
        </div>`,
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
    await updateWorkspace((await ws(req)).id, { google_sa_enc: encrypt(sa.json), google_sa_email: sa.email, google_ok: 0 });
    res.redirect(withMsg(back, "ok", "Key uploaded. Now share your calendar with the email shown in Part B."));
  } catch (e: any) {
    res.redirect(withMsg(back, "err", e.message));
  }
});

setupRoutes.post("/setup/google", requireLogin, checkCsrf, async (req, res) => {
  const w = await ws(req);
  const back = "/setup/google";
  const calId = String(req.body.calendar_id || "").trim();
  const sa = decrypt(w.google_sa_enc);
  if (!sa) return res.redirect(withMsg(back, "err", "Upload the key file first."));
  if (!calId) return res.redirect(withMsg(back, "err", "Paste the Calendar ID."));
  if (rateLimited(`google-test:${w.id}`, 15, 10 * 60_000)) return res.redirect(withMsg(back, "err", "Too many tries. Wait a few minutes."));
  try {
    const name = await testCalendar(sa, calId);
    await updateWorkspace(w.id, { google_calendar_id: calId, google_ok: 1 });
    res.redirect(withMsg(w.tested ? "/" : "/setup/test", "ok", `Connected to "${name}".`));
  } catch (e: any) {
    await updateWorkspace(w.id, { google_calendar_id: calId, google_ok: 0 });
    res.redirect(withMsg(back, "err", e.message));
  }
});

// ---------- Step 4: Test chat ----------

function notReady(w: Workspace): Safe | null {
  if (isReady(w)) return null;
  const missing = [!w.business_done && "business details", !w.claude_ok && "Claude", !w.google_ok && "Google Calendar"].filter(Boolean).join(", ");
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
      body: html`${stepNav("test")}
        <h1>Test your assistant</h1>
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
          <div class="chat" id="chat" data-endpoint="/setup/test/message" data-reset="/setup/test/reset" data-csrf="${req.csrf}">
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
  if (rateLimited(`test-chat:${w.id}`, 40, 10 * 60_000)) return res.status(429).json({ error: "Slow down a little, then try again." });
  const text = String(req.body.text || "").trim();
  if (!text) return res.status(400).json({ error: "Empty message" });
  try {
    const out = await reply(w, "test", `user-${req.user!.id}`, text);
    const booked = await db.get("SELECT 1 FROM activity WHERE workspace_id=? AND channel='test' AND kind='booking' LIMIT 1", w.id);
    if (booked && !w.tested) await updateWorkspace(w.id, { tested: 1 });
    res.json({ reply: out });
  } catch (e: any) {
    await logActivity(w.id, "error", "test", e.message);
    res.status(500).json({ error: `Something went wrong: ${e.message}` });
  }
});

setupRoutes.post("/setup/test/reset", requireLogin, checkCsrf, async (req, res) => {
  await resetConversation((await ws(req)).id, "test", `user-${req.user!.id}`);
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
      body: html`${stepNav("widget")}
        <h1>Website chat widget</h1>
        <p class="sub">Put the booking assistant on your own website. It uses the same calendar and settings.</p>
        ${block ?? html`
          <div class="card">
            <form method="post" action="/setup/widget">
              ${csrfField(req)}
              <div class="grid">
                <div><label>Button colour</label><input type="text" name="color" value="${w.widget_color}" pattern="#[0-9a-fA-F]{6}" placeholder="#16a34a"></div>
                <div><label>Greeting</label><input type="text" name="greeting" value="${w.widget_greeting}" maxlength="200" placeholder="Hi! Want to book an appointment?"></div>
              </div>
              <div class="checks" style="margin-top:12px"><label><input type="checkbox" name="enabled" value="1" ${w.widget_enabled ? "checked" : ""}> Widget is live</label></div>
              <div class="row"><button>Save</button> <a class="btn secondary" href="/w/${w.public_id}" target="_blank">Preview</a></div>
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
  const key = decrypt(w.kapso_key_enc);
  res.send(
    page(req, {
      title: "Connect WhatsApp",
      body: html`${stepNav("whatsapp")}
        <h1>Connect WhatsApp</h1>
        <p class="sub">Customers message your WhatsApp number and the assistant books them in. We use Kapso, an official WhatsApp Business partner. About 15 minutes.</p>
        ${block ?? html`
          ${w.whatsapp_enabled
            ? html`<div class="flash ok">WhatsApp is live on <b>${w.kapso_display_number || w.kapso_phone_number_id}</b>. Send it a message to try it.</div>`
            : ""}
          <div class="card">
            <h2>Part A: create a Kapso account and connect a number</h2>
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
          </div>
          <div class="card">
            <h2>Part B: copy two values from Kapso</h2>
            <ol class="guide">
              <li><b>Phone number ID</b>: in Kapso, open <b>Phone numbers</b>, click your number and copy <b>PHONE NUMBER ID</b>. It's a long number, not the phone number itself.</li>
              <li><b>API key</b>: in the left sidebar open <b>API keys → Create API key</b>, name it <code>booking-agent</code> and copy it. It's shown only once.</li>
              <li>Paste both below and click <b>Connect</b>. We set up everything else automatically.</li>
            </ol>
            <form method="post" action="/setup/whatsapp" data-busy="Connecting WhatsApp…">
              ${csrfField(req)}
              <label>Phone number ID</label>
              <input type="text" name="phone_number_id" value="${w.kapso_phone_number_id ?? ""}" placeholder="597907523413541" required inputmode="numeric">
              <label>Kapso API key ${key ? html`<span class="hint">connected: ${mask(key)} · leave empty to keep</span>` : ""}</label>
              <input type="password" name="api_key" autocomplete="off" ${key ? "" : "required"}>
              <div class="row"><button>${w.whatsapp_enabled ? "Reconnect" : "Connect"}</button></div>
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
    const url = `${env.publicUrl}/webhooks/kapso/${w.public_id}`;
    if (!/^https:\/\//.test(url) && env.isProd) throw new Error("PUBLIC_URL must be https for WhatsApp.");
    const hook = await createWebhook(key, phoneId, url, secret, w.kapso_phone_number_id === phoneId ? w.kapso_webhook_id : null);
    if (w.kapso_webhook_id && w.kapso_phone_number_id && w.kapso_phone_number_id !== phoneId) {
      const oldKey = decrypt(w.kapso_key_enc);
      if (oldKey) await deleteWebhook(oldKey, w.kapso_phone_number_id, w.kapso_webhook_id).catch(() => undefined);
    }
    await updateWorkspace(w.id, {
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

setupRoutes.post("/setup/whatsapp/disable", requireLogin, checkCsrf, async (req, res) => {
  const w = await ws(req);
  const key = decrypt(w.kapso_key_enc);
  if (key && w.kapso_phone_number_id && w.kapso_webhook_id) await deleteWebhook(key, w.kapso_phone_number_id, w.kapso_webhook_id).catch(() => undefined);
  await updateWorkspace(w.id, { whatsapp_enabled: 0, kapso_webhook_id: null, kapso_webhook_secret_enc: null });
  res.redirect(withMsg("/setup/whatsapp", "ok", "WhatsApp paused."));
});
