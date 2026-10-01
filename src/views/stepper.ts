import type { Request } from "express";
import type { Workspace } from "../db.js";
import { html, raw } from "./html.js";

const CHECK = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

/** The step bar on every setup page: 4 required steps, then the optional ones (skippable, in any order). */
export function stepNav(req: Request, active: string, w?: Workspace) {
  const u = req.user!;
  const required: [string, string, boolean][] = [
    ["business", "Business", !!w?.business_done],
    ["claude", "Claude", !!w?.claude_ok],
    ["google", "Calendar", !!w?.google_ok],
    ["test", "Test", !!w?.tested],
  ];
  const optional: [string, string, boolean][] = [
    ["profile", "Profile", !!(w?.address || w?.contact_phone)],
    ["payments", "Payments", !!(w?.razorpay_key_id || w?.upi_id)],
    ["holidays", "Holidays", false],
    ...(u.perm_widget ? [["widget", "Widget", !!w?.widget_enabled] as [string, string, boolean]] : []),
    ...(u.perm_whatsapp ? [["whatsapp", "WhatsApp", !!w?.whatsapp_enabled] as [string, string, boolean]] : []),
  ];
  const item = ([k, l, done]: [string, string, boolean], opt: boolean) => {
    const cls = [done ? "past" : "", opt ? "opt" : ""].filter(Boolean).join(" ");
    const inner = html`${done ? raw(CHECK) : ""}${l}`;
    return k === active
      ? html`<b aria-current="step" class="${cls}">${inner}</b>`
      : html`<a href="/setup/${k}" class="${cls}"${opt ? html` title="Optional: skip it if you don't need it"` : ""}>${inner}</a>`;
  };
  return html`<nav class="stepper" aria-label="Setup steps">
    <a class="back" href="/">${raw('<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>')} Dashboard</a>
    <div class="track" style="--n:${required.length + optional.length}">${required.map((s) => item(s, false))}${optional.map((s) => item(s, true))}</div>
  </nav>`;
}
