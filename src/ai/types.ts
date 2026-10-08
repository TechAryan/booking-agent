// One small interface for every AI provider. The booking brain only speaks this.
// Conversations are stored in our own format (the same block shapes we have always saved), so a business can
// switch AI without losing chats: each adapter converts to and from its provider's wire format.

export type TextBlock = { type: "text"; text: string };
export type ImageBlock = { type: "image"; source: { type: "base64"; media_type: string; data: string } };
/** `meta` carries provider data that must go back unchanged inside the same turn (e.g. Gemini thought signatures). */
export type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: any; meta?: any };
export type ToolResultBlock = { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
/** Provider-private state for the current turn only (Anthropic thinking, OpenAI reasoning). Dropped between turns. */
export type StateBlock = { type: "thinking" | "redacted_thinking" | "provider_state"; [k: string]: any };
export type Block = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock | StateBlock;
export type Msg = { role: "user" | "assistant"; content: string | Block[] };

export interface ToolDef { name: string; description: string; input_schema: { type: "object"; properties: Record<string, any>; required?: string[] } }

export interface ChatRequest {
  key: string;
  model: string;
  /** `stable` is the long prompt (cached where the provider supports it); `dynamic` is small and changes every turn. */
  system: { stable: string; dynamic?: string };
  messages: Msg[];
  tools?: ToolDef[];
  /** Force this one tool (structured extraction). */
  forceTool?: string;
  maxTokens: number;
  /** Groups requests that share a prompt prefix, for providers with keyed caching. */
  cacheKey?: string;
}
export interface ChatResult {
  content: Block[]; // text, tool_use, and state blocks to keep for this turn
  toolCalls: boolean;
  usage: { input: number; output: number; cached: number };
}

export type AIErrorKind = "key" | "credit" | "model" | "rate" | "down" | "bad_request";
export class AIError extends Error {
  constructor(public kind: AIErrorKind, message: string, public status = 0) { super(message); }
}

export interface ModelInfo { id: string; label: string }

export interface Adapter {
  chat(req: ChatRequest, p: ProviderSpec): Promise<ChatResult>;
  /** Live list of models this key can use (best effort; empty when the provider has no list). */
  listModels(key: string, p: ProviderSpec): Promise<ModelInfo[]>;
}

export interface ProviderSpec {
  id: string;
  name: string;
  adapter: "anthropic" | "openai-responses" | "openai-compat";
  baseUrl: string;
  /** Curated versions, best first. tag: shown as a chip. */
  versions: { id: string; label: string; tag?: "Recommended" | "Cheaper" | "Smartest" }[];
  vision: boolean;
  keyPrefix?: string;
  keyPlaceholder: string;
  consoleUrl: string;
  pricingUrl: string;
  note?: string;
  steps: string[]; // HTML-safe guide steps; links as [text](url)
  /** Extra JSON merged into every chat request (thinking off etc.). */
  extraBody?: Record<string, unknown>;
  /** Model ids from the live list we offer (e.g. OpenRouter: only tool-capable chat models). */
  modelFilter?: (id: string, raw: any) => boolean;
  /** Extra key check beyond a chat call (balance, key info). Returns a short note or throws AIError. */
  keyInfo?: (key: string) => Promise<string | null>;
  headers?: Record<string, string>;
}
