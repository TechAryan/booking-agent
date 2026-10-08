// Claude, through Anthropic's own API. Our stored format is Anthropic's, so this is a thin pass-through
// plus prompt caching on the long, stable part of the system prompt.
import Anthropic from "@anthropic-ai/sdk";
import { Adapter, AIError, Block, ChatRequest, ChatResult, Msg } from "./types.js";

const clients = new Map<string, Anthropic>();
export function anthropicClient(key: string) {
  let c = clients.get(key);
  if (!c) {
    if (clients.size > 500) clients.clear();
    c = new Anthropic({ apiKey: key, maxRetries: 2 });
    clients.set(key, c);
  }
  return c;
}

export function mapAnthropicError(e: any, model: string): AIError {
  if (e instanceof AIError) return e;
  const s = e?.status ?? 0, m = String(e?.message ?? "");
  if (s === 401 || s === 403) return new AIError("key", "This API key is not valid. Copy it again from the Claude Console.", s);
  if (s === 400 && /credit|billing/i.test(m)) return new AIError("credit", "The key works, but the account has no credit. Add credit under Billing in the Claude Console.", s);
  if (s === 404) return new AIError("model", `The version "${model}" is not available for this key. Pick another version.`, s);
  if (s === 429) return new AIError("rate", "Claude is busy (rate limit). Wait a minute and try again.", s);
  if (s >= 500 || !s) return new AIError("down", "Couldn't reach Claude just now. Try again shortly.", s);
  return new AIError("bad_request", m || "Claude rejected the request.", s);
}

/** Our blocks → Anthropic blocks (drops other providers' private state and our `meta`). */
function toWire(messages: Msg[]): Anthropic.MessageParam[] {
  return messages.map((m) => {
    if (typeof m.content === "string") return m as Anthropic.MessageParam;
    const content = m.content
      .filter((b) => b.type !== "provider_state")
      .map((b) => (b.type === "tool_use" ? { type: "tool_use", id: b.id, name: b.name, input: b.input ?? {} } : b));
    return { role: m.role, content } as Anthropic.MessageParam;
  });
}

export const anthropicAdapter: Adapter = {
  async chat(r: ChatRequest): Promise<ChatResult> {
    const system: Anthropic.TextBlockParam[] = [{ type: "text", text: r.system.stable, cache_control: { type: "ephemeral" } }];
    if (r.system.dynamic) system.push({ type: "text", text: r.system.dynamic });
    try {
      const res = await anthropicClient(r.key).messages.create({
        model: r.model, max_tokens: r.maxTokens, system, messages: toWire(r.messages),
        ...(r.tools?.length ? { tools: r.tools as Anthropic.Tool[] } : {}),
        ...(r.forceTool ? { tool_choice: { type: "tool", name: r.forceTool } } : {}),
      });
      return {
        content: res.content as unknown as Block[],
        toolCalls: res.stop_reason === "tool_use" || (!!r.forceTool && res.content.some((b) => b.type === "tool_use")),
        usage: { input: res.usage?.input_tokens ?? 0, output: res.usage?.output_tokens ?? 0, cached: res.usage?.cache_read_input_tokens ?? 0 },
      };
    } catch (e) {
      throw mapAnthropicError(e, r.model);
    }
  },
  async listModels(key) {
    try {
      const out: { id: string; label: string }[] = [];
      for await (const m of anthropicClient(key).models.list({ limit: 100 })) out.push({ id: m.id, label: m.display_name || m.id });
      return out;
    } catch (e) {
      throw mapAnthropicError(e, "");
    }
  },
};
