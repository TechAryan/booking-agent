import { Router } from "express";
import { checkCsrf, endAllSessions, endSession, requireLogin, startSession } from "../auth.js";
import { accessProblem, getUserByEmail, setPassword } from "../models.js";
import { passwordProblem, rateLimited, verifyPassword } from "../security.js";
import { html } from "../views/html.js";
import { csrfField, page, withMsg } from "../views/layout.js";

export const authRoutes = Router();

authRoutes.get("/login", async (req, res) => {
  if (req.user && !accessProblem(req.user)) return res.redirect("/");
  const next = typeof req.query.next === "string" && /^\/(?![\/\\])/.test(req.query.next) ? req.query.next : "/";
  res.send(
    page(req, {
      title: "Log in",
      body: html`
        <div class="card" style="max-width:420px;margin:40px auto">
          <h1>Log in</h1>
          <p class="sub">Use the email and password your account manager sent you.</p>
          <form method="post" action="/login">
            <input type="hidden" name="next" value="${next}">
            <label for="email">Email</label>
            <input id="email" type="email" name="email" required autocomplete="username" autofocus>
            <label for="password">Password</label>
            <input id="password" type="password" name="password" required autocomplete="current-password">
            <div class="row"><button>Log in</button></div>
          </form>
          <p class="hint" style="margin-top:16px">No account? Ask your account manager to create one for you.</p>
        </div>`,
    })
  );
});

authRoutes.post("/login", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const next = typeof req.body.next === "string" && /^\/(?![\/\\])/.test(req.body.next) ? req.body.next : "/";
  if (rateLimited(`login:${req.ip}`, 20, 15 * 60_000) || rateLimited(`login:${email}`, 8, 15 * 60_000)) {
    return res.redirect(withMsg("/login", "err", "Too many attempts. Try again in 15 minutes."));
  }
  const user = await getUserByEmail(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.redirect(withMsg("/login", "err", "Wrong email or password."));
  }
  const problem = accessProblem(user);
  if (problem) return res.redirect(withMsg("/login", "err", problem));
  await startSession(res, user.id);
  res.redirect(user.must_change_password ? "/account/password?first=1" : next);
});

authRoutes.post("/logout", checkCsrf, async (req, res) => {
  await endSession(req, res);
  res.redirect("/login");
});

authRoutes.get("/account/password", requireLogin, async (req, res) => {
  const first = req.query.first === "1" || !!req.user!.must_change_password;
  res.send(
    page(req, {
      title: "Account",
      body: html`
        <h1>${first ? "Set your own password" : "Account"}</h1>
        <p class="sub">${first ? "You're using a temporary password. Choose a new one to continue." : `Signed in as ${req.user!.email}`}</p>
        <div class="card">
          <h2>Change password</h2>
          <form method="post" action="/account/password">
            ${csrfField(req)}
            <label>Current password</label>
            <input type="password" name="current" required autocomplete="current-password">
            <label>New password <span class="hint">at least 8 characters, with a letter and a number</span></label>
            <input type="password" name="password" required autocomplete="new-password" minlength="8">
            <label>Repeat new password</label>
            <input type="password" name="password2" required autocomplete="new-password">
            <div class="row"><button>Save password</button></div>
          </form>
        </div>
        ${!first && req.user!.valid_until
          ? html`<div class="card"><h2>Subscription</h2><p>Active until <b>${req.user!.valid_until}</b>.</p></div>`
          : ""}`,
    })
  );
});

authRoutes.post("/account/password", requireLogin, checkCsrf, async (req, res) => {
  const u = req.user!;
  const { current, password, password2 } = req.body as Record<string, string>;
  const back = "/account/password";
  if (!verifyPassword(current || "", u.password_hash)) return res.redirect(withMsg(back, "err", "Current password is wrong."));
  if (password !== password2) return res.redirect(withMsg(back, "err", "The new passwords don't match."));
  const problem = passwordProblem(password || "");
  if (problem) return res.redirect(withMsg(back, "err", problem));
  if (password === current) return res.redirect(withMsg(back, "err", "Choose a password different from the current one."));
  await setPassword(u.id, password, false);
  await endAllSessions(u.id);
  await startSession(res, u.id);
  res.redirect(withMsg("/", "ok", "Password updated."));
});
