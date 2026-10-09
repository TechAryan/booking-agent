// Calling agent: provider registry, the business's connection, call planning (confirmation and reminder calls),
// placing calls, and handling tool calls and post-call reports.
import { DateTime } from "luxon";
import { db, logActivity, Workspace } from "../db.js";
import { env } from "../env.js";
import { decrypt, encrypt, randomToken } from "../security.js";
import { cancelJob, enqueue, onJob } from "../jobs.js";
import { getWorkspaceById, updateWorkspace } from "../models.js";
import { onInbox } from "../inbox.js";
import { Booking, notifyOwners, whenText } from "../bookings.js";
import { agentSpec, CallRow, callVars, newCallKey, noteCallOutcome, REMIND_MINUTES, runVoiceTool, ToolContext, voiceSettings, VoiceSettings } from "./agent.js";
import { bolna } from "./bolna.js";
import { elevenlabs } from "./elevenlabs.js";
import { retell } from "./retell.js";
import { sarvam } from "./sarvam.js";
import type { RawHook, Report, Values, VoiceProvider } from "./types.js";

export const VOICE_PROVIDERS: VoiceProvider[] = [bolna, elevenlabs, retell, sarvam];
export const voiceProvider = (id: string | null | undefined) => VOICE_PROVIDERS.find((p) => p.id === id);

// ------------------------------------------------------------------ connection

export async function voiceValues(ws: Workspace, providerId: string): Promise<Values | null> {
  const row = await db.get<{ config_enc: string }>("SELECT config_enc FROM connections WHERE workspace_id=? AND kind=?", ws.id, `voice:${providerId}`);
  if (!row?.config_enc?.startsWith("v1:")) return null;
  try { return JSON.parse(decrypt(row.config_enc)!); } catch { return null; }
}
export async function saveVoiceValues(ws: Workspace, providerId: string, v: Values) {
  await db.run(
    `INSERT INTO connections (workspace_id, kind, provider, config_enc, status, checked_at) VALUES (?,?,?,?, 'ok', ?)
     ON CONFLICT(workspace_id, kind) DO UPDATE SET provider=excluded.provider, config_enc=excluded.config_enc, status='ok', checked_at=excluded.checked_at`,
    ws.id, `voice:${providerId}`, providerId, encrypt(JSON.stringify(v)), Date.now());
}

export async function voiceConnection(ws: Workspace) {
  const p = voiceProvider(ws.voice_provider);
  if (!p) return null;
  const v = await voiceValues(ws, p.id);
  return v ? { provider: p, values: v } : null;
}

/** Our addresses for one business (edge in front when there is one). Secret in the path. */
export function voiceUrls(ws: Pick<Workspace, "public_id">, providerId: string, secret: string) {
  const b = env.webhookBase || env.publicUrl;
  return {
    // Tool calls happen live during a call: they go straight to the app.
    tool: (t: string) => `${env.publicUrl}/voice/tool/${providerId}/${ws.public_id}/${secret}/${t}`,
    webhook: `${b}/webhooks/voice/${providerId}/${ws.public_id}/${secret}`,
  };
}

export async function ensureVoiceSecret(ws: Workspace) {
  const have = decrypt(ws.voice_secret_enc);
  if (have) return have;
  const s = randomToken(24).replace(/[^A-Za-z0-9]/g, "").slice(0, 32);
  await updateWorkspace(ws.id, { voice_secret_enc: encrypt(s) });
  ws.voice_secret_enc = encrypt(s);
  return s;
}

/** (Re)creates the agent at the provider with the business's current details and switches. */
export async function provisionVoice(ws: Workspace, p: VoiceProvider, v: Values, s: VoiceSettings) {
  const secret = await ensureVoiceSecret(ws);
  const urls = voiceUrls(ws, p.id, secret);
  const spec = await agentSpec(ws, s, urls);
  return p.provision(v, spec);
}

// ------------------------------------------------------------------ planning

const minutesTo = (iso: string) => DateTime.fromISO(iso).diffNow("minutes").minutes;

/** Calling hours. Tests may widen them (VOICE_TEST_HOURS="0-24") so runs don't depend on the clock. */
function hours(s: VoiceSettings) {
  const o = process.env.NODE_ENV === "test" ? /^(\d+)-(\d+)$/.exec(process.env.VOICE_TEST_HOURS || "") : null;
  return o ? { start: Number(o[1]), end: Number(o[2]) } : { start: s.start, end: s.end };
}

/** Moves a time into calling hours: later in the day → today's window end is past, so push to the next window start. */
export function nextWindow(ws: Pick<Workspace, "timezone">, settings: VoiceSettings, at: DateTime): DateTime {
  const s = hours(settings);
  let t = at.setZone(ws.timezone || "Asia/Kolkata");
  if (t.hour < s.start) t = t.set({ hour: s.start, minute: 0, second: 0 });
  else if (t.hour >= s.end) t = t.plus({ days: 1 }).set({ hour: s.start, minute: 0, second: 0 });
  return t;
}
/** For reminders: the latest time inside calling hours not after `at`. */
export function prevWindow(ws: Pick<Workspace, "timezone">, settings: VoiceSettings, at: DateTime): DateTime {
  const s = hours(settings);
  let t = at.setZone(ws.timezone || "Asia/Kolkata");
  if (t.hour >= s.end) t = t.set({ hour: s.end - 1, minute: 45, second: 0 });
  else if (t.hour < s.start) t = t.minus({ days: 1 }).set({ hour: s.end - 1, minute: 45, second: 0 });
  return t;
}

onJob("voice_plan", async (job) => {
  const id = Number(job.ref.replace(/^bk:/, ""));
  const ws = await getWorkspaceById(job.workspace_id);
  const b = await db.get<Booking>("SELECT * FROM bookings WHERE id=? AND workspace_id=?", id, job.workspace_id);
  const cancelAll = async () => { for (const p of ["confirm", "remind"]) { await cancelJob("voice_call", `${p}:${id}`); await cancelJob("voice_call", `${p}:${id}:2`); } };
  if (!ws || !b) return cancelAll();
  const s = voiceSettings(ws);
  if (!s.enabled || !ws.voice_provider || b.status !== "confirmed" || !b.call_consent || !b.customer_phone) return cancelAll();
  const now = DateTime.now();
  const mins = minutesTo(b.start_at);
  // Confirmation call: soon after booking, only if the appointment is more than 3 hours away and not already done.
  const done = await db.get("SELECT 1 FROM calls WHERE booking_id=? AND purpose='confirm' AND status='completed'", id);
  if (s.confirm && !done && mins > 180) {
    const at = nextWindow(ws, s, now.plus({ milliseconds: Number(process.env.VOICE_CONFIRM_DELAY_MS ?? 120_000) }));
    if (minutesTo(at.toISO()!) < mins - 120) await enqueue(ws.id, "voice_call", `confirm:${id}`, at.toMillis());
    else await cancelJob("voice_call", `confirm:${id}`);
  } else await cancelJob("voice_call", `confirm:${id}`);
  // Reminder: a set time before the appointment, moved earlier into calling hours if needed.
  const off = REMIND_MINUTES[s.remind];
  if (off) {
    const at = prevWindow(ws, s, DateTime.fromISO(b.start_at).minus({ minutes: off }));
    if (at > now.plus({ minutes: 5 })) await enqueue(ws.id, "voice_call", `remind:${id}`, at.toMillis());
    else await cancelJob("voice_call", `remind:${id}`);
  } else await cancelJob("voice_call", `remind:${id}`);
});

onJob("voice_call", async (job) => {
  const [purpose, idStr, attemptStr] = job.ref.split(":");
  const id = Number(idStr), attempt = Number(attemptStr || 1);
  const ws = await getWorkspaceById(job.workspace_id);
  if (!ws) return;
  const s = voiceSettings(ws);
  const conn = await voiceConnection(ws);
  const b = await db.get<Booking>("SELECT * FROM bookings WHERE id=? AND workspace_id=?", id, ws.id);
  if (!s.enabled || !conn || !b || b.status !== "confirmed" || !b.call_consent || !b.customer_phone) return;
  if (minutesTo(b.start_at) < 10) return; // too late to be useful
  if (await db.get("SELECT 1 FROM do_not_call WHERE workspace_id=? AND customer_key=?", ws.id, b.customer_phone)) return;
  const local = DateTime.now().setZone(ws.timezone || "Asia/Kolkata");
  const h = hours(s);
  if (local.hour < h.start || local.hour >= h.end) return { again: Math.max(60_000, nextWindow(ws, s, local).toMillis() - Date.now()) };
  const today = Number((await db.get<{ c: number }>("SELECT COUNT(*) AS c FROM calls WHERE workspace_id=? AND direction='out' AND created_at >= ?", ws.id, local.startOf("day").toMillis()))?.c ?? 0);
  if (today >= s.dailyCap) {
    await logActivity(ws.id, "call", "phone", `Daily call limit (${s.dailyCap}) reached; skipped ${purpose} call for ${b.ref}`);
    return;
  }
  await placeCall(ws, conn.provider, conn.values, b, purpose === "remind" ? "reminder" : "confirm", attempt);
});

export async function placeCall(ws: Workspace, p: VoiceProvider, v: Values, b: Booking, purpose: string, attempt = 1) {
  const callKey = newCallKey();
  const r = await db.run(
    "INSERT INTO calls (workspace_id, booking_id, customer_key, direction, purpose, provider, status, call_key, attempt, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    ws.id, b.id || null, b.customer_phone, "out", purpose, p.id, "queued", callKey, attempt, Date.now(), Date.now());
  try {
    const { providerCallId } = await p.call(v, { to: b.customer_phone, vars: callVars(ws, b, purpose, callKey), callKey });
    await db.run("UPDATE calls SET provider_call_id=?, status='ringing', updated_at=? WHERE id=?", providerCallId, Date.now(), r.lastId);
    return { ok: true as const, callId: r.lastId, providerCallId };
  } catch (e: any) {
    await db.run("UPDATE calls SET status='failed', summary=?, updated_at=? WHERE id=?", String(e?.message || "").slice(0, 300), Date.now(), r.lastId);
    await logActivity(ws.id, "error", "phone", `Call to +${b.customer_phone} failed to start (${p.name}): ${e?.message}`);
    throw e;
  }
}

// ------------------------------------------------------------------ tool calls (live, during a call)

const callerCache = new Map<string, { at: number; v: { caller?: string; direction?: "in" | "out"; callKey?: string } | null }>();

export async function handleToolCall(ws: Workspace, providerId: string, tool: string, raw: RawHook): Promise<{ status: number; body: unknown }> {
  const conn = await voiceConnection(ws);
  if (!conn || conn.provider.id !== providerId) return { status: 404, body: { error: "Calling isn't connected." } };
  const { provider: p, values: v } = conn;
  if (p.verify && !p.verify(v, raw)) return { status: 401, body: { error: "Bad signature" } };
  const t = p.parseTool(raw);
  const ctx: ToolContext = { caller: null, direction: "in", call: null };
  if (t.callKey) {
    const row = await db.get<CallRow>("SELECT * FROM calls WHERE call_key=? AND workspace_id=?", t.callKey, ws.id);
    if (row) { ctx.call = row; ctx.caller = row.customer_key; ctx.direction = row.direction === "in" ? "in" : "out"; }
  }
  if (!ctx.caller && t.caller) { ctx.caller = t.caller; ctx.direction = "in"; }
  if (!ctx.caller && t.providerCallId && p.lookupCall) {
    // Unsigned tool calls: ask the provider who is on the line (cached for the call).
    let hit = callerCache.get(t.providerCallId);
    if (!hit || Date.now() - hit.at > 30 * 60_000) {
      hit = { at: Date.now(), v: await p.lookupCall(v, t.providerCallId).catch(() => null) };
      if (callerCache.size > 2000) callerCache.clear();
      callerCache.set(t.providerCallId, hit);
    }
    if (hit.v?.callKey) {
      const row = await db.get<CallRow>("SELECT * FROM calls WHERE call_key=? AND workspace_id=?", hit.v.callKey, ws.id);
      if (row) { ctx.call = row; ctx.caller = row.customer_key; ctx.direction = "out"; }
    }
    if (!ctx.caller && hit.v?.caller) { ctx.caller = hit.v.caller; ctx.direction = hit.v.direction ?? "in"; }
  }
  try {
    const out = await runVoiceTool(ws, voiceSettings(ws), ctx, tool, t.args as Record<string, any>);
    return { status: 200, body: out };
  } catch (e: any) {
    return { status: 200, body: { error: e?.message || "Something went wrong" } };
  }
}

// ------------------------------------------------------------------ post-call reports (saved first, then here)

onInbox("wh:voice", async (rows) => {
  for (const row of rows) {
    const ws = await getWorkspaceById(row.workspace_id);
    if (!ws) continue;
    const conn = await voiceConnection(ws);
    const { headers, body } = JSON.parse(row.body);
    if (!conn || conn.provider.id !== headers.provider) continue;
    const raw = { headers, body, url: headers.url };
    if (conn.provider.verify && !conn.provider.verify(conn.values, raw)) { console.warn(`[voice ${ws.public_id}] bad report signature`); continue; }
    const rep = conn.provider.parseReport(raw);
    if (rep) await handleReport(ws, conn.provider.id, rep);
  }
});

const OUTCOME_TEXT: Record<string, string> = { confirmed: "confirmed they'll come", rescheduled: "moved the booking", cancelled: "cancelled the booking" };

export async function handleReport(ws: Workspace, providerId: string, r: Report) {
  let row = r.callKey ? await db.get<CallRow>("SELECT * FROM calls WHERE call_key=? AND workspace_id=?", r.callKey, ws.id) : undefined;
  row ??= await db.get<CallRow>("SELECT * FROM calls WHERE provider_call_id=? AND workspace_id=?", r.providerCallId, ws.id);
  if (!row) {
    if (r.direction !== "in" || !r.from) return; // a report for a call we don't know: ignore
    const ins = await db.run("INSERT OR IGNORE INTO calls (workspace_id, customer_key, direction, purpose, provider, provider_call_id, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      ws.id, r.from, "in", "inbound", providerId, r.providerCallId, "ringing", Date.now(), Date.now());
    row = await db.get<CallRow>("SELECT * FROM calls WHERE id=?", ins.lastId);
    if (!row) return;
  }
  const wasFinal = ["completed", "no_answer", "busy", "failed", "voicemail"].includes(row.status);
  if (wasFinal && !r.summary) return; // duplicate delivery
  await db.run("UPDATE calls SET provider_call_id=COALESCE(provider_call_id, ?), status=?, seconds=COALESCE(?, seconds), summary=COALESCE(?, summary), transcript=COALESCE(?, transcript), updated_at=? WHERE id=?",
    r.providerCallId, r.final ? r.status : "in_progress", r.seconds ?? null, r.summary?.slice(0, 2000) ?? null, r.transcript?.slice(0, 20000) ?? null, Date.now(), row.id);
  if (!r.final || wasFinal) return;
  const b = row.booking_id ? await db.get<Booking>("SELECT * FROM bookings WHERE id=?", row.booking_id) : undefined;
  if (r.status === "completed") {
    const fresh = await db.get<CallRow>("SELECT * FROM calls WHERE id=?", row.id);
    const what = fresh?.outcome ? OUTCOME_TEXT[fresh.outcome] ?? fresh.outcome : "talked";
    await logActivity(ws.id, "call", "phone", `${row.direction === "in" ? "Call from" : `${row.purpose === "reminder" ? "Reminder" : "Confirmation"} call to`} +${row.customer_key}: ${what}${r.summary ? ` · ${r.summary.slice(0, 160)}` : ""}`);
    if (b) await noteCallOutcome(ws, b.customer_phone, `(Phone call ${DateTime.now().setZone(ws.timezone).toFormat("d LLL, h:mm a")}: the customer ${what}.${r.summary ? ` Summary: ${r.summary.slice(0, 300)}` : ""})`);
    return;
  }
  // Not reached: try once more 30 minutes later, if there's still time.
  if (b && row.direction === "out" && row.attempt < 2 && (row.purpose === "confirm" || row.purpose === "reminder") && minutesTo(b.start_at) > 45) {
    await enqueue(ws.id, "voice_call", `${row.purpose === "reminder" ? "remind" : "confirm"}:${b.id}:2`, Date.now() + Number(process.env.VOICE_RETRY_MS ?? 30 * 60_000));
  } else if (b && row.direction === "out" && row.purpose !== "test") {
    await logActivity(ws.id, "call", "phone", `Couldn't reach ${b.customer_name} (+${b.customer_phone}) for ${b.ref} (${r.status.replace("_", " ")})`);
    if (row.purpose === "confirm") await notifyOwners(ws, `📞 Couldn't reach ${b.customer_name} to confirm ${b.ref} (${whenText(ws, b.start_at)}). You may want to message them.`);
  }
}
