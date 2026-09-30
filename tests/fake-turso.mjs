// Minimal stand-in for Turso's HTTP API (Hrana v2 JSON pipeline) backed by real SQLite.
// Lets the test suite exercise the exact Turso client code path without a Turso account.
//   node tests/fake-turso.mjs  → listens on :4200, requires "Authorization: Bearer test-token"
import http from "node:http";
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(process.env.FAKE_TURSO_DB || ":memory:");
const PORT = Number(process.env.FAKE_TURSO_PORT || 4200);

const toSql = (v) => {
  if (!v || v.type === "null") return null;
  if (v.type === "integer") return BigInt(v.value);
  if (v.type === "float") return Number(v.value);
  if (v.type === "text") return v.value;
  if (v.type === "blob") return Buffer.from(v.base64, "base64");
  throw new Error(`bad value ${JSON.stringify(v)}`);
};
const toHrana = (v) => {
  if (v === null || v === undefined) return { type: "null" };
  if (typeof v === "bigint") return { type: "integer", value: String(v) };
  if (typeof v === "number") return Number.isInteger(v) ? { type: "integer", value: String(v) } : { type: "float", value: v };
  if (typeof v === "string") return { type: "text", value: v };
  if (v instanceof Uint8Array) return { type: "blob", base64: Buffer.from(v).toString("base64") };
  return { type: "text", value: String(v) };
};

function execute(stmt) {
  const st = db.prepare(stmt.sql);
  st.setReadBigInts?.(true);
  const pos = (stmt.args || []).map(toSql);
  const named = Object.fromEntries((stmt.named_args || []).map((a) => [a.name.replace(/^[:@$]/, ""), toSql(a.value)]));
  const params = Object.keys(named).length ? [named, ...pos] : pos;
  const returnsRows = st.columns().length > 0;
  if (returnsRows) {
    const cols = st.columns().map((c) => ({ name: c.name, decltype: c.type ?? null }));
    const rows = st.all(...params).map((r) => cols.map((c) => toHrana(r[c.name])));
    return { cols, rows, affected_row_count: 0, last_insert_rowid: null };
  }
  const r = st.run(...params);
  return { cols: [], rows: [], affected_row_count: Number(r.changes), last_insert_rowid: String(r.lastInsertRowid) };
}

function handle(req) {
  switch (req.type) {
    case "execute":
      return { type: "execute", result: execute(req.stmt) };
    case "sequence":
      db.exec(req.sql);
      return { type: "sequence" };
    case "batch": {
      const step_results = [], step_errors = [];
      for (const step of req.batch.steps) {
        try { step_results.push(execute(step.stmt)); step_errors.push(null); }
        catch (e) { step_results.push(null); step_errors.push({ message: e.message }); }
      }
      return { type: "batch", result: { step_results, step_errors } };
    }
    case "get_autocommit":
      return { type: "get_autocommit", is_autocommit: true };
    case "close":
      return { type: "close" };
    default:
      throw new Error(`unsupported request ${req.type}`);
  }
}

http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.setHeader("Content-Type", "application/json");
    if (req.headers.authorization !== "Bearer test-token") { res.statusCode = 401; return res.end('{"error":"Unauthorized"}'); }
    if (req.method === "GET" && req.url === "/v2") { res.statusCode = 200; return res.end("{}"); }
    if (req.method === "GET") { res.statusCode = 404; return res.end("{}"); }
    if (req.method === "POST" && req.url === "/v2/pipeline") {
      const j = JSON.parse(body);
      const results = j.requests.map((r) => {
        try { return { type: "ok", response: handle(r) }; }
        catch (e) { return { type: "error", error: { message: e.message } }; }
      });
      return res.end(JSON.stringify({ baton: "stateless", base_url: null, results }));
    }
    res.statusCode = 404; res.end("{}");
  });
}).listen(PORT, () => console.log(`fake turso on ${PORT}`));
