import express, { Router } from "express";
import crypto from "node:crypto";
import { kickDrain, onInbox, saveEvent } from "../inbox.js";
import { reply, resetConversation } from "../agent.js";
import { db, logActivity, Workspace } from "../db.js";
import { env } from "../env.js";
import { downloadMedia, markRead, sendText } from "../kapso.js";
import multer from "multer";
import { MAX_PROOF_BYTES, proofsFor, saveProofImage, submitCustomerProof } from "../proofs.js";
import { accessProblem, getWorkspaceById, getWorkspaceByPublicId } from "../models.js";
import { decrypt, hmacHex, rateLimited, safeEqual } from "../security.js";
import { html, raw } from "../views/html.js";
import { ICON_LINKS } from "../views/layout.js";
import QRCode from "qrcode";
import { DateTime } from "luxon";
import { inr, mapsLink, ownerPhones } from "../catalog.js";
import { Booking, forwardText, getBooking, markPaid, checkPayment, payToken, whenText } from "../bookings.js";
import { upiUri, verifyCallbackSignature, verifyWebhookSignature } from "../payments.js";

export const publicRoutes = Router();

async function liveFor(publicId: string, channel: "widget" | "whatsapp") {
  return isLive(await getWorkspaceByPublicId(publicId), channel);
}
async function liveForId(id: number, channel: "widget" | "whatsapp") {
  return isLive(await getWorkspaceById(id), channel);
}
function isLive(ws: Awaited<ReturnType<typeof getWorkspaceByPublicId>>, channel: "widget" | "whatsapp") {
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
${ICON_LINKS}
<link rel="stylesheet" href="/static/widget.css?v=4">
<style>:root{--accent:${/^#[0-9a-fA-F]{6}$/.test(ws.widget_color) ? ws.widget_color : "#16a34a"}}</style>
</head><body>
<div class="w">
  <header><div class="av" aria-hidden="true">${(ws.business_name || "B").trim().charAt(0).toUpperCase()}</div><div class="t"><b>${ws.business_name}</b><span>Usually replies instantly</span></div><button type="button" id="reset" title="Start over" aria-label="Start over">↺</button></header>
  <div class="msgs" id="msgs"><div class="m b">${greeting}</div></div>
  <form id="f"><input id="t" type="text" placeholder="Type a message…" autocomplete="off" maxlength="1000" aria-label="Message"><button aria-label="Send">➤</button></form>
  <footer>Powered by ${env.appName}</footer>
</div>
<script>window.WIDGET_ID=${raw(JSON.stringify(ws.public_id).replace(/</g, "\\u003c"))};</script>
<script src="/static/widget-chat.js?v=4"></script>
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

// Webhooks are saved first (one raw row), answered 200 at once, then processed from the inbox. The edge worker
// writes the same raw rows when it is in front of us, so both paths share everything below.
const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");
export const rawEvent = (headers: Record<string, string>, body: string) => JSON.stringify({ headers, body });

publicRoutes.post("/webhooks/kapso/:id", express.raw({ type: "*/*", limit: "2mb" }), async (req, res) => {
  const ws = await getWorkspaceByPublicId(String(req.params.id));
  if (!ws) return res.sendStatus(404);
  const secret = decrypt(ws.kapso_webhook_secret_enc);
  const sig = String(req.header("X-Webhook-Signature") || "").replace(/^sha256=/, "");
  const raw = req.body as Buffer;
  if (!secret || !sig || !safeEqual(hmacHex(secret, raw), sig)) return res.sendStatus(401);
  await saveEvent(ws.id, "wh:kapso", sha(raw), "", rawEvent({ event: String(req.header("X-Webhook-Event") || "") }, raw.toString("utf8")));
  res.sendStatus(200); // within Kapso's 10 s window
  kickDrain();
});

// Stage 1: split a Kapso delivery into one row per customer message (deduped on the WhatsApp message id).
onInbox("wh:kapso", async (rows) => {
  for (const row of rows) {
    const live = await liveForId(row.workspace_id, "whatsapp");
    if (!live) continue;
    const { headers, body } = JSON.parse(row.body);
    if (headers.event && headers.event !== "whatsapp.message.received") continue;
    let payload: any;
    try { payload = JSON.parse(body); } catch { continue; }
    const items: any[] = payload?.batch && Array.isArray(payload.data) ? payload.data : [payload];
    for (const item of items) {
      const msg = item?.message;
      if (!msg?.id || msg?.kapso?.direction === "outbound") continue;
      const phone = String(msg.from ?? item?.conversation?.phone_number ?? "").replace(/[^\d]/g, "");
      if (!phone) continue;
      await saveEvent(row.workspace_id, "wa:kapso", String(msg.id), `wa:${phone}`, JSON.stringify(item));
    }
  }
  kickDrain();
});

// Stage 2: one customer's waiting messages, answered together (several quick messages = one reply).
onInbox("wa:kapso", async (rows) => {
  const live = await liveForId(rows[0]!.workspace_id, "whatsapp");
  if (!live) return;
  const phone = rows[0]!.group_key.replace(/^wa:/, "");
  // An owner can switch sides with "/customer …": keep owner and customer messages in separate replies.
  const isOwner = ownerPhones(live).includes(phone);
  const groups: WaGroup[] = [];
  let mode = "";
  for (const row of rows) {
    const item = JSON.parse(row.body);
    const msg = item.message;
    const text = msg.text?.body ?? (msg.type === "text" ? msg.kapso?.content : "") ?? "";
    const m = isOwner && /^\/customer\b/i.test(text) ? "customer" : "same";
    if (!groups.length || (m === "customer") !== (mode === "customer")) groups.push({ ids: [], texts: [], images: [], nonText: false });
    mode = m;
    const g = groups[groups.length - 1]!;
    g.ids.push(msg.id);
    if (text) g.texts.push(text);
    else if (msg.type === "image" && msg.image?.id) g.images.push({ id: String(msg.image.id), mime: String(msg.image.mime_type || "image/jpeg"), caption: String(msg.image.caption || "") });
    else g.nonText = true;
    g.name = item?.conversation?.kapso?.contact_name ?? g.name;
  }
  for (const g of groups) await handleWhatsApp(live, phone, g);
});

type WaGroup = { ids: string[]; texts: string[]; images: { id: string; mime: string; caption: string }[]; name?: string; nonText: boolean };

async function handleWhatsApp(ws: Workspace, phone: string, g: WaGroup) {
  const key = decrypt(ws.kapso_key_enc)!;
  const pnid = ws.kapso_phone_number_id!;
  markRead(key, pnid, g.ids[g.ids.length - 1]);
  let out: string;
  const isOwnerNumber = ownerPhones(ws).includes(phone);
  const ownerSide = isOwnerNumber && !/^\/customer\b/i.test(g.texts[0] || "");
  // Photos (usually payment screenshots) are saved; the assistant decides which booking they belong to.
  const notes: string[] = [];
  for (const im of g.images.slice(0, 3)) {
    try {
      const buf = await downloadMedia(key, pnid, im.id);
      await saveProofImage(ws, ownerSide ? `owner:${phone}` : `wa:${phone}`, buf, im.mime, im.caption);
      notes.push(`[Sent a photo${im.caption ? `: "${im.caption.slice(0, 200)}"` : ""}]`);
    } catch (e: any) {
      console.warn(`[whatsapp ${ws.public_id}] photo`, e?.message);
      notes.push(`[Sent a photo that couldn't be opened${/large|JPG/.test(e?.message) ? `: ${e.message}` : ""}]`);
    }
  }
  const text = [...g.texts, ...notes].join("\n").trim();
  if (!text) {
    out = "I can read text and photos for now. Please type your request 🙂";
  } else if (text.toLowerCase() === "/reset") {
    await resetConversation(ws.id, "whatsapp", phone);
    out = "Conversation reset. How can I help?";
  } else {
    try {
      // The owner's own number manages the business; "/customer …" lets them try the customer side.
      const isOwner = isOwnerNumber;
      const asCustomer = isOwner && /^\/customer\b/i.test(text);
      const msg = asCustomer ? text.replace(/^\/customer\b\s*/i, "") || "Hi" : text;
      out = await reply(ws, "whatsapp", phone, msg, { trustedPhone: phone, contactName: g.name, asOwner: isOwner && !asCustomer });
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



// ---------- Razorpay ----------

publicRoutes.post("/webhooks/razorpay/:id", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
  const ws = await getWorkspaceByPublicId(String(req.params.id));
  if (!ws) return res.sendStatus(404);
  const secret = decrypt(ws.razorpay_webhook_secret_enc);
  const raw = req.body as Buffer;
  if (!secret || !verifyWebhookSignature(secret, raw, String(req.header("X-Razorpay-Signature") || ""))) return res.sendStatus(401);
  // Razorpay retries and may send an event twice: the event id (or the body hash) dedupes it.
  const eventId = String(req.header("X-Razorpay-Event-Id") || "") || sha(raw);
  await saveEvent(ws.id, "wh:razorpay", eventId, "", rawEvent({}, raw.toString("utf8")));
  res.sendStatus(200);
  kickDrain();
});

onInbox("wh:razorpay", async (rows) => {
  for (const row of rows) {
    const ws = await getWorkspaceById(row.workspace_id);
    if (!ws) continue;
    let ev: any;
    try { ev = JSON.parse(JSON.parse(row.body).body); } catch { continue; }
    const link = ev?.payload?.payment_link?.entity;
    if (!link) continue;
    const b = (await getBooking(ws, link.reference_id)) ?? (await db.get<Booking>("SELECT * FROM bookings WHERE workspace_id=? AND payment_link_id=?", ws.id, link.id));
    if (!b || b.payment_link_id !== link.id) continue;
    // markPaid / checkPayment are idempotent, so a retry after a crash is safe.
    if (ev.event === "payment_link.paid") await markPaid(ws, b, ev?.payload?.payment?.entity?.id ?? null, "webhook");
    else if (ev.event === "payment_link.expired" || ev.event === "payment_link.cancelled") await checkPayment(ws, b);
  }
});

// ---------- Payment / booking status page (link sent to customers) ----------

function payShell(ws: Workspace, title: string, body: string) {
  const color = /^#[0-9a-fA-F]{6}$/.test(ws.widget_color) ? ws.widget_color : "#0a84ff";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · ${ws.business_name.replace(/</g, "&lt;")}</title>${ICON_LINKS.value}<link rel="stylesheet" href="/static/pay.css?v=2"><style>:root{--accent:${color}}</style></head>
<body><main class="pay">${body}</main><script src="/static/pay.js?v=2"></script></body></html>`;
}

function gcalLink(ws: Workspace, b: Booking) {
  const f = (iso: string) => DateTime.fromISO(iso).toUTC().toFormat("yyyyLLdd'T'HHmmss'Z'");
  const p = new URLSearchParams({ action: "TEMPLATE", text: `${b.service_name} · ${ws.business_name}`, dates: `${f(b.start_at)}/${f(b.end_at)}`, details: `Booking ${b.ref}${b.meet_link ? `\nJoin: ${b.meet_link}` : ""}`, location: b.mode === "online" ? b.meet_link || "" : ws.address });
  return `https://calendar.google.com/calendar/render?${p}`;
}

function proofBlock(ws: Workspace, b: Booking, proofs: Awaited<ReturnType<typeof proofsFor>>) {
  const esc = (x: string) => html`${x}`.toString();
  const last = proofs.filter((p) => p.sender.startsWith("page:") || p.sender.startsWith("wa:")).at(-1);
  const action = `/pay/${ws.public_id}/${b.ref}/${payToken(ws, b.ref)}/proof`;
  const form = (label: string) => `<form class="proof" method="post" action="${action}" enctype="multipart/form-data" data-proof>
      <label class="btn ghost file"><input type="file" name="shot" accept="image/*" required>${label}</label>
      <button class="btn" type="submit" hidden>Send screenshot</button></form>`;
  if (!last) return `<p class="fine">After paying, upload the payment screenshot here (or send it in your chat with ${esc(ws.business_name)}).</p>${form("Upload payment screenshot")}`;
  if (last.verdict === "mismatch" || last.verdict === "unreadable")
    return `<div class="note bad"><b>That screenshot didn't match</b><p>${esc(last.detail || "We couldn't read it.")}. If you paid, upload the screenshot of this payment. The business has been told.</p></div>${form("Upload another screenshot")}`;
  return `<div class="note ok"><b>Screenshot received</b><p>${last.verdict === "ok" ? "It looks right. " : ""}${esc(ws.business_name)} will confirm your payment shortly. This page updates by itself.</p></div><p class="fine" data-poll="/pay/${ws.public_id}/${b.ref}/${payToken(ws, b.ref)}/status" data-poll-upi></p>`;
}

async function payView(ws: Workspace, b: Booking) {
  const first = (b.customer_name || "").split(/\s+/)[0] || "";
  const when = whenText(ws, b.start_at);
  const esc = (x: string) => html`${x}`.toString();
  const top = `<div class="biz"><span class="av">${esc((ws.business_name || "B").charAt(0).toUpperCase())}</span><b>${esc(ws.business_name)}</b></div>`;
  const summary = `<div class="sum"><div><span>Service</span><b>${esc(b.service_name)}</b></div><div><span>When</span><b>${esc(when)}</b></div><div><span>${b.mode === "online" ? "Where" : "Where"}</span><b>${b.mode === "online" ? "Online" : esc(ws.address || "In person")}</b></div>${b.amount ? `<div><span>Amount</span><b>${inr(b.amount)}</b></div>` : ""}<div><span>Ref</span><b class="mono">${b.ref}</b></div></div>`;
  if (b.status === "confirmed" && b.pay_status !== "pending_manual") {
    const map = b.mode === "offline" ? mapsLink(ws) : "";
    return payShell(ws, "Booked", `${top}<div class="state ok"><span class="big">✓</span><h1>You're booked${first ? `, ${esc(first)}` : ""}!</h1><p>${b.pay_status === "paid" ? `Payment of ${inr(b.amount)} received. ` : ""}See you on ${esc(when)}.</p></div>${summary}
      <div class="actions">${b.meet_link ? `<a class="btn" href="${esc(b.meet_link)}" target="_blank" rel="noopener">Join online session</a>` : ""}${map ? `<a class="btn" href="${esc(map)}" target="_blank" rel="noopener">Open in Google Maps</a>` : ""}<a class="btn ghost" href="${esc(gcalLink(ws, b))}" target="_blank" rel="noopener">Add to Google Calendar</a></div>
      <p class="fine">${b.customer_email ? `A calendar invite was sent to ${esc(b.customer_email)} if the business has invites on. ` : ""}To change or cancel, just message ${esc(ws.business_name)}.</p>`);
  }
  if (b.pay_status === "pending_manual" && b.status === "confirmed") {
    const uri = upiUri(ws, b.amount, b.ref);
    const qr = await QRCode.toDataURL(uri, { margin: 1, width: 260 });
    return payShell(ws, "Pay by UPI", `${top}<div class="state"><h1>Pay ${inr(b.amount)} by UPI</h1><p>Your slot is booked. Pay now to confirm it.</p></div>
      <img class="qr" src="${qr}" alt="UPI QR code for ${inr(b.amount)}"><p class="upi mono">${esc(ws.upi_id)}</p>
      <div class="actions"><a class="btn" href="${esc(uri)}">Pay with a UPI app</a></div>${summary}
      ${proofBlock(ws, b, await proofsFor(ws, [b.id]))}`);
  }
  if (b.status === "held" && b.pay_status === "awaiting") {
    const left = Math.max(0, (b.hold_expires_at ?? 0) - Date.now());
    return payShell(ws, "Complete payment", `${top}<div class="state"><h1>Pay ${inr(b.amount)} to confirm</h1><p>Your slot is held for <b data-countdown="${b.hold_expires_at}">${Math.ceil(left / 60000)} min</b>.</p></div>${summary}
      <div class="actions"><a class="btn" href="${esc(b.pay_url || "#")}">Pay ${inr(b.amount)} securely</a></div>
      <p class="fine" data-poll="/pay/${ws.public_id}/${b.ref}/${payToken(ws, b.ref)}/status">This page updates by itself once the payment goes through.</p>`);
  }
  if (b.status === "paid_unbooked") {
    return payShell(ws, "Payment received", `${top}<div class="state ok"><span class="big">✓</span><h1>Payment received</h1><p>Sorry, the time you picked was taken while the payment went through. Message ${esc(ws.business_name)} with another day or time: your payment of ${inr(b.amount)} covers it.</p></div>${summary}`);
  }
  const why = b.pay_status === "expired" ? "The payment link expired, so the slot was released. If money left your account, your bank normally returns it within 5–7 working days." : "This booking was cancelled.";
  return payShell(ws, "Not active", `${top}<div class="state bad"><h1>Not booked</h1><p>${why}</p></div>${summary}<p class="fine">Message ${esc(ws.business_name)} to book again.</p>`);
}

publicRoutes.get("/pay/:id/:ref/:token", async (req, res) => {
  if (rateLimited(`paypage:${req.ip}`, 60, 60_000)) return res.status(429).send("Too many requests. Wait a minute.");
  const ws = await getWorkspaceByPublicId(req.params.id);
  let b = ws ? await getBooking(ws, req.params.ref) : undefined;
  if (!ws || !b || !safeEqual(req.params.token, payToken(ws, b.ref))) return res.status(404).send("Booking not found.");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  const q = req.query as Record<string, string>;
  // Coming back from Razorpay: trust it only if the signature checks out, then confirm.
  if (q.razorpay_payment_link_id && q.razorpay_payment_link_id === b.payment_link_id) {
    if (verifyCallbackSignature(ws, q) && q.razorpay_payment_link_status === "paid") {
      await markPaid(ws, b, q.razorpay_payment_id || null, "redirect").catch((e) => console.error("markPaid", e?.message));
    } else if (b.status === "held") {
      await checkPayment(ws, b).catch(() => undefined);
    }
    b = (await getBooking(ws, b.ref))!;
  }
  res.send(await payView(ws, b));
});

publicRoutes.get("/pay/:id/:ref/:token/status", async (req, res) => {
  const ws = await getWorkspaceByPublicId(req.params.id);
  const b = ws ? await getBooking(ws, req.params.ref) : undefined;
  if (!ws || !b || !safeEqual(req.params.token, payToken(ws, b.ref))) return res.status(404).json({});
  if (rateLimited(`paystatus:${req.ip}`, 60, 60_000)) return res.status(429).json({});
  res.setHeader("Cache-Control", "no-store");
  res.json({ status: b.status, pay_status: b.pay_status });
});

// Short "send to customer" link for owners: opens their own WhatsApp with the booking details typed in.
publicRoutes.get("/f/:id/:ref/:token", async (req, res) => {
  if (rateLimited(`fwd:${req.ip}`, 60, 60_000)) return res.status(429).send("Too many requests.");
  const ws = await getWorkspaceByPublicId(String(req.params.id));
  const b = ws ? await getBooking(ws, String(req.params.ref)) : undefined;
  if (!ws || !b || !safeEqual(String(req.params.token), payToken(ws, b.ref))) return res.status(404).send("Booking not found.");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.redirect(302, `https://wa.me/${b.customer_phone.replace(/\D/g, "")}?text=${encodeURIComponent(forwardText(ws, b))}`);
});

// Payment screenshot from the pay page (website-chat customers have no WhatsApp to send it on).
const shotUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PROOF_BYTES, files: 1 } });
publicRoutes.post("/pay/:id/:ref/:token/proof", (req, res, next) => {
  if (rateLimited(`payproof:${req.ip}`, 8, 10 * 60_000)) return res.status(429).send("Too many uploads. Wait a few minutes.");
  shotUpload.single("shot")(req, res, (err: any) => (err ? res.status(400).send("That image is too large (max 3 MB).") : next()));
}, async (req, res) => {
  const ws = await getWorkspaceByPublicId(String(req.params.id));
  const b = ws ? await getBooking(ws, String(req.params.ref)) : undefined;
  if (!ws || !b || !safeEqual(String(req.params.token), payToken(ws, b.ref))) return res.status(404).send("Booking not found.");
  const back = `/pay/${ws.public_id}/${b.ref}/${payToken(ws, b.ref)}`;
  if (!req.file || b.pay_status !== "pending_manual") return res.redirect(303, back);
  try {
    const id = await saveProofImage(ws, `page:${b.ref}`, req.file.buffer, req.file.mimetype);
    await submitCustomerProof(ws, b, id);
  } catch (e: any) {
    console.warn(`[proof ${ws.public_id}]`, e?.message);
  }
  res.redirect(303, back);
});

// ---------- Privacy policy (needed for Google sign-in review) ----------

publicRoutes.get("/privacy", (_req, res) => {
  const name = env.appName.replace(/</g, "&lt;");
  res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Privacy · ${name}</title>${ICON_LINKS.value}<link rel="stylesheet" href="/static/pay.css?v=2"><style>:root{--accent:#0a84ff}.pay{max-width:720px}h2{font-size:18px;margin-top:26px}p,li{color:var(--text-2)}</style></head><body><main class="pay">
<h1>Privacy policy</h1><p>${name} is a booking assistant for small businesses. This page explains what we store and why.</p>
<h2>Google Calendar</h2><p>When a business signs in with Google, we only request permission to see free/busy times, list calendars they can edit, and create, change or remove the booking events we make. We use this solely to offer free slots and to add bookings (with an email invite to the customer and, for online sessions, a Google Meet link). We never read the content of other events, emails or files, never sell Google data, and don't use it for advertising or to train AI models. Our use of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements. A business can disconnect at any time from its dashboard or at myaccount.google.com/permissions.</p>
<h2>What we store</h2><ul><li>Business account details and settings entered by the business.</li><li>Conversation history with customers (kept up to 30 days) and booking records (name, phone, optional email, service, time, payment status).</li><li>Access keys the business provides (Claude, Google, Kapso, Razorpay), encrypted.</li></ul>
<h2>Who processes data</h2><p>Messages are answered by Anthropic's Claude using the business's own account; WhatsApp messages pass through Kapso and Meta; online payments are handled by Razorpay. Card and bank details never reach us.</p>
<h2>Deleting data</h2><p>Businesses can remove files, bookings and connections themselves, or ask their account manager to delete the whole account, which removes all its data.</p>
<h2>Contact</h2><p>Questions: contact the business you booked with, or the ${name} team.</p>
</main></body></html>`);
});
