import express, { Router } from "express";
import { reply, resetConversation } from "../agent.js";
import { db, logActivity, Workspace } from "../db.js";
import { env } from "../env.js";
import { markRead, sendText } from "../kapso.js";
import { accessProblem, getWorkspaceByPublicId } from "../models.js";
import { decrypt, hmacHex, rateLimited, safeEqual } from "../security.js";
import { html, raw } from "../views/html.js";

export const publicRoutes = Router();

async function liveFor(publicId: string, channel: "widget" | "whatsapp") {
  const ws = await getWorkspaceByPublicId(publicId);
  if (!ws) return null;
  if (accessProblem(ws.owner)) return null;
  if (channel === "widget" && !(ws.widget_enabled && ws.owner.perm_widget)) return null;
  if (channel === "whatsapp" && !(ws.whatsapp_enabled && ws.owner.perm_whatsapp)) return null;
  if (!(ws.claude_ok && ws.google_ok)) return null;
  return ws;
}

// ---------- Website widget ----------

publicRoutes.get("/w/:id", async (req, res) => {
  const ws = await getWorkspaceByPublicId(req.params.id);
  const live = await liveFor(req.params.id, "widget");
  // Allow embedding on any site.
  res.removeHeader("X-Frame-Options");
  res.setHeader("Content-Security-Policy", "frame-ancestors *");
  if (!ws || !live) {
    return res.status(404).send(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:24px;color:#6b7280">Booking chat is not available right now.</body>`);
  }
  const greeting = ws.widget_greeting || `Hi! I can help you book an appointment at ${ws.business_name}. What would you like?`;
  res.send(
    html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Book · ${ws.business_name}</title>
<link rel="stylesheet" href="/static/widget.css?v=3">
<style>:root{--accent:${/^#[0-9a-fA-F]{6}$/.test(ws.widget_color) ? ws.widget_color : "#16a34a"}}</style>
</head><body>
<div class="w">
  <header><div class="av" aria-hidden="true">${(ws.business_name || "B").trim().charAt(0).toUpperCase()}</div><div class="t"><b>${ws.business_name}</b><span>Usually replies instantly</span></div><button type="button" id="reset" title="Start over" aria-label="Start over">↺</button></header>
  <div class="msgs" id="msgs"><div class="m b">${greeting}</div></div>
  <form id="f"><input id="t" type="text" placeholder="Type a message…" autocomplete="off" maxlength="1000" aria-label="Message"><button aria-label="Send">➤</button></form>
  <footer>Powered by ${env.appName}</footer>
</div>
<script>window.WIDGET_ID=${raw(JSON.stringify(ws.public_id).replace(/</g, "\\u003c"))};</script>
<script src="/static/widget-chat.js?v=3"></script>
</body></html>`.toString()
  );
});

publicRoutes.post("/w/:id/message", express.json({ limit: "16kb" }), async (req, res) => {
  const ws = await liveFor(req.params.id, "widget");
  if (!ws) return res.status(404).json({ error: "Chat is not available." });
  const session = String(req.body?.session || "");
  const text = String(req.body?.text || "").trim();
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(session) || !text) return res.status(400).json({ error: "Bad request" });
  if (rateLimited(`w-ip:${req.ip}`, 30, 5 * 60_000) || rateLimited(`w-s:${session}`, 20, 5 * 60_000)) {
    return res.status(429).json({ error: "You're sending messages too fast. Please wait a moment." });
  }
  try {
    res.json({ reply: await reply(ws, "widget", session, text) });
  } catch (e: any) {
    console.error(`[widget ${ws.public_id}]`, e);
    await logActivity(ws.id, "error", "widget", e.message);
    res.status(500).json({ error: "Sorry, something went wrong. Please try again in a minute." });
  }
});

publicRoutes.post("/w/:id/reset", express.json({ limit: "4kb" }), async (req, res) => {
  const ws = await getWorkspaceByPublicId(req.params.id);
  const session = String(req.body?.session || "");
  if (ws && /^[A-Za-z0-9_-]{16,64}$/.test(session)) await resetConversation(ws.id, "widget", session);
  res.json({ ok: true });
});

// Loader for the floating button: <script src=".../widget.js" data-id="ws_…"></script>
publicRoutes.get("/widget.js", (_req, res) => {
  res.type("application/javascript").setHeader("Cache-Control", "public, max-age=300");
  res.send(`(function(){
  var s=document.currentScript; if(!s) return; var id=s.getAttribute('data-id'); if(!id) return;
  var base=${JSON.stringify(env.publicUrl)};
  var color=s.getAttribute('data-color')||'#16a34a';
  var open=false, frame=null;
  var btn=document.createElement('button');
  btn.setAttribute('aria-label','Book an appointment');
  btn.innerHTML='<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  btn.style.cssText='position:fixed;right:20px;bottom:20px;width:58px;height:58px;border-radius:50%;border:0;cursor:pointer;z-index:2147483646;box-shadow:0 6px 20px rgba(0,0,0,.25);background:'+color;
  fetch(base+'/w/'+id+'/meta').then(function(r){return r.json()}).then(function(m){ if(m&&m.color){btn.style.background=m.color;} }).catch(function(){});
  btn.onclick=function(){
    open=!open;
    if(!frame){ frame=document.createElement('iframe'); frame.src=base+'/w/'+id; frame.title='Book an appointment';
      frame.style.cssText='position:fixed;right:20px;bottom:90px;width:380px;max-width:calc(100vw - 40px);height:600px;max-height:calc(100vh - 120px);border:0;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.25);z-index:2147483647;background:#fff';
      document.body.appendChild(frame); }
    frame.style.display=open?'block':'none';
  };
  (document.readyState==='loading')?document.addEventListener('DOMContentLoaded',function(){document.body.appendChild(btn)}):document.body.appendChild(btn);
})();`);
});

publicRoutes.get("/w/:id/meta", async (req, res) => {
  const ws = await liveFor(req.params.id, "widget");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json(ws ? { color: ws.widget_color, name: ws.business_name } : {});
});

// ---------- WhatsApp (Kapso webhook) ----------

const queues = new Map<string, Promise<void>>();
function enqueue(key: string, job: () => Promise<void>) {
  const next = (queues.get(key) ?? Promise.resolve()).then(job).catch((e) => console.error("WhatsApp job failed:", e));
  queues.set(key, next);
  next.finally(() => queues.get(key) === next && queues.delete(key));
}

async function firstTime(messageId: string): Promise<boolean> {
  const r = await db.run("INSERT OR IGNORE INTO seen_messages (id, created_at) VALUES (?, ?)", messageId, Date.now());
  return r.changes === 1;
}

publicRoutes.post("/webhooks/kapso/:id", express.raw({ type: "*/*", limit: "2mb" }), async (req, res) => {
  const ws = await getWorkspaceByPublicId(req.params.id);
  if (!ws) return res.sendStatus(404);
  const secret = decrypt(ws.kapso_webhook_secret_enc);
  const sig = String(req.header("X-Webhook-Signature") || "").replace(/^sha256=/, "");
  const raw = req.body as Buffer;
  if (!secret || !sig || !safeEqual(hmacHex(secret, raw), sig)) return res.sendStatus(401);

  let payload: any;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return res.sendStatus(400);
  }
  res.sendStatus(200); // answer within Kapso's 10s window, then work

  const live = await liveFor(req.params.id, "whatsapp");
  if (!live) return;
  const event = req.header("X-Webhook-Event");
  if (event && event !== "whatsapp.message.received") return;
  const items: any[] = payload?.batch && Array.isArray(payload.data) ? payload.data : [payload];

  // With buffering on, several quick messages from one person arrive together: answer them as one.
  const byPhone = new Map<string, { ids: string[]; texts: string[]; name?: string; nonText: boolean }>();
  for (const item of items) {
    const msg = item?.message;
    if (!msg?.id || msg?.kapso?.direction === "outbound" || !await firstTime(`${ws.id}:${msg.id}`)) continue;
    const phone = String(msg.from ?? item?.conversation?.phone_number ?? "").replace(/[^\d]/g, "");
    if (!phone) continue;
    const g = byPhone.get(phone) ?? { ids: [], texts: [], nonText: false };
    g.ids.push(msg.id);
    const text = msg.text?.body ?? (msg.type === "text" ? msg.kapso?.content : "") ?? "";
    if (text) g.texts.push(text);
    else g.nonText = true;
    g.name = item?.conversation?.kapso?.contact_name ?? g.name;
    byPhone.set(phone, g);
  }
  for (const [phone, g] of byPhone) enqueue(`${ws.id}:${phone}`, () => handleWhatsApp(live, phone, g));
});

async function handleWhatsApp(ws: Workspace, phone: string, g: { ids: string[]; texts: string[]; name?: string; nonText: boolean }) {
  const key = decrypt(ws.kapso_key_enc)!;
  const pnid = ws.kapso_phone_number_id!;
  markRead(key, pnid, g.ids[g.ids.length - 1]);
  let out: string;
  const text = g.texts.join("\n").trim();
  if (!text) {
    out = "I can only read text messages for now. Please type your request 🙂";
  } else if (text.toLowerCase() === "/reset") {
    await resetConversation(ws.id, "whatsapp", phone);
    out = "Conversation reset. How can I help?";
  } else {
    try {
      out = await reply(ws, "whatsapp", phone, text, { trustedPhone: phone, contactName: g.name });
    } catch (e: any) {
      console.error(`[whatsapp ${ws.public_id}]`, e);
      await logActivity(ws.id, "error", "whatsapp", e.message);
      out = "Sorry, something went wrong on our side. Please try again in a minute.";
    }
  }
  try {
    await sendText(key, pnid, phone, out);
  } catch (e: any) {
    console.error(`[whatsapp ${ws.public_id}] send failed`, e?.message);
    await logActivity(ws.id, "error", "whatsapp", `Send failed: ${e?.message}`);
  }
}

