import type { Request } from "express";
import { env } from "../env.js";
import { html, raw, Safe } from "./html.js";
import { daysLeft } from "../models.js";

export function page(
  req: Request,
  opts: { title: string; body: Safe; flash?: { type: "ok" | "err" | "info"; text: string } | null; wide?: boolean }
): string {
  const u = req.user;
  const flash = opts.flash ?? flashFromQuery(req);
  const path = req.path;
  const theme = themeOf(req);
  const tab = (href: string, label: string, active: boolean) =>
    html`<a href="${href}" class="${active ? "tab active" : "tab"}" ${active ? html`aria-current="page"` : ""}>${label}</a>`;
  return html`<!doctype html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="${theme === "light" ? "#f5f5f7" : "#000000"}">
<title>${opts.title} · ${env.appName}</title>
<link rel="stylesheet" href="/static/app.css?v=7">
<script>document.documentElement.classList.add("js")</script>
</head>
<body class="${u ? "app" : "auth"}">
<div class="progress" id="progress" aria-hidden="true"></div>
${u ? "" : html`<div class="mesh" aria-hidden="true"><i></i><i></i><i></i></div>`}
<header class="topbar">
  <a class="brand" href="/"><span class="brand-mark" aria-hidden="true"></span>${env.appName}</a>
  <div class="bar-right">
  ${u
    ? html`<nav class="tabs" aria-label="Main">
        ${tab("/", "Dashboard", path === "/" || path.startsWith("/setup"))}
        ${u.role === "admin" ? tab("/admin", "Admin", path.startsWith("/admin")) : ""}
        ${tab("/account/password", "Account", path.startsWith("/account"))}
        <form method="post" action="/logout" class="inline" data-silent>
          <input type="hidden" name="_csrf" value="${req.csrf}">
          <button class="tab linklike">Log out</button>
        </form>
      </nav>`
    : ""}
    ${themeButton(theme)}
  </div>
</header>
<main class="${opts.wide ? "wrap wide" : "wrap"}">
  ${u && u.role === "user" ? expiryBanner(u) : ""}
  ${flash ? html`<div class="flash ${flash.type}" data-toast="${flash.type}" role="status">${flash.text}</div>` : ""}
  ${opts.body}
</main>
<div class="toasts" id="toasts" aria-live="polite"></div>
<script src="/static/app.js?v=6"></script>
</body>
</html>`.toString();
}

/** Shown to customers from 3 days before their access ends. We don't send emails, so this is the reminder. */
function expiryBanner(u: NonNullable<Request["user"]>) {
  const n = daysLeft(u);
  if (n === null || n < 0 || n > 3) return "";
  const when = n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`;
  return html`<div class="expiry ${n <= 1 ? "urgent" : ""}" role="alert" data-dismiss-key="exp-${u.valid_until}-${n}">
    <span class="exp-icon" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></span>
    <div class="grow"><b>Your access ends ${when}</b><small>After that your booking assistant stops replying to customers. Contact your account manager to renew.</small></div>
    <a class="btn small" href="/account/password#subscription">Details</a>
    <button type="button" class="icon-btn" data-dismiss aria-label="Hide for now"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
  </div>`;
}

export type Theme = "dark" | "light" | "system";
export function themeOf(req: Request): Theme {
  const t = req.cookies?.theme;
  return t === "light" || t === "system" || t === "dark" ? t : "dark"; // dark by default
}

const SUN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/></svg>';
const MOON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z"/></svg>';
const AUTO = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2.5"/><path d="M8 21h8M12 17v4"/></svg>';
export const THEME_ICONS = { light: SUN, dark: MOON, system: AUTO };

function themeButton(theme: Theme) {
  const opt = (t: Theme, label: string) =>
    html`<button type="button" role="menuitemradio" aria-checked="${theme === t ? "true" : "false"}" data-set-theme="${t}">${raw(THEME_ICONS[t])}<span>${label}</span><i class="tick" aria-hidden="true"></i></button>`;
  return html`<div class="theme-pick">
    <button type="button" class="icon-btn" data-theme-toggle aria-haspopup="menu" aria-expanded="false" aria-label="Appearance" title="Appearance">${raw(THEME_ICONS[theme])}</button>
    <div class="menu" role="menu" aria-label="Appearance">${opt("light", "Light")}${opt("dark", "Dark")}${opt("system", "System")}</div>
  </div>`;
}

function flashFromQuery(req: Request) {
  const ok = req.query.ok as string | undefined;
  const err = req.query.err as string | undefined;
  const msg = req.query.msg as string | undefined;
  if (err) return { type: "err" as const, text: err.slice(0, 300) };
  if (ok) return { type: "ok" as const, text: ok.slice(0, 300) };
  if (msg) return { type: "info" as const, text: msg.slice(0, 300) };
  return null;
}

export function csrfField(req: Request) {
  return html`<input type="hidden" name="_csrf" value="${req.csrf}">`;
}

/** Redirect helper with a flash message. */
export function withMsg(url: string, kind: "ok" | "err" | "msg", text: string) {
  const [base, hash] = url.split("#");
  return `${base}${base!.includes("?") ? "&" : "?"}${kind}=${encodeURIComponent(text)}${hash ? `#${hash}` : ""}`;
}
