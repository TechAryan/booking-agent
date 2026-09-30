import type { Request } from "express";
import { env } from "../env.js";
import { html, Safe } from "./html.js";

export function page(
  req: Request,
  opts: { title: string; body: Safe; flash?: { type: "ok" | "err" | "info"; text: string } | null; wide?: boolean }
): string {
  const u = req.user;
  const flash = opts.flash ?? flashFromQuery(req);
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title} · ${env.appName}</title>
<link rel="stylesheet" href="/static/app.css">
</head>
<body>
<header class="topbar">
  <a class="brand" href="/">${env.appName}</a>
  ${u
    ? html`<nav>
        <a href="/">Dashboard</a>
        ${u.role === "admin" ? html`<a href="/admin">Admin</a>` : ""}
        <a href="/account/password">Account</a>
        <form method="post" action="/logout" class="inline">
          <input type="hidden" name="_csrf" value="${req.csrf}">
          <button class="linklike">Log out</button>
        </form>
      </nav>`
    : ""}
</header>
<main class="${opts.wide ? "wrap wide" : "wrap"}">
  ${flash ? html`<div class="flash ${flash.type}">${flash.text}</div>` : ""}
  ${opts.body}
</main>
<script src="/static/app.js"></script>
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
