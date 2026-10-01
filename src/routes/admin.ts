import { Router, Request, Response } from "express";
import multer from "multer";
import { DateTime } from "luxon";
import { db, User } from "../db.js";
import { env } from "../env.js";
import { checkCsrf, endAllSessions, requireAdmin, requireLogin } from "../auth.js";
import {
  accessProblem, assignSharedKey, countActiveAdmins, createUser, daysLeft, deleteUser, getClaudeKey, getPayment, getUser,
  getUserByEmail, getWorkspaceForUser, listClaudeKeys, listPayments, listUsers, recentActivity, setPassword, todayIST,
} from "../models.js";
import { testAnthropicKey } from "../agent.js";
import { decrypt, encrypt, mask, tempPassword } from "../security.js";
import { deleteWebhook } from "../kapso.js";
import { html, raw } from "../views/html.js";
import { icon, tile } from "../views/icons.js";
import { csrfField, page, withMsg } from "../views/layout.js";
import { MODELS } from "./setup.js";

export const adminRoutes = Router();
adminRoutes.use("/admin", requireLogin, requireAdmin, checkCsrf);

const shotUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024, files: 1 } });
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const BACK = raw('<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>');

// ---------- Small view helpers ----------

function statusPill(u: User) {
  const p = accessProblem(u);
  if (!p) return html`<span class="pill ok"><i class="sdot"></i>Active</span>`;
  if (u.status !== "active") return html`<span class="pill"><i class="sdot"></i>Inactive</span>`;
  return html`<span class="pill bad"><i class="sdot"></i>Expired</span>`;
}

const PAY_LABEL = { paid: "Paid", pending: "Payment pending", trial: "Free trial" } as const;
function payPill(u: User) {
  if (u.role === "admin") return html`<span class="muted">—</span>`;
  const s = u.payment_status || "pending";
  return html`<span class="pill pay-${s}"><i class="sdot"></i>${s === "pending" ? "Pending" : PAY_LABEL[s]}</span>`;
}

function leftLabel(n: number | null): string {
  if (n === null) return "No expiry";
  if (n < 0) return `Ended ${-n} day${n === -1 ? "" : "s"} ago`;
  if (n === 0) return "Ends today";
  if (n === 1) return "Ends tomorrow";
  return `${n} days left`;
}

function prettyDate(d: string | null) {
  return d ? DateTime.fromISO(d).toFormat("d LLL yyyy") : "";
}

function avatar(name: string, email: string) {
  const label = (name || email).trim();
  const initials = label.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
  let h = 0;
  for (const ch of email) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return html`<span class="avatar" style="--h:${h}">${initials}</span>`;
}

function adminNav(active: "accounts" | "keys") {
  return html`<nav class="seg-nav" aria-label="Admin sections">
    <a href="/admin" class="${active === "accounts" ? "on" : ""}" ${active === "accounts" ? html`aria-current="page"` : ""}>${icon("users", 15)} Accounts</a>
    <a href="/admin/keys" class="${active === "keys" ? "on" : ""}" ${active === "keys" ? html`aria-current="page"` : ""}>${icon("key", 15)} Claude keys</a>
  </nav>`;
}

/** WhatsApp link with a ready-to-send renewal reminder (free: opens WhatsApp on the admin's phone/computer). */
function reminder(u: User) {
  const n = daysLeft(u);
  const when = n === null ? "" : n < 0 ? `ended on ${prettyDate(u.valid_until)}` : n === 0 ? "ends today" : `ends in ${n} day${n === 1 ? "" : "s"} (${prettyDate(u.valid_until)})`;
  const first = (u.name || "").split(/\s+/).find((w) => !/^(dr|mr|mrs|ms)\.?$/i.test(w)) || "there";
  const text = `Hi ${first}, a quick reminder: your ${env.appName} access ${when}. To keep your booking assistant answering customers without a break, please complete the renewal payment and share the screenshot here. Thank you!`;
  let digits = (u.phone || "").replace(/\D/g, "");
  if (digits.length === 10) digits = `91${digits}`;
  return { text, wa: `https://wa.me/${digits}?text=${encodeURIComponent(text)}`, hasPhone: digits.length >= 11 };
}

// ---------- Accounts list ----------

type Filter = "all" | "active" | "soon" | "pending" | "off";
const FILTERS: [Filter, string][] = [["all", "All"], ["active", "Active"], ["soon", "Ending soon"], ["pending", "Payment pending"], ["off", "Inactive or expired"]];

adminRoutes.get("/admin", async (req, res) => {
  const users = await listUsers();
  const q = String(req.query.q || "").toLowerCase();
  const f = (FILTERS.some(([k]) => k === req.query.f) ? req.query.f : "all") as Filter;
  const customers = users.filter((u) => u.role === "user");
  const isSoon = (u: User) => { const n = daysLeft(u); return !accessProblem(u) && n !== null && n <= 7; };
  const match: Record<Filter, (u: User) => boolean> = {
    all: () => true,
    active: (u) => !accessProblem(u),
    soon: (u) => u.role === "user" && isSoon(u),
    pending: (u) => u.role === "user" && u.payment_status === "pending",
    off: (u) => !!accessProblem(u),
  };
  const shown = users.filter(match[f]).filter((u) => !q || `${u.email} ${u.name} ${u.business_name ?? ""} ${u.phone}`.toLowerCase().includes(q));
  const count = (k: Filter) => (k === "all" ? users.length : users.filter(match[k]).length);
  const activeN = customers.filter((u) => !accessProblem(u)).length;
  const liveN = customers.filter((u) => u.setup.startsWith("Live")).length;
  const pendingN = customers.filter((u) => u.payment_status === "pending").length;
  const attention = customers.filter(isSoon).sort((a, b) => (a.valid_until! < b.valid_until! ? -1 : 1));
  res.send(
    page(req, {
      title: "Admin",
      wide: true,
      body: html`
        <div class="page-head spread">
          <div><p class="eyebrow">Admin</p><h1>Accounts</h1></div>
          <a class="btn" href="/admin/users/new">${icon("plus", 16)} New account</a>
        </div>
        ${adminNav("accounts")}
        <div class="stats four">
          <a class="stat card" href="/admin?f=all"><span class="tile sm" style="--tile:#007aff">${icon("users", 17)}</span><b data-count="${customers.length}">${customers.length}</b><span>Customers</span></a>
          <a class="stat card" href="/admin?f=active"><span class="tile sm" style="--tile:#34c759">${icon("check", 17)}</span><b data-count="${activeN}">${activeN}</b><span>Active · ${liveN} live</span></a>
          <a class="stat card" href="/admin?f=pending"><span class="tile sm" style="--tile:${pendingN ? "#ff9500" : "#8e8e93"}">${icon("wallet", 17)}</span><b data-count="${pendingN}">${pendingN}</b><span>Payment pending</span></a>
          <a class="stat card" href="/admin?f=soon"><span class="tile sm" style="--tile:${attention.length ? "#ff3b30" : "#8e8e93"}">${icon("clock", 17)}</span><b data-count="${attention.length}">${attention.length}</b><span>Ending in 7 days</span></a>
        </div>
        ${attention.length && f === "all" && !q
          ? html`<div class="card attention">
              <h2>${tile("bell")} Needs attention</h2>
              <ul class="att-list">
                ${attention.map((u) => {
                  const n = daysLeft(u)!;
                  const r = reminder(u);
                  return html`<li>
                    ${avatar(u.name, u.email)}
                    <a class="grow" href="/admin/users/${u.id}"><b>${u.name || u.email}</b><small>${u.business_name || u.email}</small></a>
                    <span class="left ${n <= 3 ? "urgent" : ""}">${leftLabel(n)}</span>
                    ${payPill(u)}
                    <a class="btn small secondary" href="${r.wa}" target="_blank" rel="noopener" title="${r.hasPhone ? "Opens WhatsApp with a reminder" : "Add their phone number to send directly"}">${icon("send", 14)} Remind</a>
                    <a class="btn small" href="/admin/users/${u.id}#payments">${icon("wallet", 14)} Record payment</a>
                  </li>`;
                })}
              </ul>
            </div>`
          : ""}
        <div class="list-tools">
          <form method="get" action="/admin" class="search" data-silent>
            ${raw('<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>')}
            <input type="hidden" name="f" value="${f}">
            <input type="search" name="q" value="${q}" placeholder="Search name, email, phone or business" aria-label="Search accounts" data-slash-focus>
            <kbd aria-hidden="true">/</kbd>
          </form>
          <div class="chips" role="tablist" aria-label="Filter accounts">
            ${FILTERS.map(([k, l]) => html`<a role="tab" aria-selected="${k === f ? "true" : "false"}" class="chip ${k === f ? "on" : ""}" href="/admin?f=${k}${q ? `&q=${encodeURIComponent(q)}` : ""}">${l}<i>${count(k)}</i></a>`)}
          </div>
        </div>
        <div class="card list table-scroll">
          <table class="accounts">
            <thead><tr><th>Account</th><th>Status</th><th>Payment</th><th>Valid until</th><th>Setup</th><th>Last login</th><th></th></tr></thead>
            <tbody>
              ${shown.map((u) => {
                const n = daysLeft(u);
                return html`<tr data-href="/admin/users/${u.id}">
                  <td><div class="who">${avatar(u.name, u.email)}<div><b>${u.name || "—"}</b>${u.role === "admin" ? html` <span class="tag">Admin</span>` : ""}${u.shared_key_id ? html` <span class="tag key" title="Uses a Claude key we provide">${icon("key", 11)} Our key</span>` : ""}<small>${u.email}${u.business_name ? ` · ${u.business_name}` : ""}</small></div></div></td>
                  <td>${statusPill(u)}</td>
                  <td>${payPill(u)}${u.last_paid_on ? html`<small class="sub-cell">Last ${prettyDate(u.last_paid_on)}</small>` : ""}</td>
                  <td>${u.valid_until ? prettyDate(u.valid_until) : html`<span class="muted">No expiry</span>`}${u.valid_until && !accessProblem(u) && n !== null && n <= 7 ? html`<br><span class="tag warn">${leftLabel(n)}</span>` : ""}</td>
                  <td>${u.setup.startsWith("Live") ? html`<span class="pill ok">${u.setup}</span>` : html`<span class="muted">${u.setup}</span>`}</td>
                  <td class="muted">${u.last_login_at ? u.last_login_at.slice(0, 16) : "Never"}</td>
                  <td class="end"><a href="/admin/users/${u.id}" class="chev" aria-label="Edit ${u.email}">${icon("chevron", 16)}</a></td>
                </tr>`;
              })}
            </tbody>
          </table>
          ${shown.length ? "" : html`<div class="empty">${tile("users", "lg")}<b>${q ? "No matches" : "Nothing here"}</b><span>${q ? "Try a different name or email." : "No accounts match this filter."}</span></div>`}
        </div>`,
    })
  );
});

// ---------- Account form ----------

interface FormValues {
  name: string; email: string; phone: string; role: "user" | "admin"; status: "active" | "inactive"; validUntil: string | null;
  permWidget: boolean; permWhatsapp: boolean; notes: string; paymentStatus: "paid" | "pending" | "trial";
  sharedKey: string; newKeyName: string; newKeyModel: string;
}

function valuesOf(u: User, sharedKeyId: number | null): FormValues {
  return {
    name: u.name, email: u.email, phone: u.phone || "", role: u.role, status: u.status, validUntil: u.valid_until,
    permWidget: !!u.perm_widget, permWhatsapp: !!u.perm_whatsapp, notes: u.notes, paymentStatus: u.payment_status || "pending",
    sharedKey: sharedKeyId ? String(sharedKeyId) : "", newKeyName: "", newKeyModel: env.defaultModel,
  };
}

async function userForm(req: Request, v: FormValues | null, id?: number) {
  const isNew = !id;
  const keys = await listClaudeKeys();
  const sharedOn = !!v?.sharedKey;
  return html`
    <form method="post" action="${isNew ? "/admin/users/new" : `/admin/users/${id}`}" data-busy="${isNew ? "Creating…" : "Saving…"}" data-role-form>
      ${csrfField(req)}
      <div class="grid">
        <div><label>Name</label><input type="text" name="name" value="${v?.name ?? ""}" required placeholder="Dr. Mehta"></div>
        <div><label>Email</label><input type="email" name="email" value="${v?.email ?? ""}" required placeholder="owner@clinic.com"></div>
        <div><label>WhatsApp number <span class="hint">for renewal reminders</span></label><input type="tel" name="phone" value="${v?.phone ?? ""}" placeholder="+91 98765 43210" autocomplete="off"></div>
      </div>
      <div class="grid">
        <div>
          <label>Role</label>
          <select name="role" data-role-select>
            <option value="user" ${v?.role !== "admin" ? "selected" : ""}>Customer</option>
            <option value="admin" ${v?.role === "admin" ? "selected" : ""}>Admin (can manage all accounts)</option>
          </select>
        </div>
        <div>
          <label>Status</label>
          <select name="status">
            <option value="active" ${v?.status !== "inactive" ? "selected" : ""}>Active</option>
            <option value="inactive" ${v?.status === "inactive" ? "selected" : ""}>Inactive (can't log in, bot stops)</option>
          </select>
        </div>
        <div>
          <label>Valid until <span class="hint">empty = no expiry</span></label>
          <input type="date" name="valid_until" value="${v ? v.validUntil ?? "" : DateTime.now().plus({ days: 30 }).toISODate()}">
          <div class="quick-dates" data-quick-dates ${v ? "" : html`data-base="${todayIST()}"`}>
            ${[["+7d", "1 week"], ["+1m", "1 month"], ["+3m", "3 months"], ["+1y", "1 year"]].map(([k, l]) => html`<button type="button" class="chip" data-add="${k}">${l}</button>`)}
          </div>
        </div>
      </div>
      <div class="grid" data-customer-only>
        <div>
          <label>Payment</label>
          <div class="segmented pay" role="radiogroup" aria-label="Payment status">
            ${(["paid", "pending", "trial"] as const).map((s) => html`<label class="${s}"><input type="radio" name="payment_status" value="${s}" ${(v?.paymentStatus ?? "pending") === s ? "checked" : ""}><span>${PAY_LABEL[s]}</span></label>`)}
          </div>
        </div>
      </div>
      <label>Allowed channels</label>
      <div class="checks">
        <label><input type="checkbox" name="perm_widget" value="1" ${!v || v.permWidget ? "checked" : ""}> Website chat widget</label>
        <label><input type="checkbox" name="perm_whatsapp" value="1" ${!v || v.permWhatsapp ? "checked" : ""}> WhatsApp</label>
      </div>
      <label>Internal notes <span class="hint">plan, deal, anything useful. Only admins see this</span></label>
      <textarea name="notes" placeholder="e.g. ₹999/month plan, referred by…">${v?.notes ?? ""}</textarea>

      <details class="advanced" data-customer-only ${sharedOn || v?.sharedKey === "new" ? "open" : ""}>
        <summary>${icon("key", 15)} Advanced<span class="hint">Provide our Claude key</span>${sharedOn && v?.sharedKey !== "new" ? html`<span class="tag key">On</span>` : ""}</summary>
        <div class="adv-body">
          <p class="muted">Off by default: customers connect their own Claude key and pay Anthropic themselves. Turn this on only for customers whose Claude usage we cover. They skip the Claude step and never see the key.</p>
          <label>Claude key</label>
          <select name="shared_key" data-shared-key>
            <option value="" ${!sharedOn ? "selected" : ""}>Off: customer uses their own key</option>
            ${keys.map((k) => html`<option value="${k.id}" ${v?.sharedKey === String(k.id) ? "selected" : ""}>${k.name} (${mask(decrypt(k.key_enc) || "")})</option>`)}
            <option value="new" ${v?.sharedKey === "new" ? "selected" : ""}>+ Add a new key…</option>
          </select>
          <div class="new-key" data-new-key hidden>
            <div class="grid">
              <div><label>Name the key</label><input type="text" name="new_key_name" value="${v?.newKeyName ?? ""}" placeholder="e.g. Main key" maxlength="60"></div>
              <div><label>Model</label><select name="new_key_model">${MODELS.map((m) => html`<option value="${m.id}" ${m.id === (v?.newKeyModel || env.defaultModel) ? "selected" : ""}>${m.label}</option>`)}</select></div>
            </div>
            <label>API key</label>
            <input type="password" name="new_key_value" placeholder="sk-ant-…" autocomplete="off">
            <p class="hint">We test it before saving. You can reuse it for other customers and manage it under Claude keys.</p>
          </div>
        </div>
      </details>
      <div class="row"><button>${isNew ? "Create account" : "Save changes"}</button><a class="btn secondary" href="/admin">Cancel</a></div>
    </form>`;
}

function readForm(req: Request): FormValues {
  const b = req.body as Record<string, string>;
  const validUntil = (b.valid_until || "").trim() || null;
  const ps = b.payment_status;
  return {
    name: (b.name || "").trim(),
    email: (b.email || "").trim().toLowerCase(),
    phone: (b.phone || "").replace(/[^\d+\s-]/g, "").trim().slice(0, 20),
    role: b.role === "admin" ? "admin" : "user",
    status: b.status === "inactive" ? "inactive" : "active",
    validUntil: validUntil && /^\d{4}-\d{2}-\d{2}$/.test(validUntil) ? validUntil : null,
    permWidget: b.perm_widget === "1",
    permWhatsapp: b.perm_whatsapp === "1",
    notes: (b.notes || "").slice(0, 2000),
    paymentStatus: ps === "paid" || ps === "trial" ? ps : "pending",
    sharedKey: b.shared_key === "new" || /^\d+$/.test(b.shared_key || "") ? b.shared_key! : "",
    newKeyName: (b.new_key_name || "").trim().slice(0, 60),
    newKeyModel: MODELS.some((m) => m.id === b.new_key_model) ? b.new_key_model! : env.defaultModel,
  };
}

/** Works out which of our keys to assign. Creates (and tests) a new one when asked. Throws a readable error. */
async function resolveSharedKey(req: Request, f: FormValues): Promise<number | null> {
  if (f.role === "admin" || !f.sharedKey) return null;
  if (f.sharedKey !== "new") {
    const k = await getClaudeKey(Number(f.sharedKey));
    if (!k) throw new Error("That Claude key no longer exists. Pick another one.");
    return k.id;
  }
  const value = String(req.body.new_key_value || "").trim();
  return await addClaudeKey(f.newKeyName, value, f.newKeyModel);
}

async function addClaudeKey(name: string, value: string, model: string): Promise<number> {
  if (!name) throw new Error("Give the new Claude key a name, e.g. \"Main key\".");
  if (!value.startsWith("sk-ant-")) throw new Error("That doesn't look like an Anthropic key. It should start with sk-ant-");
  if (await db.get("SELECT id FROM claude_keys WHERE name = ? COLLATE NOCASE", name)) throw new Error(`A key named "${name}" already exists. Pick it from the list or use another name.`);
  await testAnthropicKey(value, model);
  const r = await db.run("INSERT INTO claude_keys (name, key_enc, model) VALUES (?,?,?)", name, encrypt(value), model);
  return r.lastId;
}

function showPassword(req: Request, res: Response, u: User, pw: string, heading: string) {
  const loginMessage = `Your ${env.appName} login\nLink: ${env.publicUrl}/login\nEmail: ${u.email}\nTemporary password: ${pw}\n(You'll set your own password when you first log in.)`;
  let digits = (u.phone || "").replace(/\D/g, "");
  if (digits.length === 10) digits = `91${digits}`;
  res.send(
    page(req, {
      title: heading,
      body: html`
        <div class="success-head">${tile("check", "lg")}<h1>${heading}</h1></div>
        <p class="sub">Copy these login details now and send them to ${u.name || u.email}. The password is not shown again.</p>
        <div class="card">
          <p><b>Login link:</b> <span class="mono">${env.publicUrl}/login</span></p>
          <p><b>Email:</b> <span class="mono">${u.email}</span></p>
          <div class="secret-box"><span class="mono" id="pw" data-copy="${pw}" title="Click to copy">${pw}</span></div>
          <p class="hint">Click the password to copy it. They'll be asked to choose their own password on first login.</p>
          <pre id="login-msg">${loginMessage}</pre>
          <div class="row">
            <button type="button" data-copy="${loginMessage}" data-copy-select="login-msg">Copy message</button>
            ${digits.length >= 11 ? html`<a class="btn secondary" href="https://wa.me/${digits}?text=${encodeURIComponent(loginMessage)}" target="_blank" rel="noopener">${icon("send", 15)} Send on WhatsApp</a>` : ""}
            <a class="btn secondary" href="/admin/users/${u.id}">Back to account</a>
          </div>
        </div>`,
    })
  );
}

async function newAccountPage(req: Request, v: FormValues | null, err?: string) {
  return page(req, {
    title: "New account",
    flash: err ? { type: "err", text: err } : null,
    body: html`<nav class="stepper"><a class="back" href="/admin">${BACK} All accounts</a></nav>
      <div class="page-head">${tile("users", "lg")}<div><p class="eyebrow">Admin</p><h1>New account</h1></div></div>
      <p class="sub">A temporary password is created for them. You'll copy it on the next screen.</p>
      <div class="card">${await userForm(req, v)}</div>`,
  });
}

adminRoutes.get("/admin/users/new", async (req, res) => {
  res.send(await newAccountPage(req, null));
});

adminRoutes.post("/admin/users/new", async (req, res) => {
  const f = readForm(req);
  if (!f.email || !f.name) return res.send(await newAccountPage(req, f, "Name and email are required."));
  if (await getUserByEmail(f.email)) return res.send(await newAccountPage(req, f, "An account with this email already exists."));
  let keyId: number | null;
  try {
    keyId = await resolveSharedKey(req, f);
  } catch (e: any) {
    return res.send(await newAccountPage(req, f, e.message));
  }
  const pw = tempPassword();
  const id = await createUser({ ...f, password: pw });
  await db.run("UPDATE users SET status=?, phone=?, payment_status=? WHERE id=?", f.status, f.phone, f.role === "admin" ? "paid" : f.paymentStatus, id);
  const u = (await getUser(id))!;
  await getWorkspaceForUser(id);
  if (keyId) await assignSharedKey(id, keyId);
  showPassword(req, res, u, pw, "Account created");
});

// ---------- Account detail ----------

async function accountPage(req: Request, u: User, formValues?: FormValues, err?: string) {
  const ws = await getWorkspaceForUser(u.id);
  const act = await recentActivity(ws.id, 15);
  const payments = u.role === "user" ? await listPayments(u.id) : [];
  const sharedKey = ws.shared_key_id ? await getClaudeKey(ws.shared_key_id) : undefined;
  const n = daysLeft(u);
  const r = reminder(u);
  const extendFrom = u.valid_until && u.valid_until >= todayIST() ? u.valid_until : todayIST();
  const steps = [
    ["Business details", ws.business_done],
    [sharedKey ? `Claude (our key: ${sharedKey.name})` : "Claude", ws.claude_ok],
    ["Google Calendar", ws.google_ok],
    ["Test chat", ws.tested],
    ["Widget live", ws.widget_enabled],
    ["WhatsApp live", ws.whatsapp_enabled],
  ] as const;
  return page(req, {
    title: u.email,
    flash: err ? { type: "err", text: err } : null,
    body: html`
      <nav class="stepper"><a class="back" href="/admin">${BACK} All accounts</a></nav>
      <div class="page-head">${avatar(u.name, u.email)}<div><p class="eyebrow">${u.role === "admin" ? "Admin" : "Customer"} · since ${prettyDate(u.created_at.slice(0, 10))}</p><h1>${u.name || u.email}</h1><p class="sub tight">${u.email} · ${statusPill(u)} ${u.role === "user" ? payPill(u) : ""}</p></div></div>

      ${u.role === "user"
        ? html`<div class="card sub-card" id="payments">
            <div class="sub-top">
              <div class="sub-meter ${n !== null && n <= 3 ? "urgent" : ""}">
                <span class="tile lg" style="--tile:${n === null ? "#8e8e93" : n < 0 ? "#ff3b30" : n <= 3 ? "#ff9500" : "#34c759"}">${icon("clock", 26)}</span>
                <div><b>${leftLabel(n)}</b><small>${u.valid_until ? `Valid until ${prettyDate(u.valid_until)}` : "This account never expires"}</small></div>
              </div>
              <div class="row tight">
                ${n !== null && n <= 7 ? html`<a class="btn secondary" href="${r.wa}" target="_blank" rel="noopener">${icon("send", 15)} Remind on WhatsApp</a>
                <button type="button" class="secondary" data-copy="${r.text}">Copy reminder</button>` : ""}
                <button type="button" data-open="record-payment">${icon("plus", 15)} Record payment</button>
              </div>
            </div>
            ${n !== null && n <= 7 && !r.hasPhone ? html`<p class="hint">Add their WhatsApp number above to open the reminder straight in their chat.</p>` : ""}
            <form method="post" action="/admin/users/${u.id}/payments?_csrf=${req.csrf}" enctype="multipart/form-data" class="record-payment" id="record-payment" data-busy="Saving payment…" hidden>
              <h3>Record a payment</h3>
              <div class="grid">
                <div><label>Amount</label><div class="affix"><span>₹</span><input type="text" name="amount" inputmode="decimal" placeholder="999" required maxlength="20"></div></div>
                <div><label>Paid on</label><input type="date" name="paid_on" value="${todayIST()}" required></div>
                <div><label>Method</label><select name="method">${["UPI", "Bank transfer", "Cash", "Card", "Other"].map((m) => html`<option>${m}</option>`)}</select></div>
              </div>
              <div class="grid">
                <div><label>Reference <span class="hint">UPI / transaction ID</span></label><input type="text" name="reference" maxlength="80" placeholder="e.g. 4123 5678 9012"></div>
                <div><label>Note</label><input type="text" name="note" maxlength="300" placeholder="e.g. 3 month plan"></div>
              </div>
              <label>Screenshot <span class="hint">optional · PNG or JPG</span></label>
              <label class="dropzone image" data-imagedrop>
                <input type="file" name="screenshot" accept="image/png,image/jpeg,image/webp">
                <img alt="" data-img-preview hidden>
                <span class="dz-icon" aria-hidden="true">${icon("image", 26)}</span>
                <b data-dz-title>Drop the payment screenshot</b>
                <span data-dz-sub>or click to choose, or paste it with ⌘V</span>
              </label>
              <label class="switch-row"><input type="checkbox" name="extend" value="1" checked data-extend-toggle> <span><b>Extend access</b><small>Also move “valid until” forward and reactivate if needed</small></span></label>
              <div class="grid" data-extend-fields>
                <div><label>New valid until</label><input type="date" name="extend_to" value="${DateTime.fromISO(extendFrom).plus({ months: 1 }).toISODate()}" data-extend-base="${extendFrom}"></div>
                <div><label>&nbsp;</label><div class="quick-dates" data-quick-dates data-base="${extendFrom}">${[["+1m", "+1 month"], ["+3m", "+3 months"], ["+6m", "+6 months"], ["+1y", "+1 year"]].map(([k, l]) => html`<button type="button" class="chip" data-add="${k}">${l}</button>`)}</div></div>
              </div>
              <div class="row"><button>Save payment</button><button type="button" class="secondary" data-close="record-payment">Cancel</button></div>
            </form>
            <h3>Payment history</h3>
            ${payments.length
              ? html`<ul class="pay-list">${payments.map((p) => html`<li>
                  <span class="tile sm" style="--tile:#34c759">${icon("wallet", 17)}</span>
                  <div class="grow"><b>₹${p.amount}</b> <span class="muted">· ${p.method} · ${prettyDate(p.paid_on)}</span>
                    <small>${[p.reference && `Ref ${p.reference}`, p.note, p.extended_to && `Extended to ${prettyDate(p.extended_to)}`, p.recorded_by && `by ${p.recorded_by}`].filter(Boolean).join(" · ")}</small></div>
                  ${p.has_shot ? html`<a class="shot" href="/admin/payments/${p.id}/screenshot" data-lightbox title="View screenshot"><img src="/admin/payments/${p.id}/screenshot" alt="Payment screenshot" loading="lazy"></a>` : ""}
                  <form method="post" action="/admin/payments/${p.id}/delete" data-confirm="Delete this payment?" data-confirm-detail="₹${p.amount} on ${prettyDate(p.paid_on)}. Validity isn't changed." data-confirm-ok="Delete">
                    ${csrfField(req)}<button class="icon-btn danger-ghost" aria-label="Delete payment">${icon("trash", 16)}</button>
                  </form>
                </li>`)}</ul>`
              : html`<p class="muted">No payments recorded yet.</p>`}
          </div>`
        : ""}

      <div class="card"><h2>Account</h2>${await userForm(req, formValues ?? valuesOf(u, ws.shared_key_id), u.id)}</div>
      <div class="card">
        <h2>Password</h2>
        <p class="muted">Creates a new temporary password and logs them out everywhere.</p>
        <form method="post" action="/admin/users/${u.id}/reset-password" data-confirm="Reset password?" data-confirm-detail="${u.email} gets a new temporary password and is logged out everywhere." data-confirm-ok="Reset">
          ${csrfField(req)}<button class="secondary">Reset password</button>
        </form>
      </div>
      <div class="card">
        <h2>Setup progress${ws.business_name ? ` · ${ws.business_name}` : ""}</h2>
        <div class="checks">${steps.map(([s, d]) => html`<span class="pill ${d ? "ok" : ""}">${d ? "✓" : "○"} ${s}</span>`)}</div>
        <h3>Recent activity</h3>
        ${act.length
          ? html`<table><tbody>${act.map((a) => html`<tr><td class="hint">${a.created_at.slice(0, 16)}</td><td>${a.kind}</td><td>${a.channel}</td><td>${a.detail}</td></tr>`)}</tbody></table>`
          : html`<p class="muted">Nothing yet.</p>`}
      </div>
      ${u.id !== req.user!.id
        ? html`<div class="card">
            <h2>Delete account</h2>
            <p class="muted">Removes the account, its setup, payments and stored keys. Bookings already in Google Calendar stay there.</p>
            <form method="post" action="/admin/users/${u.id}/delete" data-confirm="Delete this account?" data-confirm-detail="${u.email}, its setup and stored keys are removed permanently. This can't be undone." data-confirm-ok="Delete">
              ${csrfField(req)}<button class="danger">Delete account</button>
            </form>
          </div>`
        : ""}`,
  });
}

adminRoutes.get("/admin/users/:id", async (req, res) => {
  const u = await getUser(Number(req.params.id));
  if (!u) return res.status(404).send("Not found");
  res.send(await accountPage(req, u));
});

adminRoutes.post("/admin/users/:id", async (req, res) => {
  const u = await getUser(Number(req.params.id));
  if (!u) return res.status(404).send("Not found");
  const f = readForm(req);
  const back = `/admin/users/${u.id}`;
  const fail = async (m: string) => res.send(await accountPage(req, u, f, m));
  if (!f.email || !f.name) return fail("Name and email are required.");
  const other = await getUserByEmail(f.email);
  if (other && other.id !== u.id) return fail("Another account already uses this email.");
  const losingAdmin = u.role === "admin" && u.status === "active" && (f.role !== "admin" || f.status !== "active");
  if (losingAdmin && (await countActiveAdmins()) <= 1) return fail("You can't remove the last active admin.");
  if (u.id === req.user!.id && (f.role !== "admin" || f.status !== "active")) return fail("You can't remove your own admin access or deactivate yourself.");
  let keyId: number | null;
  try {
    keyId = await resolveSharedKey(req, f);
  } catch (e: any) {
    return fail(e.message);
  }
  await db.run(
    `UPDATE users SET name=?, email=?, phone=?, role=?, status=?, valid_until=?, perm_widget=?, perm_whatsapp=?, notes=?, payment_status=? WHERE id=?`,
    f.name, f.email, f.phone, f.role, f.status, f.validUntil, f.permWidget ? 1 : 0, f.permWhatsapp ? 1 : 0, f.notes,
    f.role === "admin" ? u.payment_status : f.paymentStatus, u.id
  );
  const ws = await getWorkspaceForUser(u.id);
  await assignSharedKey(u.id, keyId);
  // Turning a channel permission off also switches that channel off.
  if (!f.permWidget) await db.run("UPDATE workspaces SET widget_enabled=0 WHERE id=?", ws.id);
  if (!f.permWhatsapp) await db.run("UPDATE workspaces SET whatsapp_enabled=0 WHERE id=?", ws.id);
  if (f.status === "inactive") await endAllSessions(u.id);
  res.redirect(withMsg(back, "ok", "Saved."));
});

adminRoutes.post("/admin/users/:id/reset-password", async (req, res) => {
  const u = await getUser(Number(req.params.id));
  if (!u) return res.status(404).send("Not found");
  const pw = tempPassword();
  await setPassword(u.id, pw, true);
  await endAllSessions(u.id);
  showPassword(req, res, u, pw, "Password reset");
});

adminRoutes.post("/admin/users/:id/delete", async (req, res) => {
  const u = await getUser(Number(req.params.id));
  if (!u) return res.status(404).send("Not found");
  if (u.id === req.user!.id) return res.redirect(withMsg(`/admin/users/${u.id}`, "err", "You can't delete yourself."));
  if (u.role === "admin" && u.status === "active" && (await countActiveAdmins()) <= 1) {
    return res.redirect(withMsg(`/admin/users/${u.id}`, "err", "You can't delete the last active admin."));
  }
  // Remove our webhook from their Kapso number so WhatsApp stops calling us.
  const w = await getWorkspaceForUser(u.id);
  const key = decrypt(w.kapso_key_enc);
  if (key && w.kapso_phone_number_id && w.kapso_webhook_id) {
    await deleteWebhook(key, w.kapso_phone_number_id, w.kapso_webhook_id).catch(() => undefined);
  }
  await deleteUser(u.id);
  res.redirect(withMsg("/admin", "ok", `Deleted ${u.email}.`));
});

// ---------- Payments ----------

adminRoutes.post("/admin/users/:id/payments", shotUpload.single("screenshot"), async (req, res) => {
  const u = await getUser(Number(req.params.id));
  if (!u || u.role !== "user") return res.status(404).send("Not found");
  const back = `/admin/users/${u.id}#payments`;
  const b = req.body as Record<string, string>;
  const amount = String(b.amount || "").replace(/[^\d.,]/g, "").slice(0, 20);
  const paidOn = /^\d{4}-\d{2}-\d{2}$/.test(b.paid_on || "") ? b.paid_on! : todayIST();
  if (!amount) return res.redirect(withMsg(back, "err", "Enter the amount paid."));
  let shot: string | null = null, shotType: string | null = null;
  if (req.file && req.file.size) {
    if (!IMAGE_TYPES.has(req.file.mimetype)) return res.redirect(withMsg(back, "err", "The screenshot must be a PNG, JPG or WebP image."));
    shot = req.file.buffer.toString("base64");
    shotType = req.file.mimetype;
  }
  const extendTo = b.extend === "1" && /^\d{4}-\d{2}-\d{2}$/.test(b.extend_to || "") ? b.extend_to! : null;
  await db.run(
    `INSERT INTO payments (user_id, amount, paid_on, method, reference, note, screenshot, screenshot_type, extended_to, recorded_by)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    u.id, amount, paidOn, String(b.method || "").slice(0, 30), String(b.reference || "").slice(0, 80), String(b.note || "").slice(0, 300),
    shot, shotType, extendTo, req.user!.name || req.user!.email
  );
  if (extendTo) await db.run("UPDATE users SET payment_status='paid', valid_until=?, status='active' WHERE id=?", extendTo, u.id);
  else await db.run("UPDATE users SET payment_status='paid' WHERE id=?", u.id);
  res.redirect(withMsg(back, "ok", extendTo ? `Payment saved. Access extended to ${prettyDate(extendTo)}.` : "Payment saved."));
});

adminRoutes.get("/admin/payments/:id/screenshot", async (req, res) => {
  const p = await getPayment(Number(req.params.id));
  if (!p || !p.screenshot || !IMAGE_TYPES.has(p.screenshot_type || "")) return res.status(404).send("Not found");
  res.setHeader("Content-Type", p.screenshot_type!);
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.setHeader("Content-Security-Policy", "default-src 'none'");
  res.send(Buffer.from(p.screenshot, "base64"));
});

adminRoutes.post("/admin/payments/:id/delete", async (req, res) => {
  const p = await getPayment(Number(req.params.id));
  if (!p) return res.status(404).send("Not found");
  await db.run("DELETE FROM payments WHERE id = ?", p.id);
  res.redirect(withMsg(`/admin/users/${p.user_id}#payments`, "ok", "Payment deleted."));
});

// ---------- Claude keys we provide ----------

adminRoutes.get("/admin/keys", async (req, res) => {
  const keys = await listClaudeKeys();
  const users = keys.length
    ? await db.all<{ shared_key_id: number; name: string; email: string; id: number }>(
        "SELECT w.shared_key_id, u.name, u.email, u.id FROM workspaces w JOIN users u ON u.id = w.user_id WHERE w.shared_key_id IS NOT NULL ORDER BY u.name"
      )
    : [];
  res.send(
    page(req, {
      title: "Claude keys",
      wide: true,
      body: html`
        <div class="page-head spread">
          <div><p class="eyebrow">Admin</p><h1>Claude keys</h1></div>
          <button type="button" data-open="add-key">${icon("plus", 16)} Add key</button>
        </div>
        ${adminNav("keys")}
        <p class="sub">Keys we own and can give to specific customers (Advanced section of an account). Customers never see them, and their usage is billed to our Anthropic account.</p>
        <div class="card" id="add-key" ${keys.length ? html`hidden` : ""}>
          <h2>Add a key</h2>
          <form method="post" action="/admin/keys" data-busy="Testing the key…">
            ${csrfField(req)}
            <div class="grid">
              <div><label>Name</label><input type="text" name="name" required maxlength="60" placeholder="e.g. Main key"></div>
              <div><label>Model</label><select name="model">${MODELS.map((m) => html`<option value="${m.id}" ${m.id === env.defaultModel ? "selected" : ""}>${m.label}</option>`)}</select></div>
            </div>
            <label>API key</label>
            <input type="password" name="key" required placeholder="sk-ant-…" autocomplete="off">
            <div class="row"><button>Test and save</button>${keys.length ? html`<button type="button" class="secondary" data-close="add-key">Cancel</button>` : ""}</div>
          </form>
        </div>
        ${keys.length
          ? html`<div class="key-grid">${keys.map((k) => {
              const who = users.filter((x) => x.shared_key_id === k.id);
              return html`<div class="card key-card">
                <div class="key-top">${tile("key", "lg")}<div class="grow"><h2>${k.name}</h2><span class="mono muted">${mask(decrypt(k.key_enc) || "")}</span></div></div>
                <p class="muted small">${MODELS.find((m) => m.id === k.model)?.label.replace(/ \(.*/, "") ?? k.model} · added ${prettyDate(k.created_at.slice(0, 10))}</p>
                <div class="key-users">${who.length
                  ? who.map((x) => html`<a class="chip" href="/admin/users/${x.id}">${x.name || x.email}</a>`)
                  : html`<span class="muted small">Not given to anyone yet</span>`}</div>
                <details class="advanced">
                  <summary>Replace key or change model</summary>
                  <form method="post" action="/admin/keys/${k.id}" data-busy="Testing…" class="adv-body">
                    ${csrfField(req)}
                    <label>Name</label><input type="text" name="name" value="${k.name}" required maxlength="60">
                    <label>Model</label><select name="model">${MODELS.map((m) => html`<option value="${m.id}" ${m.id === k.model ? "selected" : ""}>${m.label}</option>`)}</select>
                    <label>New API key <span class="hint">leave empty to keep the current one</span></label>
                    <input type="password" name="key" placeholder="sk-ant-…" autocomplete="off">
                    <div class="row"><button>Save</button></div>
                  </form>
                </details>
                <form method="post" action="/admin/keys/${k.id}/delete" data-confirm="Delete “${k.name}”?" data-confirm-detail="${who.length ? `${who.length} customer${who.length === 1 ? " uses" : "s use"} it. Take it off their accounts first.` : "The key is removed from this app. It keeps working in Anthropic until you revoke it there."}" data-confirm-ok="Delete">
                  ${csrfField(req)}<button class="danger small" ${who.length ? html`disabled title="In use"` : ""}>Delete key</button>
                </form>
              </div>`;
            })}</div>`
          : ""}`,
    })
  );
});

adminRoutes.post("/admin/keys", async (req, res) => {
  const b = req.body as Record<string, string>;
  const model = MODELS.some((m) => m.id === b.model) ? b.model! : env.defaultModel;
  try {
    await addClaudeKey(String(b.name || "").trim().slice(0, 60), String(b.key || "").trim(), model);
  } catch (e: any) {
    return res.redirect(withMsg("/admin/keys", "err", e.message));
  }
  res.redirect(withMsg("/admin/keys", "ok", "Key tested and saved."));
});

adminRoutes.post("/admin/keys/:id", async (req, res) => {
  const k = await getClaudeKey(Number(req.params.id));
  if (!k) return res.status(404).send("Not found");
  const b = req.body as Record<string, string>;
  const name = String(b.name || "").trim().slice(0, 60) || k.name;
  const model = MODELS.some((m) => m.id === b.model) ? b.model! : k.model;
  const newKey = String(b.key || "").trim();
  const clash = await db.get("SELECT id FROM claude_keys WHERE name = ? COLLATE NOCASE AND id != ?", name, k.id);
  if (clash) return res.redirect(withMsg("/admin/keys", "err", `Another key is already named "${name}".`));
  try {
    if (newKey && !newKey.startsWith("sk-ant-")) throw new Error("That doesn't look like an Anthropic key. It should start with sk-ant-");
    if (newKey || model !== k.model) await testAnthropicKey(newKey || decrypt(k.key_enc)!, model);
  } catch (e: any) {
    return res.redirect(withMsg("/admin/keys", "err", e.message));
  }
  await db.run("UPDATE claude_keys SET name=?, model=?, key_enc=? WHERE id=?", name, model, newKey ? encrypt(newKey) : k.key_enc, k.id);
  res.redirect(withMsg("/admin/keys", "ok", newKey ? "Key replaced. Every customer on it now uses the new key." : "Saved."));
});

adminRoutes.post("/admin/keys/:id/delete", async (req, res) => {
  const k = await getClaudeKey(Number(req.params.id));
  if (!k) return res.status(404).send("Not found");
  const used = Number((await db.get("SELECT COUNT(*) AS c FROM workspaces WHERE shared_key_id = ?", k.id))?.c ?? 0);
  if (used) return res.redirect(withMsg("/admin/keys", "err", "This key is still given to customers. Take it off their accounts first."));
  await db.run("DELETE FROM claude_keys WHERE id = ?", k.id);
  res.redirect(withMsg("/admin/keys", "ok", `Deleted “${k.name}”.`));
});

