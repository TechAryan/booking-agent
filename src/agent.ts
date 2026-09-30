import Anthropic from "@anthropic-ai/sdk";
import { db, logActivity, Workspace } from "./db.js";
import { env } from "./env.js";
import { decrypt } from "./security.js";
import { hoursOf, normPhone, WorkspaceCalendar } from "./calendar.js";

export type Channel = "whatsapp" | "widget" | "test";

const clients = new Map<string, Anthropic>();
export function anthropicFor(apiKey: string): Anthropic {
  let c = clients.get(apiKey);
  if (!c) {
    c = new Anthropic({ apiKey });
    clients.set(apiKey, c);
  }
  return c;
}

/** Cheap real call to confirm a key works and has credit. */
export async function testAnthropicKey(apiKey: string, model: string): Promise<void> {
  try {
    await anthropicFor(apiKey).messages.create({ model, max_tokens: 5, messages: [{ role: "user", content: "Say ok" }] });
  } catch (e: any) {
    const status = e?.status;
    if (status === 401) throw new Error("This API key is not valid. Copy it again from the Anthropic Console.");
    if (status === 400 && /credit|billing/i.test(e?.message)) throw new Error("The key works, but the account has no credit. Add credit under Billing in the Anthropic Console.");
    if (status === 404) throw new Error(`The model "${model}" is not available for this key. Pick another model.`);
    if (status === 429) throw new Error("Rate limited by Anthropic. Wait a minute and try again.");
    throw new Error(e?.message || "Could not reach Anthropic.");
  }
}

// ---------- Tools ----------

function tools(ws: Workspace, channel: Channel): Anthropic.Tool[] {
  const needsPhone = channel !== "whatsapp";
  const phoneProp = { customer_phone: { type: "string", description: "Customer's phone number with country code" } };
  return [
    {
      name: "check_availability",
      description: "Get free appointment start times (HH:mm local) for one date. Call before offering or booking any time.",
      input_schema: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD" } }, required: ["date"] },
    },
    {
      name: "book_appointment",
      description: "Book a slot. Only after the customer confirmed date, time, service and name" + (needsPhone ? " and gave their phone number." : "."),
      input_schema: {
        type: "object",
        properties: {
          start: { type: "string", description: "Local start, YYYY-MM-DDTHH:mm" },
          customer_name: { type: "string" },
          service: { type: "string", description: `One of: ${ws.services}` },
          ...(needsPhone ? phoneProp : {}),
        },
        required: ["start", "customer_name", "service", ...(needsPhone ? ["customer_phone"] : [])],
      },
    },
    {
      name: "list_my_appointments",
      description: needsPhone
        ? "List upcoming appointments booked in this chat. Bookings made elsewhere can't be seen here; for those, the customer should contact the business."
        : "List the customer's upcoming appointments.",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "cancel_appointment",
      description: "Cancel one of the appointments returned by list_my_appointments. Confirm with the customer first.",
      input_schema: { type: "object", properties: { booking_id: { type: "string" } }, required: ["booking_id"] },
    },
  ];
}

function systemPrompt(ws: Workspace, channel: Channel, cal: WorkspaceCalendar, contactName?: string) {
  const h = hoursOf(ws);
  const days = h.workingDays.map((d) => ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][d]).join(", ");
  const where = channel === "whatsapp" ? "WhatsApp" : "the website chat";
  return `You are the booking assistant for ${ws.business_name} on ${where}. You help customers book, check and cancel appointments.

Facts:
- Now: ${cal.now().toFormat("cccc, d LLLL yyyy, HH:mm")} (${h.timezone}). Resolve "tomorrow", "Friday" etc. against this.
- Open ${days}, ${h.openHour}:00–${h.closeHour}:00. Appointments are ${h.slotMinutes} minutes.
- Services: ${ws.services}.
${ws.extra_info ? `- Business notes from the owner (follow them):\n${ws.extra_info}\n` : ""}${contactName ? `- The customer's WhatsApp name is "${contactName}" (confirm before using it).\n` : ""}
Rules:
- Keep replies short (1–3 sentences), friendly, plain text. No headings or tables.
- Always call check_availability before suggesting times. Offer at most 3–4 options, in 12-hour format like "4:30 pm".
- Before book_appointment, have service, date, time, name${channel === "whatsapp" ? "" : " and phone number"}, and a clear yes.
- After booking, confirm the details in one line.
- Never invent availability, prices or medical advice. For anything you can't handle, say the team will follow up.
- Reply in the customer's language (English, Hindi or Hinglish are fine).`;
}

async function runTool(cal: WorkspaceCalendar, ws: Workspace, channel: Channel, owner: string, name: string, input: any, trustedPhone?: string) {
  // On WhatsApp the phone comes from WhatsApp itself, never from the model.
  const phone = trustedPhone ?? normPhone(input.customer_phone || "");
  if (name === "book_appointment" && !phone) throw new Error("Ask the customer for their phone number first.");
  switch (name) {
    case "check_availability":
      return cal.availableSlots(input.date);
    case "book_appointment": {
      const r = await cal.book({ start: input.start, customerName: input.customer_name, service: input.service, phone, channel, owner });
      if (r.ok) await logActivity(ws.id, "booking", channel, `${input.customer_name} · ${input.service} · ${r.when} · ${phone}`);
      return r;
    }
    case "list_my_appointments":
      return cal.listForOwner(owner);
    case "cancel_appointment": {
      const r = await cal.cancel(owner, input.booking_id);
      if (r.ok) await logActivity(ws.id, "cancel", channel, `Booking ${input.booking_id}`);
      return r;
    }
  }
  throw new Error(`Unknown tool ${name}`);
}

// ---------- Conversation store ----------

const MAX_MESSAGES = 30;

async function loadHistory(wsId: number, channel: Channel, ext: string): Promise<Anthropic.MessageParam[]> {
  const row = await db.get("SELECT history FROM conversations WHERE workspace_id=? AND channel=? AND external_id=?", wsId, channel, ext) as any;
  return row ? stripThinking(JSON.parse(row.history)) : [];
}

// Thinking blocks are signed against the exact system prompt they were made with. Our prompt contains the
// current time, so blocks from earlier turns become invalid. Keep them only inside the turn that made them.
function stripThinking(history: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  return history
    .map((m) => {
      if (m.role !== "assistant" || typeof m.content === "string") return m;
      const content = m.content.filter((b: any) => b.type !== "thinking" && b.type !== "redacted_thinking");
      return { ...m, content };
    })
    .filter((m) => typeof m.content === "string" || m.content.length > 0);
}

async function saveHistory(wsId: number, channel: Channel, ext: string, history: Anthropic.MessageParam[]) {
  let h = stripThinking(history).slice(-MAX_MESSAGES);
  while (h.length && !(h[0].role === "user" && typeof h[0].content === "string")) h = h.slice(1);
  await db.run(
    `INSERT INTO conversations (workspace_id, channel, external_id, history, updated_at) VALUES (?,?,?,?,datetime('now'))
     ON CONFLICT(workspace_id, channel, external_id) DO UPDATE SET history=excluded.history, updated_at=excluded.updated_at`,
    wsId, channel, ext, JSON.stringify(h)
  );
}

export async function resetConversation(wsId: number, channel: Channel, ext: string) {
  await db.run("DELETE FROM conversations WHERE workspace_id=? AND channel=? AND external_id=?", wsId, channel, ext);
}

// ---------- Main entry ----------

export async function reply(
  ws: Workspace,
  channel: Channel,
  externalId: string,
  text: string,
  opts: { trustedPhone?: string; contactName?: string } = {}
): Promise<string> {
  const apiKey = decrypt(ws.anthropic_key_enc);
  if (!apiKey) throw new Error("Claude is not set up for this business.");
  const cal = new WorkspaceCalendar(ws);
  const client = anthropicFor(apiKey);
  const model = ws.claude_model || env.defaultModel;

  // Who owns bookings made here: the verified WhatsApp number, or this exact chat session.
  const owner = channel === "whatsapp" ? `wa:${normPhone(opts.trustedPhone || externalId)}` : `${channel}:${externalId}`;
  const history = await loadHistory(ws.id, channel, externalId);
  const system = systemPrompt(ws, channel, cal, opts.contactName);
  history.push({ role: "user", content: text.slice(0, 2000) });

  for (let step = 0; step < 8; step++) {
    const res = await client.messages.create({
      model,
      max_tokens: 1024,
      system,
      tools: tools(ws, channel),
      messages: history,
    });
    history.push({ role: "assistant", content: res.content });

    if (res.stop_reason !== "tool_use") {
      const out = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
      await saveHistory(ws.id, channel, externalId, history);
      return out || "Sorry, could you say that again?";
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of res.content) {
      if (block.type !== "tool_use") continue;
      try {
        const out = await runTool(cal, ws, channel, owner, block.name, block.input, opts.trustedPhone);
        results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(out) });
      } catch (e: any) {
        results.push({ type: "tool_result", tool_use_id: block.id, content: `Error: ${e.message}`, is_error: true });
      }
    }
    history.push({ role: "user", content: results });
  }
  await saveHistory(ws.id, channel, externalId, history);
  return "Sorry, I got stuck on that one. The team will get back to you shortly.";
}
