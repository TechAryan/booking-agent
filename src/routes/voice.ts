// Calling agent: setup page, calls list, the live tool endpoint and post-call webhooks.
import express, { Router, Request } from "express";
import crypto from "node:crypto";
import { DateTime } from "luxon";
import { checkCsrf, requireLogin } from "../auth.js";
import { db, logActivity, Workspace } from "../db.js";
import { env } from "../env.js";
import { kickDrain, saveEvent } from "../inbox.js";
import { getWorkspaceByPublicId, getWorkspaceForUser, updateWorkspace } from "../models.js";
import { decrypt, mask, rateLimited, safeEqual } from "../security.js";
import { normIndian, ownerPhones } from "../catalog.js";
import { html, raw, Safe } from "../views/html.js";
import { icon, tile } from "../views/icons.js";
import { csrfField, page, withMsg } from "../views/layout.js";
import { stepNav } from "../views/stepper.js";
import { agentSpec, CallRow, voiceSettings, VoiceSettings } from "../voice/agent.js";
import { ensureVoiceSecret, handleToolCall, placeCall, provisionVoice, saveVoiceValues, voiceConnection, voiceProvider, VOICE_PROVIDERS, voiceUrls, voiceValues } from "../voice/index.js";
import type { Booking } from "../bookings.js";

export const voiceRoutes = Router();
/** Provider → us (raw bodies for signatures): mounted before the body parsers. */
export const voiceHooks = Router();
const ws = (req: Request) => getWorkspaceForUser(req.user!.id);
const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");

function md(s: string): Safe {
  return raw(String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`(.+?)`/g, "<code>$1</code>")
    .replace(/\[(.+?)\]\((https:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>'));
}

const h12 = (h: number) => `${h % 12 || 12} ${h < 12 ? "am" : "pm"}`;
const REMIND_LABEL: Record<VoiceSettings["remind"], string> = { off: "No reminder call", "30m": "30 minutes before", "1h": "1 hour before", "3h": "3 hours before", "1d": "1 day before" };
const STATUS_LABEL: Record<string, string> = { queued: "Starting", ringing: "Ringing", in_progress: "On the call", completed: "Done", no_answer: "No answer", busy: "Busy", failed: "Failed", voicemail: "Voicemail" };

async function owns(provider: string, publicId: string, secret: string): Promise<Workspace | null> {
  const w = await getWorkspaceByPublicId(publicId);
  if (!w || w.voice_provider !== provider) return null;
  const want = decrypt(w.voice_secret_enc);
  return want && want.length === secret.length && safeEqual(want, secret) ? w : null;
}

// ---------------------------------------------------------------- setup page

voiceRoutes.get("/setup/calling", requireLogin, async (req, res) => {
  const w = await ws(req);
  if (!req.user!.perm_calling) return res.redirect(withMsg("/", "err", "The calling agent isn't included in your plan."));
  const s = voiceSettings(w);
  const conn = await voiceConnection(w);
  const p = voiceProvider(String(req.query.p || "")) ?? conn?.provider ?? VOICE_PROVIDERS[0]!;
  const saved = (await voiceValues(w, p.id)) ?? {};
  const live = conn?.provider.id === p.id;
  const others = VOICE_PROVIDERS.filter((x) => x.id !== "bolna");
  const recent = await db.all<CallRow & { customer_name: string | null }>(
    "SELECT c.*, b.customer_name FROM calls c LEFT JOIN bookings b ON b.id=c.booking_id WHERE c.workspace_id=? ORDER BY c.id DESC LIMIT 5", w.id);
  let manual: Safe | string = "";
  if (live && p.manual) {
    const secret = await ensureVoiceSecret(w);
    const urls = voiceUrls(w, p.id, secret);
    const spec = await agentSpec(w, s, urls);
    manual = html`<div class="card" id="manual">
      <h2>Set up the agent in ${p.name}</h2>
      <p class="muted small">${p.name} builds agents in its own dashboard. Copy these in; update them if you change your services or switches here.</p>
      <label>Instructions (prompt)</label><textarea readonly rows="10" class="mono small">${spec.prompt}</textarea>
      <div class="row"><button type="button" class="secondary small" data-copy="${spec.prompt}">Copy instructions</button></div>
      <label>First line</label><input readonly value="${spec.firstMessage}">
      <label>Agent variables</label><p class="small mono">purpose, customer_name, service, booking_when, booking_ref, call_key</p>
      <label>Tools (each: HTTPS tool, method POST, JSON body with the fields listed, plus <code>call_key</code> = the call_key variable and <code>caller</code> = User Identifier)</label>
      <ul class="tool-list">${spec.tools.map((t) => html`<li><b>${t.name}</b> · ${t.description}<br><span class="mono small" style="overflow-wrap:anywhere">${spec.toolUrl(t.name)}</span> <button type="button" class="secondary small" data-copy="${spec.toolUrl(t.name)}">Copy</button>
        ${Object.keys(t.parameters.properties).length ? html`<br><small>Fields: ${Object.keys(t.parameters.properties).join(", ")}</small>` : ""}</li>`)}</ul>
      <label>Call report webhook</label><p class="mono small" style="overflow-wrap:anywhere">${spec.webhookUrl} <button type="button" class="secondary small" data-copy="${spec.webhookUrl}">Copy</button></p>
    </div>`;
  }
  res.send(page(req, {
    title: "Calling agent",
    body: html`${stepNav(req, "calling", w)}
      <div class="page-head">${tile("send", "lg")}<div><p class="eyebrow">Optional</p><h1>Calling agent</h1></div></div>
      <p class="sub">An AI voice that calls customers to confirm bookings and remind them, and can answer your business number. It only calls people who agreed to it, between ${h12(s.start)} and ${h12(s.end)}.</p>
      <div class="card before-start">
        <h2>${icon("bell", 16)} Before you start</h2>
        <ul>
          <li>You need an Indian business phone number from the calling provider.</li>
          <li>Getting the number needs your business papers: GST, company registration, Udyam or a Shop &amp; Establishment licence.</li>
          <li>You are the caller under TRAI rules. We keep calls to bookings only, never promotions, and only to customers who said yes.</li>
          <li>Calls cost a few rupees a minute, paid to the provider. You set a daily limit below.</li>
        </ul>
      </div>
      ${conn ? html`<div class="flash ok">Calling is ${s.enabled ? "on" : "connected but switched off"} through ${conn.provider.name}${saved.number && live ? html` on <b>${saved.number}</b>` : ""}.</div>` : ""}
      <div class="ai-pick">
        <a class="ai-rec ${p.id === "bolna" ? "on" : ""}" href="/setup/calling?p=bolna#connect">
          ${tile("send", "lg")}
          <span class="grow"><b>Bolna <span class="tag rec">Recommended</span></b><small>Indian numbers and voices, and calls can stay in India. $5 free credit to try.</small></span>
          ${p.id === "bolna" ? html`<span class="sn-tick">${icon("check", 13)}</span>` : icon("chevron", 14)}
        </a>
        <details class="ai-others" ${p.id !== "bolna" ? "open" : ""}>
          <summary>Other calling providers ${icon("chevron", 13)}</summary>
          <div class="chips ai-chips">${others.map((x) => html`<a class="chip ${x.id === p.id ? "on" : ""}" href="/setup/calling?p=${x.id}#connect">${x.name}${x.tag === "Beta" ? html` <i>beta</i>` : ""}${conn?.provider.id === x.id ? html` <i>connected</i>` : ""}</a>`)}</div>
        </details>
      </div>
      <div class="card" id="connect">
        <h2>Connect ${p.name} ${p.tag ? html`<span class="tag ${p.tag === "Beta" ? "warn" : "rec"}">${p.tag}</span>` : ""}</h2>
        <p class="muted">${p.blurb}</p>
        <p class="small"><b>Where calls are processed:</b> ${p.india}</p>
        ${p.note ? html`<p class="ai-note">${p.note}</p>` : ""}
        <ol class="guide">${p.steps.map((x) => html`<li>${md(x)}</li>`)}</ol>
        <p class="muted small">Prices change; check <a href="${p.pricingUrl}" target="_blank" rel="noopener">${p.name}'s pricing page</a>.</p>
        <form method="post" action="/setup/calling/p/${p.id}" data-busy="Connecting ${p.name}… setting up your agent">
          ${csrfField(req)}
          ${p.fields.map((f) => html`<label>${f.label} ${f.secret && saved[f.key] ? html`<span class="hint">saved: <span class="mono">${mask(saved[f.key]!)}</span> · leave empty to keep</span>` : f.hint ? html`<span class="hint">${f.hint}</span>` : ""}</label>
            <input type="${f.secret ? "password" : "text"}" name="${f.key}" value="${f.secret ? "" : saved[f.key] ?? ""}" placeholder="${f.placeholder ?? ""}" autocomplete="off" ${f.optional || (f.secret && saved[f.key]) ? "" : "required"}>`)}
          <div class="row"><button>${live ? "Reconnect and update agent" : "Connect"}</button></div>
        </form>
      </div>
      ${manual}
      ${conn ? html`
      <form class="card" method="post" action="/setup/calling/settings" data-busy="Saving and updating your agent…">
        ${csrfField(req)}
        <h2>What the agent does</h2>
        <label class="switch-row"><input type="checkbox" name="enabled" value="1" ${s.enabled ? "checked" : ""}><span><b>Calling is on</b><small>Off = no calls are made (incoming calls aren't answered either).</small></span></label>
        <label class="switch-row"><input type="checkbox" name="confirm" value="1" ${s.confirm ? "checked" : ""}><span><b>Confirmation call</b><small>Soon after a booking, if it's more than 3 hours away.</small></span></label>
        <label>Reminder call</label>
        <select name="remind">${(Object.keys(REMIND_LABEL) as VoiceSettings["remind"][]).map((k) => html`<option value="${k}" ${s.remind === k ? "selected" : ""}>${REMIND_LABEL[k]}</option>`)}</select>
        <label>On a call the agent may</label>
        <label class="switch-row"><input type="checkbox" name="can_reschedule" value="1" ${s.canReschedule ? "checked" : ""}><span><b>Move bookings</b><small>to another free time</small></span></label>
        <label class="switch-row"><input type="checkbox" name="can_cancel" value="1" ${s.canCancel ? "checked" : ""}><span><b>Cancel bookings</b><small>unpaid ones only; paid bookings can only be moved</small></span></label>
        <label class="switch-row"><input type="checkbox" name="inbound" value="1" ${s.inbound ? "checked" : ""}><span><b>Answer calls to my number</b><small>answers questions, books free or pay-at-venue services, changes bookings</small></span></label>
        <div class="grid">
          <div><label>Calls from</label><select name="start">${[9, 10, 11, 12].map((h) => html`<option value="${h}" ${s.start === h ? "selected" : ""}>${h12(h)}</option>`)}</select></div>
          <div><label>Until</label><select name="end">${[17, 18, 19, 20, 21].map((h) => html`<option value="${h}" ${s.end === h ? "selected" : ""}>${h12(h)}</option>`)}</select></div>
        </div>
        <div class="grid">
          <div><label>Language</label><select name="language"><option value="hinglish" ${s.language === "hinglish" ? "selected" : ""}>Hinglish</option><option value="hi" ${s.language === "hi" ? "selected" : ""}>Hindi</option><option value="en" ${s.language === "en" ? "selected" : ""}>English</option></select></div>
          <div><label>Voice</label><select name="voice"><option value="female" ${s.voice === "female" ? "selected" : ""}>Female</option><option value="male" ${s.voice === "male" ? "selected" : ""}>Male</option></select></div>
        </div>
        <label>Most calls a day</label><input type="number" name="daily_cap" min="1" max="500" value="${s.dailyCap}">
        <p class="hint">Calls only go to customers who agreed when booking. Anyone can say "don't call me" to stop them.</p>
        <div class="row"><button>Save</button></div>
      </form>
      <div class="card">
        <h2>Test call to my phone</h2>
        <p class="muted small">The agent calls you with a pretend booking so you can hear it. Costs a minute or two of call time.</p>
        <form method="post" action="/setup/calling/test" data-busy="Calling you…">
          ${csrfField(req)}
          <label>Your number</label><input type="tel" name="phone" value="${ownerPhones(w)[0] ? `+${ownerPhones(w)[0]}` : w.contact_phone || ""}" placeholder="+91 98765 43210" required>
          <div class="row"><button class="secondary">Call me now</button></div>
        </form>
      </div>
      <div class="card">
        <div class="spread-row"><h2>Recent calls</h2><a class="btn small secondary" href="/calls">All calls</a></div>
        ${recent.length ? html`<ul class="call-list">${recent.map((c) => callLine(w, c))}</ul>` : html`<p class="muted">No calls yet.</p>`}
      </div>
      <form class="card" method="post" action="/setup/calling/disconnect" data-confirm="Disconnect the calling agent?" data-confirm-detail="No more calls will be made. Your provider account stays as it is." data-confirm-ok="Disconnect">
        ${csrfField(req)}<h2>Disconnect</h2><div class="row"><button class="danger small">Disconnect calling</button></div>
      </form>` : ""}`,
  }));
});

function callLine(w: Workspace, c: CallRow & { customer_name: string | null }) {
  const when = DateTime.fromMillis(c.created_at).setZone(w.timezone || "Asia/Kolkata").toFormat("d LLL, h:mm a");
  const what = c.direction === "in" ? "Incoming call" : c.purpose === "reminder" ? "Reminder" : c.purpose === "test" ? "Test call" : "Confirmation";
  return html`<li><span class="grow"><b>${what}</b> · ${c.customer_name || `+${c.customer_key}`}${c.seconds ? html` · ${Math.round(c.seconds / 60) || 1} min` : ""}${c.outcome ? html` · <span class="pill ok">${c.outcome}</span>` : ""}
    <small>${when}${c.summary ? html` · ${c.summary.slice(0, 180)}` : ""}</small></span><span class="pill ${c.status === "completed" ? "ok" : ["failed", "busy", "no_answer"].includes(c.status) ? "bad" : ""}">${STATUS_LABEL[c.status] ?? c.status}</span></li>`;
}

voiceRoutes.post("/setup/calling/p/:provider", requireLogin, checkCsrf, async (req, res) => {
  const w = await ws(req);
  const p = voiceProvider(String(req.params.provider));
  if (!p || !req.user!.perm_calling) return res.redirect("/setup/calling");
  const back = `/setup/calling?p=${p.id}`;
  if (!(w.business_done && w.google_ok)) return res.redirect(withMsg(back, "err", "Finish your business details and Google Calendar first."));
  if (rateLimited(`voice:${w.id}`, Number(process.env.AI_TEST_LIMIT || 10), 10 * 60_000)) return res.redirect(withMsg(back, "err", "Too many tries. Wait a few minutes."));
  const saved = (await voiceValues(w, p.id)) ?? {};
  const v: Record<string, string> = { ...saved };
  for (const f of p.fields) {
    const given = String(req.body[f.key] ?? "").trim();
    const val = given || (f.secret ? saved[f.key] ?? "" : "");
    if (!val && !f.optional) return res.redirect(withMsg(back, "err", `Fill in ${f.label}.`));
    if (val && f.pattern && !f.pattern.test(val)) return res.redirect(withMsg(back, "err", f.patternMsg ?? `${f.label} doesn't look right.`));
    if (val) v[f.key] = val; else delete v[f.key];
  }
  try {
    const { note } = await p.check(v);
    // Switching provider: the old one stops getting calls from us.
    if (w.voice_provider && w.voice_provider !== p.id) await logActivity(w.id, "setup", "phone", `Calling moved from ${voiceProvider(w.voice_provider)?.name ?? w.voice_provider} to ${p.name}`);
    const s = { ...voiceSettings(w), enabled: true };
    const kept = await provisionVoice(w, p, v, s);
    await saveVoiceValues(w, p.id, kept);
    await updateWorkspace(w.id, { voice_provider: p.id, voice_settings: JSON.stringify(s) });
    await logActivity(w.id, "setup", "phone", `Calling agent connected: ${p.name}`);
    res.redirect(withMsg(p.manual ? `${back}#manual` : back, "ok", p.manual
      ? `${p.name} details saved. Now set up the agent in ${p.name} with the text below, then use Test call to my phone.${note ? ` ${note}` : ""}`
      : `${p.name} is connected and your agent is ready. Use Test call to my phone to hear it.`));
  } catch (e: any) {
    res.redirect(withMsg(back, "err", e?.message || `Couldn't connect ${p.name}.`));
  }
});

voiceRoutes.post("/setup/calling/settings", requireLogin, checkCsrf, async (req, res) => {
  const w = await ws(req);
  const b = req.body;
  const s: VoiceSettings = voiceSettings({ voice_settings: JSON.stringify({
    enabled: b.enabled === "1", confirm: b.confirm === "1", remind: b.remind, canReschedule: b.can_reschedule === "1", canCancel: b.can_cancel === "1",
    inbound: b.inbound === "1", start: Number(b.start), end: Number(b.end), language: b.language, voice: b.voice, dailyCap: Number(b.daily_cap),
  }) });
  if (s.end - s.start < 2) return res.redirect(withMsg("/setup/calling", "err", "Calling hours must be at least 2 hours long."));
  const conn = await voiceConnection(w);
  if (!conn) return res.redirect("/setup/calling");
  try {
    const kept = await provisionVoice(w, conn.provider, conn.values, s);
    await saveVoiceValues(w, conn.provider.id, kept);
  } catch (e: any) {
    return res.redirect(withMsg("/setup/calling", "err", `Saved here, but ${conn.provider.name} didn't accept the update: ${e?.message}`));
  }
  await updateWorkspace(w.id, { voice_settings: JSON.stringify(s) });
  res.redirect(withMsg("/setup/calling", "ok", s.enabled ? "Saved. Your agent is updated." : "Saved. Calling is off."));
});

voiceRoutes.post("/setup/calling/test", requireLogin, checkCsrf, async (req, res) => {
  const w = await ws(req);
  const conn = await voiceConnection(w);
  if (!conn) return res.redirect("/setup/calling");
  const phone = normIndian(String(req.body.phone || ""));
  if (phone.length < 11 || phone.length > 15) return res.redirect(withMsg("/setup/calling", "err", "Enter your mobile number with country code."));
  if (rateLimited(`voice-test:${w.id}`, Number(process.env.AI_TEST_LIMIT || 5), 60 * 60_000)) return res.redirect(withMsg("/setup/calling", "err", "You've made a few test calls already. Try again in an hour."));
  const start = DateTime.now().setZone(w.timezone || "Asia/Kolkata").plus({ days: 1 }).set({ hour: 11, minute: 0 });
  const demo = { id: 0, ref: "BK-TEST1", customer_name: req.user!.name || "Test", customer_phone: phone, service_name: "Test booking", start_at: start.toISO()! } as unknown as Booking;
  try {
    await placeCall(w, conn.provider, conn.values, demo, "test");
    res.redirect(withMsg("/setup/calling", "ok", `Calling ${"+" + phone} now. Pick up to hear your agent.`));
  } catch (e: any) {
    res.redirect(withMsg("/setup/calling", "err", `The call didn't start: ${e?.message}`));
  }
});

voiceRoutes.post("/setup/calling/disconnect", requireLogin, checkCsrf, async (req, res) => {
  const w = await ws(req);
  const s = { ...voiceSettings(w), enabled: false };
  await updateWorkspace(w.id, { voice_provider: null, voice_settings: JSON.stringify(s) });
  await logActivity(w.id, "setup", "phone", "Calling agent disconnected");
  res.redirect(withMsg("/setup/calling", "ok", "Calling disconnected. No more calls will be made."));
});

voiceRoutes.get("/calls", requireLogin, async (req, res) => {
  const w = await ws(req);
  const rows = await db.all<CallRow & { customer_name: string | null }>(
    "SELECT c.*, b.customer_name FROM calls c LEFT JOIN bookings b ON b.id=c.booking_id WHERE c.workspace_id=? ORDER BY c.id DESC LIMIT 200", w.id);
  res.send(page(req, {
    title: "Calls",
    body: html`<nav class="stepper"><a class="back" href="/setup/calling">${icon("chevron", 14)} Calling agent</a></nav>
      <div class="page-head">${tile("send", "lg")}<div><p class="eyebrow">Calling agent</p><h1>Calls</h1></div></div>
      <div class="card">${rows.length ? html`<ul class="call-list">${rows.map((c) => callLine(w, c))}</ul>` : html`<p class="muted">No calls yet.</p>`}</div>`,
  }));
});

// ---------------------------------------------------------------- provider → us

/** Live tool calls during a phone call (needs the app awake: the provider waits for the answer). */
voiceHooks.post("/voice/tool/:provider/:id/:secret/:tool", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
  const provider = String(req.params.provider);
  const w = await owns(provider, String(req.params.id), String(req.params.secret));
  if (!w) return res.sendStatus(404);
  const rawBody = (req.body as Buffer).toString("utf8");
  const headers: Record<string, string> = {};
  for (const k of ["x-retell-signature", "elevenlabs-signature", "content-type"]) if (req.headers[k]) headers[k] = String(req.headers[k]);
  const r = await handleToolCall(w, provider, String(req.params.tool), { headers, body: rawBody, url: env.publicUrl + req.originalUrl });
  res.status(r.status).json(r.body);
});

/** Post-call reports: saved first, processed from the inbox (the edge worker saves the same rows). */
voiceHooks.post("/webhooks/voice/:provider/:id/:secret", express.raw({ type: "*/*", limit: "3mb" }), async (req, res) => {
  const provider = String(req.params.provider);
  const w = await owns(provider, String(req.params.id), String(req.params.secret));
  if (!w) return res.sendStatus(404);
  const rawBody = req.body as Buffer;
  const headers: Record<string, string> = { provider, url: (req.header("X-Booking-Edge") === "1" && env.webhookBase ? env.webhookBase : env.publicUrl) + req.originalUrl };
  for (const k of ["x-retell-signature", "elevenlabs-signature", "content-type"]) if (req.headers[k]) headers[k] = String(req.headers[k]);
  // The signature is part of the key: a badly signed copy mustn't block the real report.
  await saveEvent(w.id, "wh:voice", sha(Buffer.concat([rawBody, Buffer.from(`|${headers["x-retell-signature"] ?? ""}|${headers["elevenlabs-signature"] ?? ""}`)])), "", JSON.stringify({ headers, body: rawBody.toString("utf8") }));
  res.sendStatus(200);
  kickDrain();
});

