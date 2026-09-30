import { Router, Request, Response } from "express";
import { DateTime } from "luxon";
import { db, User } from "../db.js";
import { env } from "../env.js";
import { checkCsrf, endAllSessions, requireAdmin, requireLogin } from "../auth.js";
import { accessProblem, countActiveAdmins, createUser, deleteUser, getUser, getUserByEmail, getWorkspaceForUser, listUsers, recentActivity, setPassword } from "../models.js";
import { decrypt, tempPassword } from "../security.js";
import { deleteWebhook } from "../kapso.js";
import { html, raw } from "../views/html.js";
import { icon, tile } from "../views/icons.js";
import { csrfField, page, withMsg } from "../views/layout.js";

export const adminRoutes = Router();
adminRoutes.use("/admin", requireLogin, requireAdmin, checkCsrf);

function statusPill(u: User) {
  const p = accessProblem(u);
  if (!p) return html`<span class="pill ok"><i class="sdot"></i>Active</span>`;
  if (u.status !== "active") return html`<span class="pill"><i class="sdot"></i>Inactive</span>`;
  return html`<span class="pill bad"><i class="sdot"></i>Expired</span>`;
}

function avatar(name: string, email: string) {
  const label = (name || email).trim();
  const initials = label.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
  let h = 0;
  for (const ch of email) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return html`<span class="avatar" style="--h:${h}">${initials}</span>`;
}

adminRoutes.get("/admin", async (req, res) => {
  const users = await listUsers();
  const q = String(req.query.q || "").toLowerCase();
  const shown = q ? users.filter((u) => `${u.email} ${u.name} ${u.business_name ?? ""}`.toLowerCase().includes(q)) : users;
  const soon = DateTime.now().plus({ days: 7 }).toISODate()!;
  const customers = users.filter((u) => u.role === "user");
  const activeN = customers.filter((u) => !accessProblem(u)).length;
  const soonN = customers.filter((u) => !accessProblem(u) && u.valid_until && u.valid_until <= soon).length;
  const offN = customers.length - activeN;
  const liveN = customers.filter((u) => u.setup.startsWith("Live")).length;
  res.send(
    page(req, {
      title: "Admin",
      wide: true,
      body: html`
        <div class="page-head spread">
          <div><p class="eyebrow">Admin</p><h1>Accounts</h1></div>
          <a class="btn" href="/admin/users/new">${raw('<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>')} New account</a>
        </div>
        <div class="stats four">
          <div class="stat card"><span class="tile sm" style="--tile:#007aff">${icon("users", 17)}</span><b data-count="${customers.length}">${customers.length}</b><span>Customers</span></div>
          <div class="stat card"><span class="tile sm" style="--tile:#34c759">${icon("check", 17)}</span><b data-count="${activeN}">${activeN}</b><span>Active</span></div>
          <div class="stat card"><span class="tile sm" style="--tile:#af52de">${icon("bolt", 17)}</span><b data-count="${liveN}">${liveN}</b><span>Live</span></div>
          <div class="stat card"><span class="tile sm" style="--tile:${soonN ? "#ff9500" : "#8e8e93"}">${icon("clock", 17)}</span><b data-count="${soonN}">${soonN}</b><span>Ending in 7 days${offN ? ` · ${offN} off` : ""}</span></div>
        </div>
        <form method="get" action="/admin" class="search" data-silent>
          ${raw('<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>')}
          <input type="search" name="q" value="${q}" placeholder="Search name, email or business" aria-label="Search accounts">
        </form>
        <div class="card list table-scroll">
          <table class="accounts">
            <thead><tr><th>Account</th><th>Status</th><th>Valid until</th><th>Channels</th><th>Setup</th><th>Last login</th><th></th></tr></thead>
            <tbody>
              ${shown.map(
                (u) => html`<tr data-href="/admin/users/${u.id}">
                  <td><div class="who">${avatar(u.name, u.email)}<div><b>${u.name || "—"}</b>${u.role === "admin" ? html` <span class="tag">Admin</span>` : ""}<small>${u.email}${u.business_name ? ` · ${u.business_name}` : ""}</small></div></div></td>
                  <td>${statusPill(u)}</td>
                  <td>${u.valid_until ?? html`<span class="muted">No expiry</span>`}${u.valid_until && u.valid_until <= soon && !accessProblem(u) ? html`<br><span class="tag warn">Ends soon</span>` : ""}</td>
                  <td>${[u.perm_widget ? "Widget" : "", u.perm_whatsapp ? "WhatsApp" : ""].filter(Boolean).join(" · ") || "—"}</td>
                  <td>${u.setup.startsWith("Live") ? html`<span class="pill ok">${u.setup}</span>` : html`<span class="muted">${u.setup}</span>`}</td>
                  <td class="muted">${u.last_login_at ? u.last_login_at.slice(0, 16) : "Never"}</td>
                  <td class="end"><a href="/admin/users/${u.id}" class="chev" aria-label="Edit ${u.email}">${icon("chevron", 16)}</a></td>
                </tr>`
              )}
            </tbody>
          </table>
          ${shown.length ? "" : html`<div class="empty">${tile("users", "lg")}<b>No matches</b><span>Try a different name or email.</span></div>`}
        </div>`,
    })
  );
});

function userForm(req: Request, u?: User) {
  const isNew = !u;
  return html`
    <form method="post" action="${isNew ? "/admin/users/new" : `/admin/users/${u!.id}`}" data-busy="${isNew ? "Creating…" : "Saving…"}">
      ${csrfField(req)}
      <div class="grid">
        <div><label>Name</label><input type="text" name="name" value="${u?.name ?? ""}" required></div>
        <div><label>Email</label><input type="email" name="email" value="${u?.email ?? ""}" required></div>
      </div>
      <div class="grid">
        <div>
          <label>Role</label>
          <select name="role">
            <option value="user" ${u?.role !== "admin" ? "selected" : ""}>Customer</option>
            <option value="admin" ${u?.role === "admin" ? "selected" : ""}>Admin (can manage all accounts)</option>
          </select>
        </div>
        <div>
          <label>Status</label>
          <select name="status">
            <option value="active" ${u?.status !== "inactive" ? "selected" : ""}>Active</option>
            <option value="inactive" ${u?.status === "inactive" ? "selected" : ""}>Inactive (can't log in, bot stops)</option>
          </select>
        </div>
        <div>
          <label>Valid until <span class="hint">empty = no expiry</span></label>
          <input type="date" name="valid_until" value="${u?.valid_until ?? (isNew ? DateTime.now().plus({ days: 30 }).toISODate() : "")}">
        </div>
      </div>
      <label>Allowed channels</label>
      <div class="checks">
        <label><input type="checkbox" name="perm_widget" value="1" ${!u || u.perm_widget ? "checked" : ""}> Website chat widget</label>
        <label><input type="checkbox" name="perm_whatsapp" value="1" ${!u || u.perm_whatsapp ? "checked" : ""}> WhatsApp</label>
      </div>
      <label>Internal notes <span class="hint">plan, amount paid, UPI reference… only admins see this</span></label>
      <textarea name="notes">${u?.notes ?? ""}</textarea>
      <div class="row"><button>${isNew ? "Create account" : "Save changes"}</button><a class="btn secondary" href="/admin">Cancel</a></div>
    </form>`;
}

function readForm(req: Request) {
  const b = req.body as Record<string, string>;
  const validUntil = (b.valid_until || "").trim() || null;
  return {
    name: (b.name || "").trim(),
    email: (b.email || "").trim().toLowerCase(),
    role: b.role === "admin" ? ("admin" as const) : ("user" as const),
    status: b.status === "inactive" ? ("inactive" as const) : ("active" as const),
    validUntil: validUntil && /^\d{4}-\d{2}-\d{2}$/.test(validUntil) ? validUntil : null,
    permWidget: b.perm_widget === "1",
    permWhatsapp: b.perm_whatsapp === "1",
    notes: (b.notes || "").slice(0, 2000),
  };
}

function showPassword(req: Request, res: Response, u: User, pw: string, heading: string) {
  const loginMessage = `Your ${env.appName} login\nLink: ${env.publicUrl}/login\nEmail: ${u.email}\nTemporary password: ${pw}\n(You'll set your own password when you first log in.)`;
  res.send(
    page(req, {
      title: heading,
      body: html`
        <h1>${heading}</h1>
        <p class="sub">Copy these login details now and send them to ${u.name || u.email}. The password is not shown again.</p>
        <div class="card">
          <p><b>Login link:</b> <span class="mono">${env.publicUrl}/login</span></p>
          <p><b>Email:</b> <span class="mono">${u.email}</span></p>
          <div class="secret-box"><span class="mono" id="pw" data-copy="${pw}" title="Click to copy">${pw}</span></div>
          <p class="hint">Click the password to copy it. They'll be asked to choose their own password on first login.</p>
          <pre id="login-msg">${loginMessage}</pre>
          <div class="row">
            <button type="button" data-copy="${loginMessage}" data-copy-select="login-msg">Copy message</button>
            <a class="btn secondary" href="/admin/users/${u.id}">Back to account</a>
          </div>
        </div>`,
    })
  );
}

adminRoutes.get("/admin/users/new", async (req, res) => {
  res.send(page(req, { title: "New account", body: html`<h1>New account</h1><p class="sub">A temporary password is created for them.</p><div class="card">${userForm(req)}</div>` }));
});

adminRoutes.post("/admin/users/new", async (req, res) => {
  const f = readForm(req);
  if (!f.email || !f.name) return res.redirect(withMsg("/admin/users/new", "err", "Name and email are required."));
  if (await getUserByEmail(f.email)) return res.redirect(withMsg("/admin/users/new", "err", "An account with this email already exists."));
  const pw = tempPassword();
  const id = await createUser({ ...f, password: pw });
  if (f.status === "inactive") await db.run("UPDATE users SET status='inactive' WHERE id=?", id);
  const u = (await getUser(id))!;
  if (u.role === "user") await getWorkspaceForUser(id);
  showPassword(req, res, u, pw, "Account created");
});

adminRoutes.get("/admin/users/:id", async (req, res) => {
  const u = await getUser(Number(req.params.id));
  if (!u) return res.status(404).send("Not found");
  const ws = await getWorkspaceForUser(u.id);
  const act = await recentActivity(ws.id, 15);
  const steps = [
    ["Business details", ws.business_done],
    ["Claude", ws.claude_ok],
    ["Google Calendar", ws.google_ok],
    ["Test chat", ws.tested],
    ["Widget live", ws.widget_enabled],
    ["WhatsApp live", ws.whatsapp_enabled],
  ] as const;
  res.send(
    page(req, {
      title: u.email,
      body: html`
        <nav class="stepper"><a class="back" href="/admin">${raw('<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>')} All accounts</a></nav>
        <div class="page-head">${avatar(u.name, u.email)}<div><p class="eyebrow">${u.role === "admin" ? "Admin" : "Customer"} · since ${u.created_at.slice(0, 10)}</p><h1>${u.name || u.email}</h1><p class="sub tight">${u.email} · ${statusPill(u)}</p></div></div>
        <div class="card"><h2>Account</h2>${userForm(req, u)}</div>
        <div class="card">
          <h2>Password</h2>
          <p class="muted">Creates a new temporary password and logs them out everywhere.</p>
          <form method="post" action="/admin/users/${u.id}/reset-password" data-confirm="Reset password?" data-confirm-detail="${u.email} gets a new temporary password and is logged out everywhere." data-confirm-ok="Reset">
            ${csrfField(req)}<button class="secondary">Reset password</button>
          </form>
        </div>
        <div class="card">
          <h2>Setup progress${ws.business_name ? ` · ${ws.business_name}` : ""}</h2>
          <div class="checks">${steps.map(([n, d]) => html`<span class="pill ${d ? "ok" : ""}">${d ? "✓" : "○"} ${n}</span>`)}</div>
          <h3>Recent activity</h3>
          ${act.length
            ? html`<table><tbody>${act.map((a) => html`<tr><td class="hint">${a.created_at.slice(0, 16)}</td><td>${a.kind}</td><td>${a.channel}</td><td>${a.detail}</td></tr>`)}</tbody></table>`
            : html`<p class="muted">Nothing yet.</p>`}
        </div>
        ${u.id !== req.user!.id
          ? html`<div class="card">
              <h2>Delete account</h2>
              <p class="muted">Removes the account, its setup and stored keys. Bookings already in Google Calendar stay there.</p>
              <form method="post" action="/admin/users/${u.id}/delete" data-confirm="Delete this account?" data-confirm-detail="${u.email}, its setup and stored keys are removed permanently. This can't be undone." data-confirm-ok="Delete">
                ${csrfField(req)}<button class="danger">Delete account</button>
              </form>
            </div>`
          : ""}`,
    })
  );
});

adminRoutes.post("/admin/users/:id", async (req, res) => {
  const u = await getUser(Number(req.params.id));
  if (!u) return res.status(404).send("Not found");
  const f = readForm(req);
  const back = `/admin/users/${u.id}`;
  if (!f.email || !f.name) return res.redirect(withMsg(back, "err", "Name and email are required."));
  const other = await getUserByEmail(f.email);
  if (other && other.id !== u.id) return res.redirect(withMsg(back, "err", "Another account already uses this email."));
  const losingAdmin = u.role === "admin" && u.status === "active" && (f.role !== "admin" || f.status !== "active");
  if (losingAdmin && await countActiveAdmins() <= 1) return res.redirect(withMsg(back, "err", "You can't remove the last active admin."));
  if (u.id === req.user!.id && (f.role !== "admin" || f.status !== "active")) {
    return res.redirect(withMsg(back, "err", "You can't remove your own admin access or deactivate yourself."));
  }
  await db.run(
    `UPDATE users SET name=?, email=?, role=?, status=?, valid_until=?, perm_widget=?, perm_whatsapp=?, notes=? WHERE id=?`,
    f.name, f.email, f.role, f.status, f.validUntil, f.permWidget ? 1 : 0, f.permWhatsapp ? 1 : 0, f.notes, u.id
  );
  // Turning a channel permission off also switches that channel off.
  const ws = await getWorkspaceForUser(u.id);
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
  if (u.role === "admin" && u.status === "active" && await countActiveAdmins() <= 1) {
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
