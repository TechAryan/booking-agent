// The OpenAI Chat Completions format, which Gemini, DeepSeek, Sarvam and OpenRouter all accept.
// Small per-provider differences live here, keyed by provider id.
import { callJson, parseArgs } from "./http.js";
import { Adapter, Block, ChatRequest, ChatResult, Msg, ProviderSpec } from "./types.js";

// Gemini 3 checks "thought signatures" on function calls. We send back the real one within a turn; for older
// history (or history from another AI) Google documents this placeholder that skips the check.
const GEMINI_SKIP_SIGNATURE = "skip_thought_signature_validator";

/** Base URL; AI_BASE_<ID> (e.g. AI_BASE_GEMINI) overrides it, which the tests use to point at fakes. */
export function baseOf(p: ProviderSpec) {
  return (process.env[`AI_BASE_${p.id.toUpperCase()}`] || p.baseUrl).replace(/\/+$/, "");
}

function toWire(messages: Msg[], p: ProviderSpec) {
  const out: any[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") { out.push({ role: m.role, content: m.content }); continue; }
    if (m.role === "user") {
      const parts: any[] = [];
      for (const b of m.content) {
        if (b.type === "tool_result") out.push({ role: "tool", tool_call_id: b.tool_use_id, content: (b.is_error ? "Error: " : "") + b.content });
        else if (b.type === "text") parts.push({ type: "text", text: b.text });
        else if (b.type === "image") parts.push({ type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
      }
      if (parts.length) out.push({ role: "user", content: parts.every((x) => x.type === "text") ? parts.map((x) => x.text).join("\n") : parts });
      continue;
    }
    const text = m.content.filter((b): b is Extract<Block, { type: "text" }> => b.type === "text").map((b) => b.text).join("\n");
    const calls = m.content.filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use");
    const msg: any = { role: "assistant", content: text || null };
    if (calls.length) {
      msg.tool_calls = calls.map((c, i) => {
        const tc: any = { id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } };
        if (p.id === "gemini") tc.extra_content = c.meta?.google ? { google: c.meta.google } : i === 0 ? { google: { thought_signature: GEMINI_SKIP_SIGNATURE } } : undefined;
        return tc;
      });
    }
    if (msg.content !== null || msg.tool_calls) out.push(msg);
  }
  return out;
}

/** Gemini's schema reader is stricter: no type lists like ["number","null"]. Keep the first real type. */
function simpleSchema(x: any): any {
  if (Array.isArray(x)) return x.map(simpleSchema);
  if (!x || typeof x !== "object") return x;
  const o: any = {};
  for (const [k, v] of Object.entries(x)) o[k] = k === "type" && Array.isArray(v) ? (v.find((t) => t !== "null") ?? "string") : simpleSchema(v);
  return o;
}

let seq = 0;
export const openaiCompatAdapter: Adapter = {
  async chat(r: ChatRequest, p: ProviderSpec): Promise<ChatResult> {
    const system = r.system.dynamic ? `${r.system.stable}\n\n${r.system.dynamic}` : r.system.stable;
    const body: any = {
      model: r.model,
      messages: [{ role: "system", content: system }, ...toWire(r.messages, p)],
      max_tokens: r.maxTokens,
      ...(p.extraBody ?? {}),
    };
    if (r.tools?.length) {
      body.tools = r.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: p.id === "gemini" ? simpleSchema(t.input_schema) : t.input_schema } }));
      // Only one tool is offered when forcing, so "required" means that tool, and every provider accepts it.
      if (r.forceTool) body.tool_choice = "required";
    }
    if (p.id === "openrouter") body.usage = { include: true };
    const j = await callJson(`${baseOf(p)}/chat/completions`, { headers: { Authorization: `Bearer ${r.key}`, ...(p.headers ?? {}) }, body }, p.name, r.model);
    const m = j?.choices?.[0]?.message ?? {};
    const content: Block[] = [];
    // Some models put a final answer in reasoning_content only when content is empty; we never show reasoning.
    if (typeof m.content === "string" && m.content.trim()) content.push({ type: "text", text: m.content });
    else if (Array.isArray(m.content)) for (const c of m.content) if (c?.type === "text" && c.text) content.push({ type: "text", text: c.text });
    for (const tc of m.tool_calls ?? []) {
      if (tc?.type && tc.type !== "function") continue;
      content.push({
        type: "tool_use", id: tc.id || `call_${Date.now().toString(36)}_${++seq}`, name: tc.function?.name ?? "", input: parseArgs(tc.function?.arguments),
        ...(tc.extra_content?.google ? { meta: { google: tc.extra_content.google } } : {}),
      });
    }
    const u = j?.usage ?? {};
    return {
      content,
      toolCalls: content.some((b) => b.type === "tool_use"),
      usage: { input: u.prompt_tokens ?? 0, output: u.completion_tokens ?? 0, cached: u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0 },
    };
  },
  async listModels(key, p) {
    const j = await callJson(`${baseOf(p)}/models${p.id === "openrouter" ? "?supported_parameters=tools" : ""}`, { headers: { Authorization: `Bearer ${key}`, ...(p.headers ?? {}) } }, p.name);
    const rows: any[] = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : [];
    return rows
      .map((m) => ({ raw: m, id: String(m.id ?? m.name ?? "").replace(/^models\//, "") }))
      .filter((m) => m.id && (!p.modelFilter || p.modelFilter(m.id, m.raw)))
      .map((m) => ({ id: m.id, label: m.raw.name && m.raw.name !== m.id ? `${m.raw.name}` : m.id }));
  },
};
