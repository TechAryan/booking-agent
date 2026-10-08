// OpenAI through the Responses API (its newer models do tools best here). Stateless: store=false, and within
// one turn we send back OpenAI's own output items (including encrypted reasoning) exactly as received.
import { callJson, parseArgs } from "./http.js";
import { baseOf } from "./openai-compat.js";
import { Adapter, Block, ChatRequest, ChatResult, Msg, ProviderSpec } from "./types.js";

function toInput(messages: Msg[]) {
  const out: any[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") { out.push({ role: m.role, content: m.content }); continue; }
    if (m.role === "user") {
      const parts: any[] = [];
      for (const b of m.content) {
        if (b.type === "tool_result") out.push({ type: "function_call_output", call_id: b.tool_use_id, output: (b.is_error ? "Error: " : "") + b.content });
        else if (b.type === "text") parts.push({ type: "input_text", text: b.text });
        else if (b.type === "image") parts.push({ type: "input_image", image_url: `data:${b.source.media_type};base64,${b.source.data}` });
      }
      if (parts.length) out.push({ role: "user", content: parts });
      continue;
    }
    const raw = m.content.find((b) => b.type === "provider_state" && (b as any).provider === "openai") as any;
    if (raw?.items) { out.push(...raw.items); continue; } // same turn: OpenAI's items, untouched
    for (const b of m.content) {
      if (b.type === "text") out.push({ role: "assistant", content: b.text });
      else if (b.type === "tool_use") out.push({ type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
    }
  }
  return out;
}

const noReasoning = new Set<string>(); // models that refused the reasoning setting

export const openaiResponsesAdapter: Adapter = {
  async chat(r: ChatRequest, p: ProviderSpec): Promise<ChatResult> {
    const body: any = {
      model: r.model,
      instructions: r.system.dynamic ? `${r.system.stable}\n\n${r.system.dynamic}` : r.system.stable,
      input: toInput(r.messages),
      max_output_tokens: Math.max(r.maxTokens, 1024) * 2, // reasoning tokens count against this
      store: false,
      ...(r.cacheKey ? { prompt_cache_key: r.cacheKey } : {}),
    };
    if (r.tools?.length) {
      body.tools = r.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.input_schema, strict: false }));
      if (r.forceTool) body.tool_choice = { type: "function", name: r.forceTool };
    }
    const headers = { Authorization: `Bearer ${r.key}` };
    let j: any;
    if (!noReasoning.has(r.model)) {
      try {
        j = await callJson(`${baseOf(p)}/responses`, { headers, body: { ...body, reasoning: { effort: "low" }, include: ["reasoning.encrypted_content"] } }, p.name, r.model);
      } catch (e: any) {
        if (e?.kind !== "bad_request" || !/reasoning/i.test(e.message)) throw e;
        noReasoning.add(r.model);
      }
    }
    j ??= await callJson(`${baseOf(p)}/responses`, { headers, body }, p.name, r.model);

    const items: any[] = Array.isArray(j?.output) ? j.output : [];
    const content: Block[] = [{ type: "provider_state", provider: "openai", items }];
    for (const it of items) {
      if (it.type === "message") for (const c of it.content ?? []) { if (c.type === "output_text" && c.text) content.push({ type: "text", text: c.text }); }
      else if (it.type === "function_call") content.push({ type: "tool_use", id: it.call_id, name: it.name, input: parseArgs(it.arguments) });
    }
    const u = j?.usage ?? {};
    return {
      content,
      toolCalls: content.some((b) => b.type === "tool_use"),
      usage: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cached: u.input_tokens_details?.cached_tokens ?? 0 },
    };
  },
  async listModels(key, p) {
    const j = await callJson(`${baseOf(p)}/models`, { headers: { Authorization: `Bearer ${key}` } }, p.name);
    return (Array.isArray(j?.data) ? j.data : [])
      .map((m: any) => String(m.id))
      .filter((id: string) => !p.modelFilter || p.modelFilter(id, null))
      .sort()
      .map((id: string) => ({ id, label: id }));
  },
};
