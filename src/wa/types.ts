// One small interface for every WhatsApp provider. The booking brain never knows which one it talks to.

/** A customer message, the same shape for every provider. */
export interface Inbound {
  id: string;            // provider's message id (dedupe key)
  phone?: string;        // digits with country code, no "+"; may be missing for WhatsApp usernames (Meta BSUID)
  user?: string;         // Meta business-scoped user id, when present
  name?: string;
  text?: string;
  image?: { ref: string; mime: string; caption: string };
  other?: boolean;       // voice note, sticker, location …: we ask them to type instead
}

/** Where a reply goes: a phone number, or (Meta, when there's no phone) the business-scoped user id. */
export interface Recipient { phone?: string; user?: string }

export interface Field {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;      // stored encrypted, never shown again, "leave empty to keep"
  hint?: string;
  optional?: boolean;
  pattern?: RegExp;      // simple format check before we call the provider
  patternMsg?: string;
}

export type Values = Record<string, string>;

export interface RawWebhook { headers: Record<string, string>; body: string; url: string }

export interface WaProvider {
  id: string;
  name: string;
  tag?: "Recommended" | "Cheapest" | "Beta";
  blurb: string;
  pricingUrl: string;
  note?: string;
  fields: Field[];
  steps: string[];                      // guide; **bold**, `code`, [link](https://…)
  /** Shown when we can't set the webhook ourselves; {url} and {secret} are filled in. */
  manualWebhook?: string[];
  /** Twilio wants TwiML back; others take plain 200. */
  ackBody?: { type: string; body: string };
  check(v: Values): Promise<{ display: string }>;
  connectWebhook?(v: Values, url: string, secret: string): Promise<void>;
  disconnectWebhook?(v: Values, url: string): Promise<void>;
  /** Provider signature check on top of the secret in the URL (Meta, Twilio, Gallabox). */
  verify?(v: Values, raw: RawWebhook, secret: string): boolean;
  parse(raw: RawWebhook): Inbound[];
  sendText(v: Values, to: Recipient, text: string): Promise<void>;
  media(v: Values, ref: string): Promise<{ bytes: Buffer; mime: string }>;
  markRead?(v: Values, messageId: string): Promise<void>;
}

export class WaError extends Error {}
