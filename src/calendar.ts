import { google, calendar_v3 } from "googleapis";
import { DateTime } from "luxon";
import { db, Workspace } from "./db.js";
import { env } from "./env.js";
import { decrypt, randomToken } from "./security.js";
import { holidayOn } from "./catalog.js";
import { fakeCalendarClient, fakeOAuth } from "./testing/fakeGoogle.js";

export interface BusinessHours {
  timezone: string;
  openHour: number;
  closeHour: number;
  workingDays: number[]; // 1=Mon..7=Sun
  slotMinutes: number;
}

export function hoursOf(ws: Workspace): BusinessHours {
  return {
    timezone: ws.timezone,
    openHour: ws.open_hour,
    closeHour: ws.close_hour,
    workingDays: ws.working_days.split(",").map(Number).filter(Boolean),
    slotMinutes: ws.slot_minutes,
  };
}

const FAKE = () => process.env.FAKE_GOOGLE_CALENDAR === "1";

// ============================================================ Sign in with Google (OAuth)

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events",            // create events + invites + Meet links
  "https://www.googleapis.com/auth/calendar.freebusy",          // see busy times
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly", // let them pick which calendar
];

export function googleSignInEnabled() {
  return FAKE() || !!(env.googleClientId && env.googleClientSecret);
}

function oauthClient() {
  return new google.auth.OAuth2(env.googleClientId, env.googleClientSecret, `${env.publicUrl}/setup/google/callback`);
}

export function googleAuthUrl(state: string, loginHint?: string): string {
  if (FAKE()) return fakeOAuth.authUrl(state);
  return oauthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // always returns a refresh token
    scope: GOOGLE_SCOPES,
    state,
    include_granted_scopes: true,
    login_hint: loginHint || undefined,
  });
}

/** Swaps the one-time code for a long-lived refresh token + the Google account's email. */
export async function googleExchange(code: string): Promise<{ refreshToken: string; email: string; scopes: string }> {
  if (FAKE()) return fakeOAuth.exchange(code);
  const { tokens } = await oauthClient().getToken(code);
  if (!tokens.refresh_token) throw new Error("Google didn't give us offline access. Please try again and allow all the permissions.");
  let email = "";
  if (tokens.id_token) {
    try {
      email = JSON.parse(Buffer.from(tokens.id_token.split(".")[1]!, "base64url").toString("utf8")).email || "";
    } catch {}
  }
  return { refreshToken: tokens.refresh_token, email, scopes: tokens.scope || "" };
}

export async function googleRevoke(refreshToken: string) {
  if (FAKE()) return;
  await oauthClient().revokeToken(refreshToken).catch(() => undefined);
}

// ============================================================ Clients

const cache = new Map<string, calendar_v3.Calendar>();

function serviceAccountClient(serviceAccountJson: string): calendar_v3.Calendar {
  const hit = cache.get(serviceAccountJson);
  if (hit) return hit;
  const credentials = JSON.parse(serviceAccountJson);
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/calendar"] });
  const cal = google.calendar({ version: "v3", auth });
  cache.set(serviceAccountJson, cal);
  return cal;
}

function oauthCalendar(refreshToken: string): calendar_v3.Calendar {
  const key = `oauth:${refreshToken}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const auth = oauthClient();
  auth.setCredentials({ refresh_token: refreshToken });
  const cal = google.calendar({ version: "v3", auth });
  cache.set(key, cal);
  return cal;
}

/** The calendar API for a workspace: Google sign-in if connected, else the old key file. */
export function calendarApi(ws: Workspace): calendar_v3.Calendar | null {
  if (FAKE() && (ws.google_refresh_enc || ws.google_sa_enc)) return fakeCalendarClient();
  const refresh = decrypt(ws.google_refresh_enc);
  if (refresh) return oauthCalendar(refresh);
  const sa = decrypt(ws.google_sa_enc);
  if (sa) return serviceAccountClient(sa);
  return null;
}

/** Only a signed-in Google account (not a service-account key) can email invites and create Meet links. */
export function canInvite(ws: Workspace) {
  return !!ws.google_refresh_enc;
}

/** Kept for tests of the key-file path. */
export function googleClient(serviceAccountJson: string): calendar_v3.Calendar {
  if (FAKE()) return fakeCalendarClient();
  return serviceAccountClient(serviceAccountJson);
}

/** Validates a service-account JSON file, returns its email. */
export function parseServiceAccount(text: string): { email: string; json: string } {
  let obj: any;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error("That file is not valid JSON. Upload the key file you downloaded from Google Cloud.");
  }
  if (obj.type !== "service_account" || !obj.client_email || !obj.private_key) {
    throw new Error("This is not a service account key. In Google Cloud, open the service account → Keys → Add key → JSON.");
  }
  return { email: obj.client_email, json: JSON.stringify(obj) };
}

/** Calendars the signed-in account can add events to. */
export async function listWritableCalendars(ws: Workspace): Promise<{ id: string; name: string; primary: boolean }[]> {
  const cal = calendarApi(ws);
  if (!cal) return [];
  const res = await cal.calendarList.list({ minAccessRole: "writer", maxResults: 100 });
  return (res.data.items ?? []).map((c) => ({ id: c.id!, name: c.summaryOverride || c.summary || c.id!, primary: !!c.primary }))
    .sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name));
}

/** Checks the calendar is reachable and writable. Returns the calendar's name. */
export async function testCalendarFor(ws: Workspace, calendarId: string): Promise<string> {
  const cal = calendarApi(ws);
  if (!cal) throw new Error("Connect Google first.");
  const viaKey = !ws.google_refresh_enc;
  try {
    let name = calendarId;
    if (viaKey) {
      const res = await cal.calendarList.insert({ requestBody: { id: calendarId } }).catch(() => null);
      const access = res?.data.accessRole;
      if (access && !["writer", "owner"].includes(access)) throw new Error(`The calendar is shared as "${access}". Change it to "Make changes to events".`);
      name = (await cal.calendars.get({ calendarId })).data.summary || calendarId;
    } else {
      const list = await listWritableCalendars(ws);
      const hit = list.find((c) => c.id === calendarId);
      if (!hit) throw new Error("You can't add events to that calendar. Pick another one.");
      name = hit.name;
    }
    const fb = await cal.freebusy.query({
      requestBody: { timeMin: new Date().toISOString(), timeMax: new Date(Date.now() + 86400_000).toISOString(), items: [{ id: calendarId }] },
    });
    const errs = fb.data.calendars?.[calendarId]?.errors;
    if (errs?.length) throw new Error(errs.map((e) => e.reason).join(", "));
    return name;
  } catch (e: any) {
    const code = e?.code || e?.response?.status;
    if (code === 404 || /notFound/i.test(e?.message)) {
      throw new Error(viaKey ? "Calendar not found. Check the Calendar ID, and that you shared the calendar with the service account email." : "Calendar not found.");
    }
    if (code === 403 && /API has not been used|disabled/i.test(e?.message)) {
      throw new Error("Google Calendar API is not enabled for this Google Cloud project. Enable it and try again in a minute.");
    }
    if (/invalid_grant/i.test(e?.message)) throw new Error("Google access was removed. Sign in with Google again.");
    throw new Error(e?.message || "Could not reach Google Calendar.");
  }
}

// Public holiday calendars Google publishes.
export const HOLIDAY_CALENDARS: [string, string][] = [
  ["en.indian#holiday@group.v.calendar.google.com", "India"],
  ["en.usa#holiday@group.v.calendar.google.com", "United States"],
  ["en.uk#holiday@group.v.calendar.google.com", "United Kingdom"],
  ["en.ae#holiday@group.v.calendar.google.com", "UAE"],
  ["en.singapore#holiday@group.v.calendar.google.com", "Singapore"],
  ["en.australian#holiday@group.v.calendar.google.com", "Australia"],
  ["en.canadian#holiday@group.v.calendar.google.com", "Canada"],
];

/** Next 12 months of public holidays from Google's holiday calendar for a country. */
export async function publicHolidays(ws: Workspace, calendarId: string): Promise<{ date: string; label: string }[]> {
  const cal = calendarApi(ws);
  if (!cal) throw new Error("Connect Google Calendar first.");
  const res = await cal.events.list({
    calendarId,
    timeMin: new Date().toISOString(),
    timeMax: new Date(Date.now() + 366 * 86400_000).toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 250,
  });
  const seen = new Set<string>();
  return (res.data.items ?? [])
    .map((e) => ({ date: e.start?.date || (e.start?.dateTime || "").slice(0, 10), label: e.summary || "Holiday" }))
    .filter((h) => h.date && !seen.has(h.date + h.label) && seen.add(h.date + h.label));
}

// All-day events in the business's own calendar with these words close the day.
const DAY_OFF = /\b(holiday|leave|closed|vacation|day off|off day|chutti|chhutti)\b|छुट्टी|अवकाश/i;

// ============================================================ Booking logic

export interface SlotResult { date: string; slots: string[]; closed?: string; note?: string }

export class WorkspaceCalendar {
  private cal: calendar_v3.Calendar;
  readonly calendarId: string;
  constructor(private ws: Workspace, private hours: BusinessHours = hoursOf(ws)) {
    const cal = calendarApi(ws);
    if (!cal || !ws.google_calendar_id) throw new Error("Google Calendar is not set up.");
    this.cal = cal;
    this.calendarId = ws.google_calendar_id;
  }

  get tz() {
    return this.hours.timezone;
  }

  now() {
    return DateTime.now().setZone(this.hours.timezone);
  }

  parse(iso: string) {
    const dt = DateTime.fromISO(iso, { zone: this.hours.timezone });
    if (!dt.isValid) throw new Error(`Invalid date/time "${iso}". Use YYYY-MM-DD or YYYY-MM-DDTHH:mm.`);
    return dt;
  }

  fmt(dt: DateTime) {
    return dt.setZone(this.hours.timezone).toFormat("ccc d LLL, h:mm a");
  }

  private async busy(from: DateTime, to: DateTime, ignoreBookingId?: number) {
    const res = await this.cal.freebusy.query({
      requestBody: { timeMin: from.toISO()!, timeMax: to.toISO()!, timeZone: this.hours.timezone, items: [{ id: this.calendarId }] },
    });
    const c = res.data.calendars?.[this.calendarId];
    if (c?.errors?.length) throw new Error(`Calendar error: ${c.errors.map((e) => e.reason).join(", ")}`);
    const busy = (c?.busy ?? []).map((b) => ({ start: DateTime.fromISO(b.start!), end: DateTime.fromISO(b.end!) }));
    // Slots held for someone who is paying right now aren't in the calendar yet.
    // Our confirmed bookings that never reached the calendar (calendar write failed) still block their slot.
    const holds = await db.all<{ id: number; start_at: string; end_at: string }>(
      "SELECT id, start_at, end_at FROM bookings WHERE workspace_id=? AND ((status='held' AND hold_expires_at > ?) OR (status='confirmed' AND event_id IS NULL)) AND start_at < ? AND end_at > ?",
      this.ws.id, Date.now(), to.toISO()!, from.toISO()!
    );
    for (const h of holds) if (h.id !== ignoreBookingId) busy.push({ start: DateTime.fromISO(h.start_at), end: DateTime.fromISO(h.end_at) });
    // When moving a booking, its own current event shouldn't block the new time.
    if (ignoreBookingId) {
      const own = await db.get<{ start_at: string; end_at: string }>("SELECT start_at, end_at FROM bookings WHERE id=?", ignoreBookingId);
      if (own) {
        const s0 = DateTime.fromISO(own.start_at).toMillis(), e0 = DateTime.fromISO(own.end_at).toMillis();
        const i = busy.findIndex((b) => b.start.toMillis() === s0 && b.end.toMillis() === e0);
        if (i >= 0) busy.splice(i, 1);
      }
    }
    return busy;
  }

  /** All-day "Holiday / Leave / Closed" events in their calendar. */
  private async dayOffEvent(day: DateTime): Promise<string | null> {
    try {
      const res = await this.cal.events.list({
        calendarId: this.calendarId,
        timeMin: day.startOf("day").toISO()!,
        timeMax: day.endOf("day").toISO()!,
        singleEvents: true,
        maxResults: 50,
      });
      const ev = (res.data.items ?? []).find((e) => e.start?.date && DAY_OFF.test(e.summary || ""));
      return ev ? ev.summary || "Holiday" : null;
    } catch {
      return null; // never block booking just because this extra check failed
    }
  }

  async availableSlots(date: string, minutes = this.hours.slotMinutes, ignoreBookingId?: number): Promise<SlotResult> {
    const h = this.hours;
    const day = this.parse(date).startOf("day");
    const iso = day.toISODate()!;
    if (day < this.now().startOf("day")) return { date: iso, slots: [], note: "That date is in the past." };
    const hol = await holidayOn(this.ws, iso);
    if (hol) return { date: iso, slots: [], closed: hol, note: `Closed on ${day.toFormat("d LLL")} for ${hol}.` };
    if (!h.workingDays.includes(day.weekday)) return { date: iso, slots: [], closed: "weekly off", note: `Closed on ${day.toFormat("cccc")}s.` };
    const off = await this.dayOffEvent(day);
    if (off) return { date: iso, slots: [], closed: off, note: `Closed that day (${off}).` };
    const open = day.set({ hour: h.openHour });
    const close = day.set({ hour: h.closeHour });
    const earliest = this.now().plus({ minutes: 30 });
    const busy = await this.busy(open, close, ignoreBookingId);
    const slots: string[] = [];
    for (let s = open; s.plus({ minutes }) <= close; s = s.plus({ minutes: h.slotMinutes })) {
      const e = s.plus({ minutes });
      if (s < earliest) continue;
      if (!busy.some((b) => s < b.end && e > b.start)) slots.push(s.toFormat("HH:mm"));
    }
    return { date: iso, slots, note: slots.length ? undefined : "No free slots that day." };
  }

  async isFree(startIso: string, minutes: number, ignoreBookingId?: number) {
    const start = this.parse(startIso);
    const r = await this.availableSlots(start.toISODate()!, minutes, ignoreBookingId);
    return { ok: r.slots.includes(start.toFormat("HH:mm")), result: r, start, end: start.plus({ minutes }) };
  }

  /** Creates the calendar event. With Google sign-in, the customer gets an email invite and online sessions get a Meet link. */
  async createEvent(e: {
    start: DateTime; end: DateTime; summary: string; description: string; location?: string;
    attendee?: { email: string; name: string }; meet?: boolean; privateProps: Record<string, string>;
  }): Promise<{ eventId: string; meetLink: string; invited: boolean }> {
    const invites = canInvite(this.ws);
    const body: calendar_v3.Schema$Event = {
      summary: e.summary,
      description: e.description,
      location: e.location || undefined,
      start: { dateTime: e.start.toISO()!, timeZone: this.hours.timezone },
      end: { dateTime: e.end.toISO()!, timeZone: this.hours.timezone },
      extendedProperties: { private: e.privateProps },
      reminders: { useDefault: true },
    };
    const withAttendee = invites && e.attendee?.email;
    if (withAttendee) body.attendees = [{ email: e.attendee!.email, displayName: e.attendee!.name }];
    if (invites && e.meet) body.conferenceData = { createRequest: { requestId: randomToken(10), conferenceSolutionKey: { type: "hangoutsMeet" } } };
    const insert = (b: calendar_v3.Schema$Event) =>
      this.cal.events.insert({ calendarId: this.calendarId, requestBody: b, sendUpdates: withAttendee ? "all" : "none", conferenceDataVersion: b.conferenceData ? 1 : 0 });
    let res;
    try {
      res = await insert(body);
    } catch (err: any) {
      // Some accounts can't create Meet links or invite guests: still book, just without those.
      if (!body.conferenceData && !body.attendees) throw err;
      console.warn("Event insert with invite/Meet failed, retrying plain:", err?.message);
      delete body.conferenceData;
      delete body.attendees;
      res = await this.cal.events.insert({ calendarId: this.calendarId, requestBody: body, sendUpdates: "none" });
    }
    const meetLink = res.data.hangoutLink || res.data.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri || "";
    return { eventId: res.data.id!, meetLink, invited: !!res.data.attendees?.length };
  }

  async updateEvent(eventId: string, patch: { start?: DateTime; end?: DateTime; summary?: string; description?: string }) {
    const body: calendar_v3.Schema$Event = {};
    if (patch.start) body.start = { dateTime: patch.start.toISO()!, timeZone: this.hours.timezone };
    if (patch.end) body.end = { dateTime: patch.end.toISO()!, timeZone: this.hours.timezone };
    if (patch.summary) body.summary = patch.summary;
    if (patch.description) body.description = patch.description;
    await this.cal.events.patch({ calendarId: this.calendarId, eventId, requestBody: body, sendUpdates: canInvite(this.ws) ? "all" : "none" });
  }

  async deleteEvent(eventId: string) {
    await this.cal.events.delete({ calendarId: this.calendarId, eventId, sendUpdates: canInvite(this.ws) ? "all" : "none" }).catch((e: any) => {
      if (e?.code !== 404 && e?.code !== 410) throw e;
    });
  }
}

export function normPhone(p: string): string {
  return (p || "").replace(/[^\d]/g, "");
}
