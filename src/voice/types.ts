// One interface for every calling-agent provider. Booking rules live in our tools, never in the provider's AI.
import type { Field, Values } from "../wa/types.js";
export type { Field, Values };

export interface RawHook { headers: Record<string, string>; body: string; url: string }

/** What a tool call tells us, before we decide whom to trust. */
export interface ToolCall {
  args: Record<string, unknown>;
  callKey?: string;          // our own id for the call (outbound), passed as a call variable
  providerCallId?: string;   // provider's id (execution / call / conversation)
  caller?: string;           // customer's number, only when the provider vouches for it (signed or system-filled)
}

export interface Report {
  providerCallId: string;
  callKey?: string;
  status: "in_progress" | "completed" | "no_answer" | "busy" | "failed" | "voicemail";
  final: boolean;            // last report for this call
  seconds?: number;
  summary?: string;
  transcript?: string;
  from?: string;
  to?: string;
  direction?: "in" | "out";
}

export interface ToolSpec { name: string; description: string; parameters: { type: "object"; properties: Record<string, any>; required?: string[] } }

export interface AgentSpec {
  name: string;
  prompt: string;            // system prompt (business facts + rules); {customer_name} etc. are call variables
  firstMessage: string;
  language: "hinglish" | "hi" | "en";
  voice: "female" | "male";
  tools: ToolSpec[];
  toolUrl: (tool: string) => string;   // our endpoint for one tool (secret in the path)
  webhookUrl: string;                  // post-call reports
  inbound: boolean;
  startHour: number; endHour: number;
}

export interface VoiceProvider {
  id: string;
  name: string;
  tag?: "Recommended" | "Beta";
  blurb: string;
  pricingUrl: string;
  note?: string;
  india: string;             // where calls are processed, in plain words
  fields: Field[];
  steps: string[];
  /** Manual setup (no agent API): text the owner pastes into the provider's dashboard. */
  manual?: boolean;
  check(v: Values): Promise<{ numbers: { id: string; number: string }[]; note?: string }>;
  /** Creates or updates the agent, tools, webhook and inbound binding. Returns values to keep (agent ids…). */
  provision(v: Values, spec: AgentSpec): Promise<Values>;
  call(v: Values, req: { to: string; vars: Record<string, string>; callKey: string }): Promise<{ providerCallId: string }>;
  /** Provider signature on webhooks/tool calls, on top of the secret in our address. */
  verify?(v: Values, raw: RawHook): boolean;
  parseTool(raw: RawHook): ToolCall;
  /** Look the caller up from the provider's own call record (when tool calls aren't signed). */
  lookupCall?(v: Values, providerCallId: string): Promise<{ caller?: string; direction?: "in" | "out"; callKey?: string } | null>;
  parseReport(raw: RawHook): Report | null;
}
