// Fake Anthropic (/v1/messages) + Kapso (/platform/v1, /meta/whatsapp) for E2E tests.
import http from "node:http";
import fs from "node:fs";
const LOG = process.env.FAKE_LOG || "/tmp/fakes.jsonl";
fs.writeFileSync(LOG, "");
const log = (o) => fs.appendFileSync(LOG, JSON.stringify(o) + "\n");
const tomorrow = () => new Date(Date.now() + 86400000 + 5.5 * 3600000).toISOString().slice(0, 10);

function claude(j, key) {
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

http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const j = body ? JSON.parse(body) : {};
    res.setHeader("Content-Type", "application/json");
    const send = (code, obj) => { res.statusCode = code; res.end(obj === undefined ? "" : JSON.stringify(obj)); };
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
    const k = req.headers["x-api-key"];
    log({ method: req.method, url: req.url, key: k, body: j });
    if (k !== "kapso-good") return send(401, { error: "Unauthorized" });
    let m;
    if ((m = req.url.match(/^\/platform\/v1\/whatsapp\/phone_numbers\/(\d+)$/)) && req.method === "GET") {
      return m[1] === "111222333" ? send(200, { data: { phone_number_id: "111222333", display_phone_number: "+1 555 010 0101" } }) : send(404, { error: "Not found" });
    }
    if (req.url.match(/^\/platform\/v1\/whatsapp\/phone_numbers\/\d+\/webhooks$/) && req.method === "POST") {
      return send(201, { data: { id: "wh-123", ...j.whatsapp_webhook } });
    }
    if (req.method === "DELETE") return send(204);
    if (req.url.includes("/meta/whatsapp/")) return send(200, { messaging_product: "whatsapp", messages: [{ id: "wamid.out" }], success: true });
    send(404, { error: "no route" });
  });
}).listen(4100, () => console.log("fakes on 4100"));
