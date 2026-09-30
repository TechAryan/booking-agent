// In-memory stand-in for the Google Calendar client, used only when FAKE_GOOGLE_CALENDAR=1 (tests/demos).
type Ev = { id: string; start: string; end: string; summary: string; priv: Record<string, string> };
const events: Ev[] = [];
let seq = 1;

export function fakeCalendarClient(): any {
  return {
    calendarList: { insert: async () => ({ data: { accessRole: "writer" } }) },
    calendars: { get: async ({ calendarId }: any) => ({ data: { summary: `Fake calendar ${calendarId}` } }) },
    freebusy: {
      query: async ({ requestBody }: any) => {
        const id = requestBody.items[0].id;
        const from = Date.parse(requestBody.timeMin), to = Date.parse(requestBody.timeMax);
        const busy = events.filter((e) => Date.parse(e.start) < to && Date.parse(e.end) > from).map((e) => ({ start: e.start, end: e.end }));
        return { data: { calendars: { [id]: { busy } } } };
      },
    },
    events: {
      insert: async ({ requestBody }: any) => {
        const ev = { id: `ev${seq++}`, start: requestBody.start.dateTime, end: requestBody.end.dateTime, summary: requestBody.summary, priv: requestBody.extendedProperties?.private ?? {} };
        events.push(ev);
        return { data: { id: ev.id } };
      },
      list: async ({ privateExtendedProperty, timeMin }: any) => {
        const [k, v] = String(privateExtendedProperty[0]).split("=");
        const items = events.filter((e) => e.priv[k] === v && Date.parse(e.end) > Date.parse(timeMin))
          .map((e) => ({ id: e.id, start: { dateTime: e.start }, end: { dateTime: e.end }, extendedProperties: { private: e.priv } }));
        return { data: { items } };
      },
      delete: async ({ eventId }: any) => {
        const i = events.findIndex((e) => e.id === eventId);
        if (i >= 0) events.splice(i, 1);
        return {};
      },
    },
  };
}
