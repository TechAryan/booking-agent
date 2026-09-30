import { google, calendar_v3 } from "googleapis";
import { DateTime } from "luxon";
import type { Workspace } from "./db.js";
import { decrypt } from "./security.js";
import { fakeCalendarClient } from "./testing/fakeGoogle.js";

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

// ---------- Google client (cached per workspace + credentials version) ----------

const cache = new Map<string, calendar_v3.Calendar>();

export function googleClient(serviceAccountJson: string): calendar_v3.Calendar {
  if (process.env.FAKE_GOOGLE_CALENDAR === "1") return fakeCalendarClient();
  const hit = cache.get(serviceAccountJson);
  if (hit) return hit;
  const credentials = JSON.parse(serviceAccountJson);
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/calendar"] });
  const cal = google.calendar({ version: "v3", auth });
  cache.set(serviceAccountJson, cal);
  return cal;
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

/** Checks the calendar is reachable and writable. Returns the calendar's name. */
export async function testCalendar(serviceAccountJson: string, calendarId: string): Promise<string> {
  const cal = googleClient(serviceAccountJson);
  try {
    const res = await cal.calendarList.insert({ requestBody: { id: calendarId } }).catch(() => null);
    const meta = await cal.calendars.get({ calendarId });
    const fb = await cal.freebusy.query({
      requestBody: {
        timeMin: new Date().toISOString(),
        timeMax: new Date(Date.now() + 86400_000).toISOString(),
        items: [{ id: calendarId }],
      },
    });
    const errs = fb.data.calendars?.[calendarId]?.errors;
    if (errs?.length) throw new Error(errs.map((e) => e.reason).join(", "));
    const access = res?.data.accessRole;
    if (access && !["writer", "owner"].includes(access)) {
      throw new Error(`The calendar is shared as "${access}". Change it to "Make changes to events".`);
    }
    return meta.data.summary || calendarId;
  } catch (e: any) {
    const code = e?.code || e?.response?.status;
    if (code === 404 || /notFound/i.test(e?.message)) {
      throw new Error("Calendar not found. Check the Calendar ID, and that you shared the calendar with the service account email.");
    }
    if (code === 403 && /API has not been used|disabled/i.test(e?.message)) {
      throw new Error("Google Calendar API is not enabled for this Google Cloud project. Enable it and try again in a minute.");
    }
    throw new Error(e?.message || "Could not reach Google Calendar.");
  }
}

// ---------- Booking logic ----------

export class WorkspaceCalendar {
  private cal: calendar_v3.Calendar;
  private calendarId: string;
  constructor(ws: Workspace, private hours: BusinessHours = hoursOf(ws)) {
    const sa = decrypt(ws.google_sa_enc);
    if (!sa || !ws.google_calendar_id) throw new Error("Google Calendar is not set up.");
    this.cal = googleClient(sa);
    this.calendarId = ws.google_calendar_id;
  }

  now() {
    return DateTime.now().setZone(this.hours.timezone);
  }

  private parse(iso: string) {
    const dt = DateTime.fromISO(iso, { zone: this.hours.timezone });
    if (!dt.isValid) throw new Error(`Invalid date/time "${iso}". Use YYYY-MM-DD or YYYY-MM-DDTHH:mm.`);
    return dt;
  }

  fmt(dt: DateTime) {
    return dt.setZone(this.hours.timezone).toFormat("ccc d LLL, h:mm a");
  }

  private async busy(from: DateTime, to: DateTime) {
    const res = await this.cal.freebusy.query({
      requestBody: { timeMin: from.toISO()!, timeMax: to.toISO()!, timeZone: this.hours.timezone, items: [{ id: this.calendarId }] },
    });
    const c = res.data.calendars?.[this.calendarId];
    if (c?.errors?.length) throw new Error(`Calendar error: ${c.errors.map((e) => e.reason).join(", ")}`);
    return (c?.busy ?? []).map((b) => ({ start: DateTime.fromISO(b.start!), end: DateTime.fromISO(b.end!) }));
  }

  async availableSlots(date: string) {
    const h = this.hours;
    const day = this.parse(date).startOf("day");
    if (!h.workingDays.includes(day.weekday)) return { date: day.toISODate(), slots: [], note: `Closed on ${day.toFormat("cccc")}s.` };
    const open = day.set({ hour: h.openHour });
    const close = day.set({ hour: h.closeHour });
    const earliest = this.now().plus({ minutes: 30 });
    const busy = await this.busy(open, close);
    const slots: string[] = [];
    for (let s = open; s.plus({ minutes: h.slotMinutes }) <= close; s = s.plus({ minutes: h.slotMinutes })) {
      const e = s.plus({ minutes: h.slotMinutes });
      if (s < earliest) continue;
      if (!busy.some((b) => s < b.end && e > b.start)) slots.push(s.toFormat("HH:mm"));
    }
    return { date: day.toISODate(), slots, note: slots.length ? undefined : "No free slots that day." };
  }

  /** owner = who may later list/cancel this booking: the WhatsApp number, or the widget chat session. */
  async book(input: { start: string; customerName: string; service: string; phone: string; channel: string; owner: string }) {
    const start = this.parse(input.start);
    const end = start.plus({ minutes: this.hours.slotMinutes });
    const { slots } = await this.availableSlots(start.toISODate()!);
    if (!slots.includes(start.toFormat("HH:mm"))) return { ok: false, message: `${this.fmt(start)} is not available. Ask for another time.` };
    const res = await this.cal.events.insert({
      calendarId: this.calendarId,
      requestBody: {
        summary: `${input.service} – ${input.customerName}`,
        description: `Booked via ${input.channel}\nName: ${input.customerName}\nPhone: ${input.phone}\nService: ${input.service}`,
        start: { dateTime: start.toISO()!, timeZone: this.hours.timezone },
        end: { dateTime: end.toISO()!, timeZone: this.hours.timezone },
        extendedProperties: { private: { bookingOwner: input.owner, bookingPhone: normPhone(input.phone), customerName: input.customerName, service: input.service } },
      },
    });
    return { ok: true, bookingId: res.data.id, when: this.fmt(start), message: `Booked ${input.service} for ${input.customerName} on ${this.fmt(start)}.` };
  }

  async listForOwner(owner: string) {
    const res = await this.cal.events.list({
      calendarId: this.calendarId,
      timeMin: this.now().toISO()!,
      privateExtendedProperty: [`bookingOwner=${owner}`],
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 10,
    });
    return (res.data.items ?? []).map((e) => ({
      bookingId: e.id,
      when: e.start?.dateTime ? this.fmt(DateTime.fromISO(e.start.dateTime)) : "",
      service: e.extendedProperties?.private?.service ?? "",
      name: e.extendedProperties?.private?.customerName ?? "",
    }));
  }

  async cancel(owner: string, bookingId: string) {
    const mine = await this.listForOwner(owner);
    if (!mine.some((b) => b.bookingId === bookingId)) return { ok: false, message: "No upcoming booking with that id made from this chat." };
    await this.cal.events.delete({ calendarId: this.calendarId, eventId: bookingId });
    return { ok: true, message: "Appointment cancelled." };
  }
}

export function normPhone(p: string): string {
  return (p || "").replace(/[^\d]/g, "");
}
