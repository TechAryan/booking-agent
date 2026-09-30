import { WhatsAppClient } from "@kapso/whatsapp-cloud-api";
import { env } from "./env.js";

async function platform(apiKey: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${env.kapsoApiBase}/platform/v1${path}`, {
    ...init,
    headers: { "X-API-Key": apiKey, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const text = await res.text();
  let body: any = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error("Kapso rejected this API key. Create a new one in Kapso → API keys.");
    throw new Error(`Kapso error ${res.status}: ${body?.error || body?.message || text.slice(0, 200)}`);
  }
  return body;
}

/** Confirms the key works and the phone number belongs to it. Returns the display number. */
export async function verifyKapso(apiKey: string, phoneNumberId: string): Promise<{ display: string }> {
  try {
    const body = await platform(apiKey, `/whatsapp/phone_numbers/${encodeURIComponent(phoneNumberId)}`);
    const d = body?.data ?? {};
    return { display: d.display_phone_number || d.display_name || d.name || "" };
  } catch (e: any) {
    if (/ 404/.test(e.message)) throw new Error("That Phone number ID isn't in this Kapso project. Copy it from Kapso → Phone numbers.");
    throw e;
  }
}

/** Creates (or replaces) our webhook on the number. */
export async function createWebhook(apiKey: string, phoneNumberId: string, url: string, secret: string, oldId?: string | null) {
  if (oldId) await deleteWebhook(apiKey, phoneNumberId, oldId).catch(() => undefined);
  const body = await platform(apiKey, `/whatsapp/phone_numbers/${encodeURIComponent(phoneNumberId)}/webhooks`, {
    method: "POST",
    body: JSON.stringify({
      whatsapp_webhook: {
        url,
        secret_key: secret,
        kind: "kapso",
        events: ["whatsapp.message.received"],
        payload_version: "v2",
        active: true,
        buffer_enabled: true,
        buffer_window_seconds: 3,
        max_buffer_size: 10,
      },
    }),
  });
  return { id: String(body?.data?.id ?? "") };
}

export async function deleteWebhook(apiKey: string, phoneNumberId: string, webhookId: string) {
  await platform(apiKey, `/whatsapp/phone_numbers/${encodeURIComponent(phoneNumberId)}/webhooks/${encodeURIComponent(webhookId)}`, {
    method: "DELETE",
  });
}

const clients = new Map<string, WhatsAppClient>();
function wa(apiKey: string) {
  let c = clients.get(apiKey);
  if (!c) {
    c = new WhatsAppClient({ baseUrl: `${env.kapsoApiBase}/meta/whatsapp`, kapsoApiKey: apiKey });
    clients.set(apiKey, c);
  }
  return c;
}

export async function sendText(apiKey: string, phoneNumberId: string, to: string, body: string) {
  await wa(apiKey).messages.sendText({ phoneNumberId, to, body });
}

export function markRead(apiKey: string, phoneNumberId: string, messageId: string) {
  return wa(apiKey)
    .messages.markRead({ phoneNumberId, messageId, typingIndicator: { type: "text" } })
    .catch((e: any) => console.warn("markRead failed:", e?.message));
}
