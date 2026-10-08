// Which AI a business uses, and the one function the rest of the app calls: aiChat(ws, …).
// Order: our shared Claude key (if the admin gave one) → the business's own connection → older saved Claude key.
import { db, Workspace } from "../db.js";
import { env } from "../env.js";
import { decrypt, encrypt } from "../security.js";
import { getClaudeKey } from "../models.js";
import { anthropicAdapter } from "./anthropic.js";
import { openaiCompatAdapter } from "./openai-compat.js";
import { openaiResponsesAdapter } from "./openai-responses.js";
import { DEFAULT_PROVIDER, providerById } from "./providers.js";
import { Adapter, AIError, Block, ChatRequest, ChatResult, ModelInfo, ProviderSpec, ToolDef } from "./types.js";

const ADAPTERS: Record<ProviderSpec["adapter"], Adapter> = {
  anthropic: anthropicAdapter,
  "openai-responses": openaiResponsesAdapter,
  "openai-compat": openaiCompatAdapter,
};

export interface AIConn { provider: ProviderSpec; key: string; model: string; shared: boolean }

export async function aiConnection(ws: Workspace): Promise<AIConn | null> {
  if (ws.shared_key_id) {
    const k = await getClaudeKey(ws.shared_key_id);
    const key = k && decrypt(k.key_enc);
    if (key) return { provider: DEFAULT_PROVIDER, key, model: k!.model || env.defaultModel, shared: true };
  }
  const row = await db.get<{ provider: string; config_enc: string }>("SELECT provider, config_enc FROM connections WHERE workspace_id=? AND kind='ai'", ws.id);
  if (row) {
    const p = providerById(row.provider);
    const cfg = JSON.parse(row.config_enc || "{}");
    const key = decrypt(cfg.key_enc);
    if (p && key) return { provider: p, key, model: cfg.model || p.versions[0]!.id, shared: false };
  }
  const legacy = decrypt(ws.anthropic_key_enc);
  return legacy ? { provider: DEFAULT_PROVIDER, key: legacy, model: ws.claude_model || env.defaultModel, shared: false } : null;
}

/** Saves the business's own AI. Claude keys are also kept in the old columns so nothing older breaks. */
export async function saveAIConnection(ws: Workspace, providerId: string, key: string, model: string) {
  // Keys for other AIs this business tried stay saved (encrypted), so switching back needs no re-paste.
  const prev = await db.get<{ config_enc: string }>("SELECT config_enc FROM connections WHERE workspace_id=? AND kind='ai'", ws.id);
  const saved = { ...(prev ? JSON.parse(prev.config_enc || "{}").saved ?? {} : {}), [providerId]: encrypt(key) };
  const cfg = JSON.stringify({ key_enc: encrypt(key), model, saved });
  await db.run(
    `INSERT INTO connections (workspace_id, kind, provider, config_enc, status, checked_at) VALUES (?, 'ai', ?, ?, 'ok', ?)
     ON CONFLICT(workspace_id, kind) DO UPDATE SET provider=excluded.provider, config_enc=excluded.config_enc, status='ok', checked_at=excluded.checked_at`,
    ws.id, providerId, cfg, Date.now()
  );
  if (providerId === "anthropic") await db.run("UPDATE workspaces SET anthropic_key_enc=?, claude_model=?, claude_ok=1 WHERE id=?", encrypt(key), model, ws.id);
  else await db.run("UPDATE workspaces SET claude_ok=1 WHERE id=?", ws.id);
}

/** The saved key for one provider, if this business saved one before (so switching back needs no re-paste). */
export async function savedKeyFor(ws: Workspace, providerId: string): Promise<string | null> {
  const row = await db.get<{ config_enc: string }>("SELECT config_enc FROM connections WHERE workspace_id=? AND kind='ai'", ws.id);
  const enc = row ? JSON.parse(row.config_enc || "{}").saved?.[providerId] : null;
  if (enc) return decrypt(enc);
  if (providerId === "anthropic") return decrypt(ws.anthropic_key_enc);
  return null;
}

export const hasImages = (r: Pick<ChatRequest, "messages">) =>
  r.messages.some((m) => typeof m.content !== "string" && m.content.some((b) => b.type === "image"));

/** One AI call for a business. Throws AIError with a message that can be shown to the owner. */
export async function aiChat(ws: Workspace, r: Omit<ChatRequest, "key" | "model"> & { model?: string }): Promise<ChatResult & { provider: string; model: string }> {
  const c = await aiConnection(ws);
  if (!c) throw new AIError("key", "Connect an AI first (Setup → AI).");
  const model = r.model || c.model;
  if (!c.provider.vision && hasImages(r)) throw new AIError("model", `${c.provider.name} can't read photos.`);
  const res = await ADAPTERS[c.provider.adapter].chat({ ...r, key: c.key, model, cacheKey: r.cacheKey ?? `ws${ws.id}` }, c.provider);
  recordUsage(ws.id, c.provider.id, model, res.usage).catch(() => undefined);
  return { ...res, provider: c.provider.id, model };
}

/** Same call with an explicit provider/key (used by the "Test and save" button before anything is saved). */
export function chatWith(p: ProviderSpec, key: string, r: Omit<ChatRequest, "key">) {
  return ADAPTERS[p.adapter].chat({ ...r, key }, p);
}

export function listModels(p: ProviderSpec, key: string): Promise<ModelInfo[]> {
  return ADAPTERS[p.adapter].listModels(key, p);
}

async function recordUsage(wsId: number, provider: string, model: string, u: ChatResult["usage"]) {
  await db.run(
    `INSERT INTO ai_usage (workspace_id, day, provider, model, requests, input_tokens, output_tokens, cached_tokens) VALUES (?,?,?,?,1,?,?,?)
     ON CONFLICT(workspace_id, day, provider, model) DO UPDATE SET requests=requests+1, input_tokens=input_tokens+excluded.input_tokens,
       output_tokens=output_tokens+excluded.output_tokens, cached_tokens=cached_tokens+excluded.cached_tokens`,
    wsId, new Date().toISOString().slice(0, 10), provider, model, u.input, u.output, u.cached
  );
}

export async function usageThisMonth(wsId: number) {
  const r = await db.get<{ req: number; inp: number; out: number }>(
    "SELECT COALESCE(SUM(requests),0) AS req, COALESCE(SUM(input_tokens),0) AS inp, COALESCE(SUM(output_tokens),0) AS out FROM ai_usage WHERE workspace_id=? AND day >= ?",
    wsId, new Date().toISOString().slice(0, 8) + "01"
  );
  return { requests: Number(r?.req ?? 0), input: Number(r?.inp ?? 0), output: Number(r?.out ?? 0) };
}

// ------------------------------------------------------------------ "Test and save"

const TEST_TOOLS: ToolDef[] = [
  { name: "check_availability", description: "Free start times on a date.", input_schema: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD" } }, required: ["date"] } },
  {
    name: "book_appointment", description: "Book a time that check_availability returned.",
    input_schema: { type: "object", properties: { start: { type: "string", description: "YYYY-MM-DDTHH:mm" }, customer_name: { type: "string", description: "Name" }, service: { type: "string", description: "Service" } }, required: ["start", "customer_name"] },
  },
];

/**
 * Proves a provider + key + version can run our booking flow: key check, then a short practice booking
 * (check a slot → book it → reply) against practice tools. Nothing touches the real calendar.
 */
export async function testAI(p: ProviderSpec, key: string, model: string): Promise<{ note: string | null }> {
  const note = p.keyInfo ? await p.keyInfo(key) : null;
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const system = { stable: "You are a test booking assistant. Use the tools to book. Never ask questions; pick the first free time. Reply in one short sentence when done." };
  const messages: any[] = [{ role: "user", content: `Book a haircut for Test Customer on ${tomorrow}, first free time.` }];
  const used: string[] = [];
  for (let step = 0; step < 5; step++) {
    const r = await chatWith(p, key, { model, system, messages, tools: TEST_TOOLS, maxTokens: 400 });
    messages.push({ role: "assistant", content: r.content });
    const calls = r.content.filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use");
    if (!calls.length) break;
    messages.push({
      role: "user",
      content: calls.map((c) => {
        used.push(c.name);
        const out = c.name === "check_availability" ? { date: c.input?.date ?? tomorrow, slots: ["10:00", "10:30", "11:00"] } : { ok: true, ref: "BK-TEST", start: c.input?.start };
        return { type: "tool_result", tool_use_id: c.id, content: JSON.stringify(out) };
      }),
    });
  }
  if (!used.includes("check_availability") || !used.includes("book_appointment"))
    throw new AIError("model", `${p.name} answered, but this version didn't use the booking tools in our test. Pick a recommended version.`);
  return { note };
}
