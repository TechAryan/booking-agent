// Fake Anthropic (/v1/messages) + Kapso (/platform/v1, /meta/whatsapp) for E2E tests.
import http from "node:http";
import fs from "node:fs";
const LOG = process.env.FAKE_LOG || "/tmp/fakes.jsonl";
fs.writeFileSync(LOG, "");
const log = (o) => fs.appendFileSync(LOG, JSON.stringify(o) + "\n");
const tomorrow = () => new Date(Date.now() + 86400000 + 5.5 * 3600000).toISOString().slice(0, 10);

function claude(j, key) {
  if (key === "sk-ant-bad") return [401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }];
  if (!j.tools) return [200, msg([{ type: "text", text: "ok" }], "end_turn")];
  const last = j.messages.at(-1);
  if (typeof last.content === "string") {
    const t = last.content.toLowerCase();
    if (t.includes("what bookings")) {
      const needPhone = JSON.stringify(j.tools).includes("customer_phone");
      return [200, msg([{ type: "tool_use", id: "t9", name: "list_my_appointments", input: needPhone ? { customer_phone: "+919999999999" } : {} }])];
    }
    if (t.includes("book")) return [200, msg([{ type: "tool_use", id: "t1", name: "check_availability", input: { date: tomorrow() } }])];
    return [200, msg([{ type: "text", text: `Hello from ${j.system.match(/booking assistant for (.*?) on/)?.[1]}` }], "end_turn")];
  }
  const tr = last.content[0];
  const prev = j.messages.at(-2).content.find((b) => b.type === "tool_use");
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

http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const j = body ? JSON.parse(body) : {};
    res.setHeader("Content-Type", "application/json");
    const send = (code, obj) => { res.statusCode = code; res.end(obj === undefined ? "" : JSON.stringify(obj)); };
    if (req.url.startsWith("/v1/messages")) {
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
