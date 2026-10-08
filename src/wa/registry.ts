// Which WhatsApp provider a business uses, its saved details, and the calls the rest of the app makes.
import { db, Workspace } from "../db.js";
import { env } from "../env.js";
import { decrypt, encrypt } from "../security.js";
import { d360, meta } from "./cloud.js";
import { gupshup } from "./gupshup.js";
import { exotel, gallabox, wati } from "./india.js";
import { kapso } from "./kapso.js";
import { twilio } from "./twilio.js";
import { Recipient, Values, WaProvider } from "./types.js";

/** Order on the page: Kapso first (recommended), Meta direct (cheapest), then the rest. */
export const WA_PROVIDERS: WaProvider[] = [kapso, meta, twilio, gupshup, d360, wati, gallabox, exotel];
export const waProvider = (id: string | null | undefined) => WA_PROVIDERS.find((p) => p.id === id);

export interface WaConn { provider: WaProvider; values: Values; display: string }

/** The business's active WhatsApp connection (Kapso details live in the older workspace columns). */
export async function waConnection(ws: Workspace): Promise<WaConn | null> {
  const id = ws.wa_provider || (ws.kapso_phone_number_id ? "kapso" : null);
  if (!id) return null;
  if (id === "kapso") {
    const key = decrypt(ws.kapso_key_enc);
    if (!key || !ws.kapso_phone_number_id) return null;
    return { provider: kapso, values: { api_key: key, phone_number_id: ws.kapso_phone_number_id }, display: ws.kapso_display_number || "" };
  }
  const p = waProvider(id);
  const values = await savedValues(ws, id);
  return p && values ? { provider: p, values, display: ws.wa_display || "" } : null;
}

/** Saved details for one provider (kept per provider, so switching back needs no re-paste). */
export async function savedValues(ws: Workspace, providerId: string): Promise<Values | null> {
  const row = await db.get<{ config_enc: string }>("SELECT config_enc FROM connections WHERE workspace_id=? AND kind=?", ws.id, `wa:${providerId}`);
  if (!row?.config_enc?.startsWith("v1:")) return null;
  try { return JSON.parse(decrypt(row.config_enc)!); } catch { return null; }
}

export async function saveValues(ws: Workspace, providerId: string, values: Values) {
  await db.run(
    `INSERT INTO connections (workspace_id, kind, provider, config_enc, status, checked_at) VALUES (?,?,?,?, 'ok', ?)
     ON CONFLICT(workspace_id, kind) DO UPDATE SET provider=excluded.provider, config_enc=excluded.config_enc, status='ok', checked_at=excluded.checked_at`,
    ws.id, `wa:${providerId}`, providerId, encrypt(JSON.stringify(values)), Date.now()
  );
}

/** Where a provider should send this business's messages. The secret in the path is checked before anything else. */
export function waHookUrl(ws: Pick<Workspace, "public_id">, providerId: string, secret: string) {
  return `${env.webhookBase || env.publicUrl}/webhooks/wa/${providerId}/${ws.public_id}/${secret}`;
}

/** Free-form message (allowed for 24 hours after the customer's last message). Throws on failure. */
export async function waSend(ws: Workspace, to: Recipient | string, text: string) {
  const c = await waConnection(ws);
  if (!c) throw new Error("WhatsApp isn't connected");
  const r: Recipient = typeof to === "string" ? (/^\d+$/.test(to) ? { phone: to } : { user: to }) : to;
  await c.provider.sendText(c.values, r, text);
}
