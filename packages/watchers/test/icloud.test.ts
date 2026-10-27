import { describe, expect, it } from "vitest";
import { createICloudSource, WatcherError } from "../src/index.ts";

const USER = "user@example.com";
const PASSWORD = "app-pass-123";

const ics = (body: string): string =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", body, "END:VCALENDAR"].join("\r\n");

const SINGLE = ics(
  ["BEGIN:VEVENT", "UID:single-1", "DTSTART:20261028T080000Z", "DTEND:20261028T090000Z", "SUMMARY:Dentist", "END:VEVENT"].join("\r\n"),
);
const BERLIN = [
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Berlin",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "DTSTART:19700329T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "DTSTART:19701025T030000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
].join("\r\n");
const WEEKLY = ics(
  [
    BERLIN,
    "BEGIN:VEVENT",
    "UID:weekly-1",
    "DTSTART;TZID=Europe/Berlin:20261001T180000",
    "DTEND;TZID=Europe/Berlin:20261001T190000",
    "RRULE:FREQ=WEEKLY",
    "SUMMARY:Choir",
    "ORGANIZER:mailto:other@example.com",
    "END:VEVENT",
  ].join("\r\n"),
);
const ALLDAY = ics(["BEGIN:VEVENT", "UID:allday-1", "DTSTART;VALUE=DATE:20261029", "DTEND;VALUE=DATE:20261030", "SUMMARY:Holiday", "END:VEVENT"].join("\r\n"));

const escape = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r/g, "&#13;");

function multistatus(responses: string[]): string {
  return `<?xml version="1.0"?><multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CR="urn:ietf:params:xml:ns:carddav">${responses.join("")}</multistatus>`;
}

function fakeServer() {
  const calls: { method: string; url: string; auth: string | null; depth: string | null }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    calls.push({ method, url, auth: headers.get("authorization"), depth: headers.get("depth") });
    const body = String(init?.body ?? "");
    let xml = "";
    if (url === "https://caldav.icloud.com/" && body.includes("current-user-principal")) {
      xml = multistatus([`<response><href>/</href><propstat><prop><current-user-principal><href>/123/principal/</href></current-user-principal></prop></propstat></response>`]);
    } else if (url === "https://caldav.icloud.com/123/principal/") {
      xml = multistatus([`<response><href>/123/principal/</href><propstat><prop><C:calendar-home-set><href>https://p01-caldav.icloud.com/123/calendars/</href></C:calendar-home-set></prop></propstat></response>`]);
    } else if (url === "https://p01-caldav.icloud.com/123/calendars/" && method === "PROPFIND") {
      xml = multistatus([
        `<response><href>/123/calendars/</href><propstat><prop><displayname>home</displayname><resourcetype><collection/></resourcetype></prop></propstat></response>`,
        `<response><href>/123/calendars/abc/</href><propstat><prop><displayname>Personal</displayname><resourcetype><collection/><C:calendar/></resourcetype></prop></propstat></response>`,
        `<response><href>/123/calendars/def/</href><propstat><prop><displayname>Work</displayname><resourcetype><collection/><C:calendar/></resourcetype></prop></propstat></response>`,
      ]);
    } else if (url === "https://p01-caldav.icloud.com/123/calendars/abc/" && method === "REPORT") {
      xml = multistatus(
        [SINGLE, WEEKLY, ALLDAY].map(
          (data, i) => `<response><href>/123/calendars/abc/${i}.ics</href><propstat><prop><C:calendar-data>${escape(data)}</C:calendar-data></prop></propstat></response>`,
        ),
      );
    } else if (url === "https://contacts.icloud.com/" && body.includes("current-user-principal")) {
      xml = multistatus([`<response><href>/</href><propstat><prop><current-user-principal><href>/123/principal/</href></current-user-principal></prop></propstat></response>`]);
    } else if (url === "https://contacts.icloud.com/123/principal/") {
      xml = multistatus([`<response><href>/</href><propstat><prop><CR:addressbook-home-set><href>https://p01-contacts.icloud.com/123/carddavhome/</href></CR:addressbook-home-set></prop></propstat></response>`]);
    } else if (url === "https://p01-contacts.icloud.com/123/carddavhome/" && method === "PROPFIND") {
      xml = multistatus([
        `<response><href>/123/carddavhome/</href><propstat><prop><resourcetype><collection/></resourcetype></prop></propstat></response>`,
        `<response><href>/123/carddavhome/card/</href><propstat><prop><resourcetype><collection/><CR:addressbook/></resourcetype></prop></propstat></response>`,
      ]);
    } else if (url === "https://p01-contacts.icloud.com/123/carddavhome/card/" && method === "REPORT") {
      const cards = [
        "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Anna Example\r\nBDAY:1990-10-28\r\nEND:VCARD",
        "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ben Example\r\nBDAY;X-APPLE-OMIT-YEAR=1604:1604-10-27\r\nEND:VCARD",
        "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:No Birthday\r\nEND:VCARD",
      ];
      xml = multistatus(
        cards.map((c, i) => `<response><href>/c/${i}.vcf</href><propstat><prop><CR:address-data>${escape(c)}</CR:address-data></prop></propstat></response>`),
      );
    } else {
      return new Response("not found", { status: 404 });
    }
    return new Response(xml, { status: 207 });
  };
  return { fetch, calls };
}

function source() {
  const server = fakeServer();
  const icloud = createICloudSource({
    username: USER,
    password: { reveal: () => PASSWORD },
    timeZone: "Europe/Berlin",
    fetch: server.fetch,
  });
  return { icloud, ...server };
}

describe("iCloud CalDAV", () => {
  it("discovers calendars by name", async () => {
    const { icloud } = source();
    expect(await icloud.calendars()).toEqual([
      { name: "Personal", url: "https://p01-caldav.icloud.com/123/calendars/abc/" },
      { name: "Work", url: "https://p01-caldav.icloud.com/123/calendars/def/" },
    ]);
  });

  it("returns events of the selected calendars with recurrences expanded in the range", async () => {
    const { icloud } = source();
    const events = await icloud.events(["Personal"], {
      start: Date.parse("2026-10-27T23:00:00Z"),
      end: Date.parse("2026-10-29T23:00:00Z"),
    });
    expect(events).toEqual([
      {
        key: "icloud:single-1",
        title: "Dentist",
        start: Date.parse("2026-10-28T08:00:00Z"),
        end: Date.parse("2026-10-28T09:00:00Z"),
        allDay: false,
        organizer: "",
        cancelled: false,
      },
      {
        key: "icloud:allday-1",
        title: "Holiday",
        start: Date.parse("2026-10-28T23:00:00Z"),
        end: Date.parse("2026-10-29T23:00:00Z"),
        allDay: true,
        organizer: "",
        cancelled: false,
      },
      {
        key: "icloud:weekly-1@20261029T170000Z",
        title: "Choir",
        start: Date.parse("2026-10-29T17:00:00Z"),
        end: Date.parse("2026-10-29T18:00:00Z"),
        allDay: false,
        organizer: "other@example.com",
        cancelled: false,
      },
    ]);
  });

  it("sends only PROPFIND and REPORT requests with basic auth", async () => {
    const { icloud, calls } = source();
    await icloud.events(["Personal"], { start: 0, end: Date.parse("2026-11-01T00:00:00Z") });
    expect(new Set(calls.map((c) => c.method))).toEqual(new Set(["PROPFIND", "REPORT"]));
    expect(calls.every((c) => c.auth === `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`)).toBe(true);
  });

  it("fails clearly when a configured calendar does not exist", async () => {
    const { icloud } = source();
    await expect(icloud.events(["Nope"], { start: 0, end: 1 })).rejects.toThrow(/calendar "Nope" not found/);
  });

  it("reports HTTP errors without the password", async () => {
    const icloud = createICloudSource({
      username: USER,
      password: { reveal: () => PASSWORD },
      timeZone: "Europe/Berlin",
      fetch: async () => new Response("denied", { status: 401 }),
    });
    const error = await icloud.calendars().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WatcherError);
    expect(String(error)).toContain("401");
    expect(String(error)).not.toContain(PASSWORD);
  });
});

describe("iCloud CardDAV birthdays", () => {
  it("reads birthdays from contacts, with and without year", async () => {
    const { icloud } = source();
    expect(await icloud.birthdays()).toEqual([
      { name: "Anna Example", month: 10, day: 28, year: 1990 },
      { name: "Ben Example", month: 10, day: 27, year: undefined },
    ]);
  });
});
