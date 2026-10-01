// In-memory stand-in for Google Calendar + Google sign-in, used only when FAKE_GOOGLE_CALENDAR=1 (tests/demos).
type Ev = {
  id: string; calendarId: string; start: string; end: string; allDay?: string; summary: string; description?: string; location?: string;
  priv: Record<string, string>; attendees?: any[]; hangoutLink?: string; sendUpdates?: string;
};
export const fakeEvents: Ev[] = [];
let seq = 1;

// A public holiday calendar with a couple of days in it.
const nextYear = new Date().getFullYear() + 1;
fakeEvents.push({ id: "hol1", calendarId: "en.indian#holiday@group.v.calendar.google.com", start: "", end: "", allDay: `${nextYear}-01-26`, summary: "Republic Day", priv: {} });
fakeEvents.push({ id: "hol2", calendarId: "en.indian#holiday@group.v.calendar.google.com", start: "", end: "", allDay: `${nextYear}-08-15`, summary: "Independence Day", priv: {} });

export const fakeOAuth = {
  authUrl: (state: string) => `${(process.env.PUBLIC_URL || "").replace(/\/+$/, "")}/setup/google/callback?code=fake-code&state=${encodeURIComponent(state)}`,
  exchange: async (code: string) => {
    if (code !== "fake-code") throw new Error("invalid_grant");
    return { refreshToken: "fake-refresh-token", email: "owner@gmail.com", scopes: "calendar" };
  },
};

const inRange = (e: Ev, from: number, to: number) => {
  const s = e.allDay ? Date.parse(`${e.allDay}T00:00:00+05:30`) : Date.parse(e.start);
  const en = e.allDay ? s + 86400_000 : Date.parse(e.end);
  return s < to && en > from;
};

export function fakeCalendarClient(): any {
  return {
    calendarList: {
      insert: async () => ({ data: { accessRole: "writer" } }),
      list: async () => ({ data: { items: [
        { id: "owner@gmail.com", summary: "owner@gmail.com", primary: true, accessRole: "owner" },
        { id: "bookings@group.calendar.google.com", summary: "Bookings", accessRole: "owner" },
      ] } }),
    },
    calendars: { get: async ({ calendarId }: any) => ({ data: { summary: `Fake calendar ${calendarId}` } }) },
    freebusy: {
      query: async ({ requestBody }: any) => {
        const id = requestBody.items[0].id;
        const from = Date.parse(requestBody.timeMin), to = Date.parse(requestBody.timeMax);
        const busy = fakeEvents.filter((e) => e.calendarId === id && !e.allDay && inRange(e, from, to)).map((e) => ({ start: e.start, end: e.end }));
        return { data: { calendars: { [id]: { busy } } } };
      },
    },
    events: {
      insert: async ({ calendarId, requestBody, sendUpdates, conferenceDataVersion }: any) => {
        const ev: Ev = {
          id: `ev${seq++}`, calendarId, start: requestBody.start.dateTime, end: requestBody.end.dateTime, allDay: requestBody.start.date,
          summary: requestBody.summary, description: requestBody.description, location: requestBody.location,
          priv: requestBody.extendedProperties?.private ?? {}, attendees: requestBody.attendees, sendUpdates,
          hangoutLink: conferenceDataVersion && requestBody.conferenceData ? `https://meet.google.com/fak-${seq}-mtg` : undefined,
        };
        fakeEvents.push(ev);
        return { data: { id: ev.id, hangoutLink: ev.hangoutLink, attendees: ev.attendees } };
      },
      patch: async ({ eventId, requestBody }: any) => {
        const ev = fakeEvents.find((e) => e.id === eventId);
        if (!ev) throw Object.assign(new Error("Not Found"), { code: 404 });
        if (requestBody.start) ev.start = requestBody.start.dateTime;
        if (requestBody.end) ev.end = requestBody.end.dateTime;
        if (requestBody.summary) ev.summary = requestBody.summary;
        if (requestBody.description) ev.description = requestBody.description;
        return { data: { id: ev.id } };
      },
      list: async ({ calendarId, privateExtendedProperty, timeMin, timeMax }: any) => {
        const from = timeMin ? Date.parse(timeMin) : 0, to = timeMax ? Date.parse(timeMax) : Infinity;
        let items = fakeEvents.filter((e) => e.calendarId === calendarId && inRange(e, from, to));
        if (privateExtendedProperty) {
          const [k, v] = String(privateExtendedProperty[0]).split("=");
          items = items.filter((e) => e.priv[k!] === v);
        }
        return { data: { items: items.map((e) => ({ id: e.id, summary: e.summary, start: e.allDay ? { date: e.allDay } : { dateTime: e.start }, end: e.allDay ? { date: e.allDay } : { dateTime: e.end }, extendedProperties: { private: e.priv } })) } };
      },
      delete: async ({ eventId }: any) => {
        const i = fakeEvents.findIndex((e) => e.id === eventId);
        if (i >= 0) fakeEvents.splice(i, 1);
        return {};
      },
    },
  };
}
