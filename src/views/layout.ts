import type { Request } from "express";
import { env } from "../env.js";
import { html, Safe } from "./html.js";

export function page(
  req: Request,
  opts: { title: string; body: Safe; flash?: { type: "ok" | "err" | "info"; text: string } | null; wide?: boolean }
): string {
  const u = req.user;
  const flash = opts.flash ?? flashFromQuery(req);
  const path = req.path;
  const tab = (href: string, label: string, active: boolean) =>
    html`<a href="${href}" class="${active ? "tab active" : "tab"}" ${active ? html`aria-current="page"` : ""}>${label}</a>`;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#f5f5f7" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">
<title>${opts.title} · ${env.appName}</title>
<link rel="stylesheet" href="/static/app.css?v=4">
<script>document.documentElement.classList.add("js")</script>
</head>
<body class="${u ? "app" : "auth"}">
<div class="progress" id="progress" aria-hidden="true"></div>
${u ? "" : html`<div class="mesh" aria-hidden="true"><i></i><i></i><i></i></div>`}
<header class="topbar">
  <a class="brand" href="/"><span class="brand-mark" aria-hidden="true"></span>${env.appName}</a>
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
</header>
<main class="${opts.wide ? "wrap wide" : "wrap"}">
  ${flash ? html`<div class="flash ${flash.type}" data-toast="${flash.type}" role="status">${flash.text}</div>` : ""}
  ${opts.body}
</main>
<div class="toasts" id="toasts" aria-live="polite"></div>
<script src="/static/app.js?v=4"></script>
</body>
</html>`.toString();
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
  return `${url}${url.includes("?") ? "&" : "?"}${kind}=${encodeURIComponent(text)}`;
}
