// Fake Anthropic (/v1/messages) + Kapso (/platform/v1, /meta/whatsapp) for E2E tests.
import http from "node:http";
import fs from "node:fs";
const LOG = process.env.FAKE_LOG || "/tmp/fakes.jsonl";
fs.writeFileSync(LOG, "");
const log = (o) => fs.appendFileSync(LOG, JSON.stringify(o) + "\n");
const tomorrow = () => new Date(Date.now() + 86400000 + 5.5 * 3600000).toISOString().slice(0, 10);

function claude(j, key) {
  // Reading a payment screenshot: the fake "image" is text like "amt=680;utr=111122223333;vpa=glow@okhdfcbank".
  if (j.tool_choice?.name === "payment_details") {
    const img = j.messages[0].content.find((c) => c.type === "image");
    const t = Buffer.from(img.source.data, "base64").toString("utf8");
    const f = Object.fromEntries(t.split(";").map((kv) => kv.split("=")));
    return [200, msg([{ type: "tool_use", id: "pd", name: "payment_details", input: {
      is_payment_screenshot: !("junk" in f), successful: f.ok !== "0", amount: f.amt ? Number(f.amt) : null, utr: f.utr || "", payee_upi_id: f.vpa || "", payee_name: f.name || "", paid_at: f.at || "",
    } }], "tool_use")];
  }
  if (j.tool_choice?.name === "landing_copy") {
    const src = typeof j.messages[0].content === "string" ? j.messages[0].content : j.messages[0].content.map((c) => c.text ?? "").join("");
    const svcs = [...src.matchAll(/^- ([^(:\n]+?) \(/gm)].map((m) => m[1]);
    const tone = src.match(/Tone: ([^.]+)\./)?.[1] ?? "";
    return [200, msg([{ type: "tool_use", id: "lc", name: "landing_copy", input: {
      headline: `<script>alert(1)</script> ${src.match(/Business: ([^\n(]+)/)?.[1]?.trim() ?? "Shop"}${tone ? " " + tone : ""}`,
      subheadline: "Relaxing care, booked in a minute on WhatsApp.",
      about: "We are a friendly studio.\n\nBook online & pay at the venue.",
      services: svcs.map((n) => ({ name: n, blurb: `Our ${n.toLowerCase()} treatment.` })).concat([{ name: "Invented service", blurb: "should be dropped" }]),
      faqs: [{ q: "Do I need to book?", a: "Yes, book on WhatsApp." }, { q: "Can I pay online?", a: "Yes, and save 10%." }],
      seo_title: "Glow Studio — Facials in Bengaluru", seo_description: "Facials and consultations. Book on WhatsApp.", cta: "Book now",
    } }], "tool_use")];
  }
  if (j.tool_choice?.name === "save_business_profile") {
    const src = j.messages[0].content;
    return [200, msg([{ type: "tool_use", id: "tp", name: "save_business_profile", input: {
      summary_markdown: `# Glow Studio\nWe offer facials and bridal makeup.${src.includes("Bridal makeup ₹5000") ? " Bridal makeup costs ₹5000." : ""}`,
      services: [{ name: "Bridal makeup", price: 5000, details: "Includes trial", mode: "offline" }, { name: "Cleaning", price: null, details: "", mode: "offline" }],
      contact: { phone: "+91 90000 11111", address: "5 Park Street, Kolkata" },
    } }], "tool_use")];
  }
  if (key === "sk-ant-bad") return [401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }];
  if (!j.tools) return [200, msg([{ type: "text", text: "ok" }], "end_turn")];
  const last = j.messages.at(-1);
  const system = Array.isArray(j.system) ? j.system.map((b) => b.text).join("\n") : j.system;
  if (typeof last.content === "string") {
    const t = last.content.toLowerCase();
    // Scripted tool call for tests: "!tool name {json}"
    const scripted = last.content.match(/^!tool (\w+)\s*(\{.*\})?\s*$/s);
    if (scripted) return [200, msg([{ type: "tool_use", id: "ts", name: scripted[1], input: scripted[2] ? JSON.parse(scripted[2]) : {} }])];
    if (t.startsWith("!system")) return [200, msg([{ type: "text", text: system }], "end_turn")];
    if (t.startsWith("!tools")) return [200, msg([{ type: "text", text: j.tools.map((x) => x.name).join(",") }], "end_turn")];
    if (t.includes("what bookings")) {
      const needPhone = JSON.stringify(j.tools).includes("customer_phone");
      return [200, msg([{ type: "tool_use", id: "t9", name: "list_my_appointments", input: needPhone ? { customer_phone: "+919999999999" } : {} }])];
    }
    if (t.includes("book")) return [200, msg([{ type: "tool_use", id: "t1", name: "check_availability", input: { date: tomorrow() } }])];
    return [200, msg([{ type: "text", text: `Hello from ${system.match(/booking assistant for (.*?) on/)?.[1] ?? system.match(/control assistant for (.*?)\./)?.[1]}` }], "end_turn")];
  }
  const tr = last.content[0];
  const prev = j.messages.at(-2).content.find((b) => b.type === "tool_use");
  if (prev.id === "ts") return [200, msg([{ type: "text", text: `RESULT ${prev.name}: ${tr.content}` }], "end_turn")];
  if (prev.name === "check_availability") {
    const slots = JSON.parse(tr.content).slots;
    const needPhone = JSON.stringify(j.tools).includes("customer_phone");
    return [200, msg([{ type: "tool_use", id: "t2", name: "book_appointment", input: { start: `${tomorrow()}T${slots[0]}`, customer_name: "Priya", service: "Cleaning", ...(needPhone ? { customer_phone: "+919999999999" } : {}) } }])];
  }
  return [200, msg([{ type: "text", text: `RESULT ${prev.name}: ${tr.content}` }], "end_turn")];
}
function msg(content, stop = "tool_use") {
  return { id: "m", type: "message", role: "assistant", model: "x", content, stop_reason: stop, usage: { input_tokens: 1, output_tokens: 1 } };
}

// ---- Fake Razorpay (keys rzp_test_good / secret_good)
import crypto from "node:crypto";
const links = new Map();
let linkSeq = 1;
function razorpay(req, j, send) {
  const auth = Buffer.from(String(req.headers.authorization || "").replace(/^Basic /, ""), "base64").toString();
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/__rzp/")) {
    const [, , action, id] = url.pathname.split("/");
    const l = links.get(id);
    if (!l) return send(404, {});
    if (action === "pay") {
      l.status = "paid"; l.amount_paid = l.amount; l.payments = [{ payment_id: `pay_${id}`, status: "captured", amount: l.amount }];
      const q = { razorpay_payment_id: `pay_${id}`, razorpay_payment_link_id: id, razorpay_payment_link_reference_id: l.reference_id, razorpay_payment_link_status: "paid" };
      q.razorpay_signature = crypto.createHmac("sha256", "secret_good").update(`${q.razorpay_payment_link_id}|${q.razorpay_payment_link_reference_id}|${q.razorpay_payment_link_status}|${q.razorpay_payment_id}`).digest("hex");
      return send(200, { link: l, callback: q });
    }
    if (action === "expire") { l.status = "expired"; return send(200, l); }
    if (action === "get") return send(200, l);
  }
  log({ razorpay: true, method: req.method, url: req.url, auth, body: j });
  if (auth !== "rzp_test_good:secret_good") return send(401, { error: { code: "BAD_REQUEST_ERROR", description: "The api key provided is invalid" } });
  if (url.pathname === "/v1/payment_links" && req.method === "GET") return send(200, { count: 0, items: [] });
  if (url.pathname === "/v1/payment_links" && req.method === "POST") {
    const id = `plink_${linkSeq++}`;
    const l = { id, short_url: `http://localhost:4100/rzp/${id}`, status: "created", amount: j.amount, amount_paid: 0, reference_id: j.reference_id, expire_by: j.expire_by, customer: j.customer, callback_url: j.callback_url, payments: [] };
    links.set(id, l);
    return send(200, l);
  }
  let m;
  if ((m = url.pathname.match(/^\/v1\/payment_links\/(plink_\d+)$/))) return links.has(m[1]) ? send(200, links.get(m[1])) : send(404, {});
  if ((m = url.pathname.match(/^\/v1\/payment_links\/(plink_\d+)\/cancel$/))) { const l = links.get(m[1]); if (l && l.status === "created") l.status = "cancelled"; return send(200, l || {}); }
  return send(404, { error: { description: "no route" } });
}


// ---- Fake AI providers (OpenAI-style). Requests are translated to the Claude fake's shape so the same
// scripted behaviour ("!tool …", booking flow, screenshot reading) works for every provider.
const AI_MODELS = {
  openai: ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-mini", "text-embedding-4", "gpt-realtime-2"],
  gemini: ["models/gemini-3.8-flash", "models/gemini-3.5-flash-lite", "models/gemini-3.1-pro-preview", "models/gemini-embedding-002"],
  deepseek: ["deepseek-flash", "deepseek-v4-pro"],
  sarvam: ["sarvam-105b", "sarvam-105b-conversations"],
  openrouter: ["anthropic/claude-sonnet-5.5", "anthropic/claude-haiku-5.5", "google/gemini-3.8-flash", "meta/llama-9"],
};
const aiKeyOk = (p, k) => k && !/bad/.test(k) && !(p === "deepseek" && /broke/.test(k));
function chatToClaude(j) {
  const out = { system: "", messages: [], tools: j.tools?.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters })) };
  if (j.tool_choice === "required" && out.tools?.length === 1) out.tool_choice = { type: "tool", name: out.tools[0].name };
  const push = (role, blocks) => { const last = out.messages.at(-1); if (last && last.role === role && Array.isArray(last.content)) last.content.push(...blocks); else out.messages.push({ role, content: blocks }); };
  for (const m of j.messages) {
    if (m.role === "system") { out.system += m.content; continue; }
    if (m.role === "tool") { push("user", [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content }]); continue; }
    if (m.role === "assistant") {
      const b = [];
      if (m.content) b.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls ?? []) b.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: JSON.parse(tc.function.arguments) });
      push("assistant", b); continue;
    }
    if (typeof m.content === "string") out.messages.push({ role: "user", content: m.content });
    else push("user", m.content.map((c) => c.type === "text" ? { type: "text", text: c.text } : { type: "image", source: { type: "base64", data: c.image_url.url.split(",")[1] } }));
  }
  return out;
}
function respToClaude(j) {
  const out = { system: j.instructions, messages: [], tools: j.tools?.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) };
  if (j.tool_choice?.name) out.tool_choice = { type: "tool", name: j.tool_choice.name };
  const push = (role, blocks) => { const last = out.messages.at(-1); if (last && last.role === role && Array.isArray(last.content)) last.content.push(...blocks); else out.messages.push({ role, content: blocks }); };
  for (const it of j.input) {
    if (it.type === "reasoning") continue;
    if (it.type === "function_call") { push("assistant", [{ type: "tool_use", id: it.call_id, name: it.name, input: JSON.parse(it.arguments) }]); continue; }
    if (it.type === "function_call_output") { push("user", [{ type: "tool_result", tool_use_id: it.call_id, content: it.output }]); continue; }
    if (it.type === "message" && it.role === "assistant") { push("assistant", it.content.map((c) => ({ type: "text", text: c.text }))); continue; }
    if (typeof it.content === "string") { if (it.role === "assistant") push("assistant", [{ type: "text", text: it.content }]); else out.messages.push({ role: "user", content: it.content }); continue; }
    push(it.role, it.content.map((c) => c.type === "input_text" ? { type: "text", text: c.text } : { type: "image", source: { type: "base64", data: c.image_url.split(",")[1] } }));
  }
  return out;
}
let fcSeq = 0;
function fakeAI(p, rest, req, j, send) {
  const key = (req.headers.authorization || "").replace(/^Bearer /, "");
  if (req.method === "GET" && rest === "/models") {
    if (!aiKeyOk(p, key)) return send(401, { error: { message: "Incorrect API key provided" } });
    return send(200, { object: "list", data: AI_MODELS[p].map((id) => ({ id, ...(p === "openrouter" ? { name: id.split("/")[1] } : {}) })) });
  }
  if (p === "deepseek" && rest === "/user/balance") return send(200, { is_available: !/broke/.test(key), balance_infos: [{ currency: "USD", total_balance: /broke/.test(key) ? "0.00" : "4.20" }] });
  if (p === "openrouter" && rest === "/key") return send(200, { data: { label: "test", limit_remaining: 9.5, usage: 0.5 } });
  if (!aiKeyOk(p, key)) return send(p === "gemini" ? 400 : 401, { error: { message: p === "gemini" ? "API key not valid. Please pass a valid API key." : "Incorrect API key provided" } });
  if (!AI_MODELS[p].some((m) => m.replace(/^models\//, "") === j.model)) return send(404, { error: { message: `The model ${j.model} does not exist` } });
  if (rest === "/responses") {
    const reasoningBack = j.input.some((i) => i.type === "reasoning");
    log({ ai: p, model: j.model, key, store: j.store, reasoning: j.reasoning, reasoningBack, cacheKey: j.prompt_cache_key });
    const [c, o] = claude(respToClaude(j), "x");
    if (c !== 200) return send(c, o);
    const output = [{ type: "reasoning", id: `rs_${++fcSeq}`, summary: [], encrypted_content: "enc-" + fcSeq }];
    for (const b of o.content) {
      if (b.type === "text") output.push({ type: "message", id: `msg_${++fcSeq}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: b.text }] });
      if (b.type === "tool_use") output.push({ type: "function_call", id: `fc_${++fcSeq}`, call_id: b.id, name: b.name, arguments: JSON.stringify(b.input) });
    }
    return send(200, { id: "resp", object: "response", output, usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 2 } } });
  }
  if (rest === "/chat/completions") {
    // Gemini 3 rejects a function call in history that lost its thought signature.
    if (p === "gemini") for (const m of j.messages) if (m.tool_calls?.length && !m.tool_calls[0].extra_content?.google?.thought_signature) return send(400, { error: { message: "Function call is missing a thought_signature" } });
    if (p === "gemini" && JSON.stringify(j.tools ?? []).includes('"type":["')) return send(400, { error: { message: "Invalid JSON payload: type list" } });
    const sigs = j.messages.flatMap((m) => (m.tool_calls ?? []).map((t) => t.extra_content?.google?.thought_signature)).filter(Boolean);
    log({ ai: p, model: j.model, key, thinking: j.thinking, reasoning_effort: j.reasoning_effort, hasReasoningEffort: "reasoning_effort" in j, toolChoice: j.tool_choice, sigs, image: JSON.stringify(j.messages).includes("image_url") });
    const [c, o] = claude(chatToClaude(j), "x");
    if (c !== 200) return send(c, o);
    const text = o.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    const calls = o.content.filter((b) => b.type === "tool_use").map((b, i) => ({
      id: p === "gemini" ? "" : `call_${b.id}`, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) },
      ...(p === "gemini" && i === 0 ? { extra_content: { google: { thought_signature: `sig-${++fcSeq}` } } } : {}),
    }));
    return send(200, { id: "c", object: "chat.completion", choices: [{ index: 0, finish_reason: calls.length ? (p === "gemini" ? "stop" : "tool_calls") : "stop", message: { role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) } }],
      usage: { prompt_tokens: 12, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 3 } } });
  }
  return send(404, { error: { message: "no route" } });
}


// ---- Fake WhatsApp providers (Phase 2). Mounted at /wa/<provider>/…; every send is logged as { wa, to, text }.
const WA_KEYS = { meta: "Bearer meta-good-token", d360: "d360-good", gupshup: "gs-good", wati: "Bearer wati-good", gallabox: "gb-key|gb-secret" };
const TW_AUTH = "Basic " + Buffer.from("AC" + "a".repeat(32) + ":" + "b".repeat(32)).toString("base64");
const EX_AUTH = "Basic " + Buffer.from("exkey:extoken").toString("base64");
async function fakeWa(p, rest, req, raw, res) {
  const json = (code, obj) => { res.statusCode = code; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj)); };
  const bytes = (hex, type = "image/png") => { res.setHeader("Content-Type", type); res.end(Buffer.from(hex, "hex")); };
  const url = new URL(rest, "http://x");
  const path = url.pathname;
  let j = {}; try { j = raw ? JSON.parse(raw) : {}; } catch { j = Object.fromEntries(new URLSearchParams(raw)); }
  const sent = (to, text) => { log({ wa: p, to: String(to).replace(/[^\d]/g, "") || to, text }); };
  const h = req.headers;
  if (p === "meta") {
    if (h.authorization !== WA_KEYS.meta) return json(401, { error: { message: "Invalid OAuth access token" } });
    let m;
    if ((m = path.match(/^\/v[\d.]+\/(\d+)\/messages$/))) { if (j.status === "read") { log({ wa: p, read: j.message_id }); return json(200, { success: true }); } sent(j.to ?? j.recipient, j.text?.body); return json(200, { messages: [{ id: "wamid.out" }] }); }
    if ((m = path.match(/^\/v[\d.]+\/(\d+)\/subscribed_apps$/))) return json(200, { success: true });
    if ((m = path.match(/^\/v[\d.]+\/(\d+)$/)) && req.method === "GET" && m[1].startsWith("media")) return json(200, {});
    if ((m = path.match(/^\/v[\d.]+\/(\d{6,})$/))) {
      if (req.method === "GET") return m[1] === "106540352242922" ? json(200, { display_phone_number: "+91 98000 11111", verified_name: "Glow" }) : json(404, { error: { message: "Unsupported get request" } });
      const cb = j.webhook_configuration?.override_callback_uri;
      log({ wa: p, webhook: cb ?? null });
      if (cb) { // Meta checks the address before accepting it
        const r = await fetch(`${cb}?hub.mode=subscribe&hub.challenge=ch4ll&hub.verify_token=${encodeURIComponent(j.webhook_configuration.verify_token)}`);
        if ((await r.text()) !== "ch4ll") return json(400, { error: { message: "Callback verification failed" } });
      }
      return json(200, { success: true });
    }
    if ((m = path.match(/^\/v[\d.]+\/(med_[0-9a-f]+)$/))) return json(200, { url: `http://localhost:4100/wa/meta/cdn/${m[1].slice(4)}`, mime_type: "image/png" });
    if ((m = path.match(/^\/cdn\/([0-9a-f]+)$/))) { log({ wa: p, download: m[1] }); return bytes(m[1]); }
  }
  if (p === "d360") {
    if (h["d360-api-key"] !== WA_KEYS.d360) return json(401, { error: "Invalid api key" });
    let m;
    if (path === "/health_status") return json(200, { display_phone_number: "+91 98000 22222", health_status: { can_send_message: "AVAILABLE" } });
    if (path === "/v1/configs/webhook") { log({ wa: p, webhook: j.url, headers: j.headers }); return json(201, { url: j.url }); }
    if (path === "/messages") { if (j.status === "read") return json(200, { success: true }); sent(j.to, j.text?.body); return json(200, { messages: [{ id: "wamid.x" }] }); }
    if (path === "/whatsapp_business/attachments/") { log({ wa: p, download: url.searchParams.get("mid") }); return bytes(url.searchParams.get("mid")); }
    if ((m = path.match(/^\/(med_[0-9a-f]+)$/))) return json(200, { url: `https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=${m[1].slice(4)}&ext=1`, mime_type: "image/png" });
  }
  if (p === "twilio") {
    if (h.authorization !== TW_AUTH) return json(401, { message: "Authenticate" });
    let m;
    if (/^\/2010-04-01\/Accounts\/AC\w+\.json$/.test(path)) return json(200, { sid: "AC", status: "active" });
    if (path === "/v2/Channels/Senders") return json(200, { senders: [{ sid: "XE" + "1".repeat(32), sender_id: "whatsapp:+919800033333", status: "ONLINE" }] });
    if ((m = path.match(/^\/v2\/Channels\/Senders\/(XE\w+)$/))) { log({ wa: p, webhook: j.webhook?.callback_url }); return json(200, { sid: m[1] }); }
    if (/\/Messages\.json$/.test(path)) { sent(j.To, j.Body); if (j.From !== "whatsapp:+919800033333") return json(400, { message: "bad From" }); return json(201, { sid: "SM1" }); }
    if ((m = path.match(/^\/media\/([0-9a-f]+)$/))) { log({ wa: p, download: m[1] }); return bytes(m[1], "image/jpeg"); }
  }
  if (p === "gupshup") {
    if (h.apikey !== WA_KEYS.gupshup) return json(401, { status: "error", message: "Authentication Failed" });
    if (/^\/wa\/app\/[\w-]+\/template$/.test(path)) return json(200, { status: "success", templates: [] });
    if (/^\/wa\/app\/[\w-]+\/subscription$/.test(path)) { log({ wa: p, webhook: j.url }); return json(200, { status: "success" }); }
    if (path === "/wa/api/v1/msg") { const msg = JSON.parse(j.message); sent(j.destination, msg.text); if (j["src.name"] !== "GlowBot") return json(400, { status: "error", message: "bad app" }); return json(200, { status: "submitted", messageId: "g1" }); }
    let m; if ((m = path.match(/^\/media\/([0-9a-f]+)$/))) { log({ wa: p, download: m[1] }); return bytes(m[1]); }
  }
  if (p === "wati") {
    let m;
    if ((m = path.match(/^\/media-public\/([0-9a-f]+)$/))) return bytes(m[1]);
    if (h.authorization !== WA_KEYS.wati) return json(401, { message: "Unauthorized" });
    if (path === "/12345/api/v1/whatsApp/phoneNumbers") return json(200, { result: [{ displayPhoneNumber: "+91 98000 44444" }] });
    if (path === "/12345/api/v2/webhookEndpoints") { log({ wa: p, webhook: j[0]?.url }); return json(200, { result: true }); }
    if ((m = path.match(/^\/12345\/api\/v1\/sendSessionMessage\/(\d+)$/))) { sent(m[1], url.searchParams.get("messageText")); return json(200, { ok: true, result: "success" }); }
    if (path === "/12345/api/v1/getMedia") { const f = url.searchParams.get("fileName"); log({ wa: p, download: f }); return bytes(f.match(/([0-9a-f]+)\.jpg$/)[1], "image/jpeg"); }
  }
  if (p === "gallabox") {
    let m;
    if ((m = path.match(/^\/media\/([0-9a-f]+)$/))) { log({ wa: p, download: m[1] }); return bytes(m[1]); }
    if (`${h.apikey}|${h.apisecret}` !== WA_KEYS.gallabox) return json(401, { message: "Unauthorized" });
    if (path === "/devapi/test") return json(200, { ok: true });
    if (path === "/devapi/messages/whatsapp") { sent(j.recipient?.phone, j.whatsapp?.text?.body); return json(202, { status: "ACCEPTED" }); }
  }
  if (p === "exotel") {
    let m;
    if ((m = path.match(/^\/media\/([0-9a-f]+)$/))) { log({ wa: p, download: m[1] }); return bytes(m[1]); }
    if (h.authorization !== EX_AUTH) return json(401, { RestException: { Message: "Authentication failed" } });
    if (/^\/v1\/Accounts\/\w+\/Balance\.json$/.test(path)) return json(200, { Account: { AccountSid: "glow1" } });
    if (/^\/v2\/accounts\/\w+\/messages$/.test(path)) { const msg = j.whatsapp.messages[0]; sent(msg.to, msg.content.text.body); return json(202, { response: { whatsapp: { messages: [{ status: "success", data: { sid: "ex1" } }] } } }); }
  }
  json(404, { error: { message: `fake ${p}: no route ${req.method} ${path}` } });
}

const r2 = new Map(); // fake Cloudflare R2 (S3 API): /r2/<bucket>/<key>
http.createServer((req, res) => {
  let wam;
  if ((wam = req.url.match(/^\/wa\/(meta|d360|twilio|gupshup|wati|gallabox|exotel)(\/.*)$/))) {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    return req.on("end", () => fakeWa(wam[1], wam[2], req, Buffer.concat(chunks).toString("utf8"), res).catch((e) => { res.statusCode = 500; res.end(String(e)); }));
  }
  if (req.url.startsWith("/r2/")) {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    return req.on("end", () => {
      const key = decodeURIComponent(req.url.slice(4).split("?")[0]);
      const auth = req.headers.authorization || "";
      if (!auth.startsWith("AWS4-HMAC-SHA256 Credential=r2-key/") || !req.headers["x-amz-date"]) { res.statusCode = 403; return res.end("SignatureDoesNotMatch"); }
      log({ r2: req.method, key });
      if (req.method === "PUT") { r2.set(key, { body: Buffer.concat(chunks), type: req.headers["content-type"] || "" }); res.statusCode = 200; return res.end(); }
      const f = r2.get(key);
      if (req.method === "DELETE") { r2.delete(key); res.statusCode = 204; return res.end(); }
      if (!f) { res.statusCode = 404; return res.end("NoSuchKey"); }
      res.setHeader("Content-Type", f.type); return res.end(f.body);
    });
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const j = body ? JSON.parse(body) : {};
    res.setHeader("Content-Type", "application/json");
    const send = (code, obj) => { res.statusCode = code; res.end(obj === undefined ? "" : JSON.stringify(obj)); };
    let ai;
    if ((ai = req.url.match(/^\/ai\/(openai|gemini|deepseek|sarvam|openrouter)(\/[^?]*)/))) return fakeAI(ai[1], ai[2], req, j, send);
    if (req.url.startsWith("/v1/payment_links") || req.url.startsWith("/__rzp/")) return razorpay(req, j, send);
    if (req.url.startsWith("/site")) {
      res.setHeader("Content-Type", "text/html");
      if (req.url === "/site") return res.end(`<html><head><title>Glow Studio</title><meta name="description" content="Salon in Kolkata"></head><body><nav><a href="/site/services">Our services</a><a href="/site/blog">Blog</a></nav><h1>Welcome to Glow Studio</h1><script>var x=1</script></body></html>`);
      if (req.url === "/site/services") return res.end(`<html><body><h2>Services</h2><ul><li>Bridal makeup ₹5000</li><li>Facial ₹800</li></ul></body></html>`);
      res.statusCode = 404; return res.end("nope");
    }
    if (req.url.startsWith("/v1/messages")) {
      log({ claude: true, key: req.headers["x-api-key"], model: j.model });
      const [c, o] = claude(j, req.headers["x-api-key"]);
      return send(c, o);
    }
    // Photo download: media id "media_<hex of the bytes>"
    let mm;
    if ((mm = req.url.match(/^\/media\/([0-9a-f]+)/))) { res.setHeader("Content-Type", "image/png"); return res.end(Buffer.from(mm[1], "hex")); }
    const k = req.headers["x-api-key"];
    log({ method: req.method, url: req.url, key: k, body: j });
    if (req.method === "GET" && (mm = req.url.match(/\/meta\/whatsapp\/v[\d.]+\/media_([0-9a-f]+)/))) return send(200, { url: `http://localhost:4100/media/${mm[1]}`, mime_type: "image/png", id: `media_${mm[1]}` });
    if (k !== "kapso-good") return send(401, { error: "Unauthorized" });
    let m;
    if ((m = req.url.match(/^\/platform\/v1\/whatsapp\/phone_numbers\/(\d+)$/)) && req.method === "GET") {
      return m[1] === "111222333" ? send(200, { data: { phone_number_id: "111222333", display_phone_number: "+1 555 010 0101" } }) : send(404, { error: "Not found" });
    }
    if (req.url.match(/^\/platform\/v1\/whatsapp\/phone_numbers\/\d+\/webhooks$/) && req.method === "GET") {
      return send(200, { data: [{ id: "wh-stale", url: "http://localhost:3300/webhooks/kapso/ws_gone" }, { id: "wh-123", url: "http://localhost:3300/webhooks/kapso/x" }, { id: "wh-theirs", url: "https://other.example/hook" }] });
    }
    if (req.url.match(/^\/platform\/v1\/whatsapp\/phone_numbers\/\d+\/webhooks$/) && req.method === "POST") {
      return send(201, { data: { id: "wh-123", ...j.whatsapp_webhook } });
    }
    if (req.method === "DELETE") return send(204);
    if (req.url.includes("/meta/whatsapp/")) return send(200, { messaging_product: "whatsapp", messages: [{ id: "wamid.out" }], success: true });
    send(404, { error: "no route" });
  });
}).listen(4100, () => console.log("fakes on 4100"));
