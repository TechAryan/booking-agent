import type { Request } from "express";
import type { Workspace } from "../db.js";
import { html, raw } from "./html.js";
import { icon, tile } from "./icons.js";

type Step = { key: string; label: string; ic: string; done: boolean; optional: boolean };

const BACK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';

/**
 * The step header on every setup page: a slim segmented progress bar (one segment per step, tappable),
 * "Step 6 of 9" with the next step, and an "All steps" menu that lists everything with done / optional state.
 */
export function stepNav(req: Request, active: string, w?: Workspace) {
  const u = req.user!;
  const steps: Step[] = [
    { key: "business", label: "Business", ic: "business", done: !!w?.business_done, optional: false },
    { key: "claude", label: "AI", ic: "claude", done: !!w?.claude_ok, optional: false },
    { key: "google", label: "Calendar", ic: "calendar", done: !!w?.google_ok, optional: false },
    { key: "test", label: "Test", ic: "test", done: !!w?.tested, optional: false },
    { key: "profile", label: "Profile", ic: "profile", done: !!(w?.address || w?.contact_phone), optional: true },
    { key: "payments", label: "Payments", ic: "wallet", done: !!(w?.razorpay_key_id || w?.upi_id), optional: true },
    { key: "holidays", label: "Holidays", ic: "holiday", done: false, optional: true },
    ...(u.perm_widget ? [{ key: "widget", label: "Widget", ic: "widget", done: !!w?.widget_enabled, optional: true }] : []),
    ...(u.perm_whatsapp ? [{ key: "whatsapp", label: "WhatsApp", ic: "whatsapp", done: !!w?.whatsapp_enabled, optional: true }] : []),
  ];
  const i = Math.max(0, steps.findIndex((s) => s.key === active));
  const cur = steps[i]!;
  const next = steps[i + 1];
  const doneN = steps.filter((s) => s.done).length;
  return html`<nav class="steps-nav" aria-label="Setup steps">
    <div class="sn-top">
      <a class="back" href="/">${raw(BACK)} Dashboard</a>
      <details class="sn-menu">
        <summary><span class="sn-count">${doneN}/${steps.length}</span> All steps ${icon("chevron", 13)}</summary>
        <div class="sn-panel" role="list">
          <p class="sn-head">Setup · ${doneN} of ${steps.length} done</p>
          ${steps.map((s, n) => html`${n === 4 ? html`<p class="sn-group">Optional · do any time, or skip</p>` : ""}<a role="listitem" href="/setup/${s.key}" class="sn-item ${s.key === active ? "on" : ""} ${s.done ? "done" : ""}" ${s.key === active ? html`aria-current="step"` : ""}>
            ${tile(s.ic)}<span class="grow">${s.label}</span>${s.done ? html`<span class="sn-tick">${icon("check", 13)}</span>` : s.key === active ? html`<span class="sn-here">You're here</span>` : ""}
          </a>`)}
        </div>
      </details>
    </div>
    <div class="sn-bar" style="grid-template-columns: repeat(4, 1.4fr) repeat(${steps.length - 4}, 1fr)">
      ${steps.map((s) => html`<a href="/setup/${s.key}" class="seg ${s.done ? "done" : ""} ${s.key === active ? "on" : ""} ${s.optional ? "opt" : ""}" title="${s.label}${s.optional ? " (optional)" : ""}${s.done ? " · done" : ""}" aria-label="${s.label}"></a>`)}
    </div>
    <div class="sn-meta">
      <span>Step ${i + 1} of ${steps.length}${cur.optional ? html` · <i>optional</i>` : ""}</span>
      ${next ? html`<a href="/setup/${next.key}">${cur.optional ? "Skip to" : "Next:"} ${next.label} ${icon("chevron", 12)}</a>` : html`<a href="/">Back to dashboard ${icon("chevron", 12)}</a>`}
    </div>
  </nav>`;
}
