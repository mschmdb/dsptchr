import { wallClockToUtc } from "@dsptchr/core";
import { DOMParser, type Document, type Element } from "@xmldom/xmldom";
import ICAL from "ical.js";
import { WatcherError } from "../server-health/server-health.ts";
import type { CalendarEvent } from "../proton/source.ts";

export interface Birthday {
  name: string;
  month: number;
  day: number;
  year: number | undefined;
}

export interface ICloudOptions {
  username: string;
  // App-specific password; read-only use is enforced by sending only PROPFIND and REPORT.
  password: { reveal(): string };
  timeZone: string;
  fetch?: typeof globalThis.fetch;
}

const CALDAV = "https://caldav.icloud.com/";
const CARDDAV = "https://contacts.icloud.com/";
// Steps through a series from DTSTART; enough for a daily series running about 50 years.
const MAX_STEPS = 20_000;
const ICLOUD_HOST = /^(p\d+-)?(caldav|contacts)\.icloud\.com$/;

// Credentials only ever go to iCloud's DAV hosts over HTTPS, whatever a response points to.
function checkedUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !ICLOUD_HOST.test(parsed.hostname) || parsed.username !== "" || parsed.port !== "") {
    throw new WatcherError("icloud: refusing a URL outside iCloud");
  }
  return parsed.toString();
}

const utc = (ms: number): string => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

const PRINCIPAL_BODY = `<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`;

// iCloud calendars over CalDAV and birthdays from contacts over CardDAV, read-only.
export function createICloudSource(options: ICloudOptions) {
  const fetch = options.fetch ?? globalThis.fetch;
  let calendarHome: string | undefined;
  let addressbook: string | undefined;

  async function dav(method: "PROPFIND" | "REPORT", url: string, depth: "0" | "1", body: string): Promise<Document> {
    let response: Response;
    try {
      response = await fetch(checkedUrl(url), {
        method,
        // A redirect could turn PROPFIND or REPORT into GET or point elsewhere; treat it as an error.
        redirect: "manual",
        headers: {
          authorization: `Basic ${Buffer.from(`${options.username}:${options.password.reveal()}`).toString("base64")}`,
          depth,
          "content-type": "application/xml; charset=utf-8",
        },
        body,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      if (error instanceof WatcherError) throw error;
      throw new WatcherError("icloud: request failed");
    }
    if (response.status !== 207 && response.status !== 200) {
      throw new WatcherError(`icloud: HTTP ${response.status}`);
    }
    return new DOMParser().parseFromString(await response.text(), "application/xml");
  }

  const all = (node: Document | Element, name: string): Element[] => Array.from(node.getElementsByTagNameNS("*", name));
  const first = (node: Document | Element, name: string): Element | undefined => all(node, name)[0];
  const hrefIn = (node: Document | Element, container: string): string | undefined => {
    const holder = first(node, container);
    return holder === undefined ? undefined : (first(holder, "href")?.textContent ?? undefined)?.trim();
  };

  async function home(base: string, homeSet: string, body: string): Promise<string> {
    const principal = hrefIn(await dav("PROPFIND", base, "0", PRINCIPAL_BODY), "current-user-principal");
    if (principal === undefined) throw new WatcherError("icloud: no principal");
    const principalUrl = checkedUrl(new URL(principal, base).toString());
    const href = hrefIn(await dav("PROPFIND", principalUrl, "0", body), homeSet);
    if (href === undefined) throw new WatcherError("icloud: no home set");
    return checkedUrl(new URL(href, principalUrl).toString());
  }

  async function calendars(): Promise<{ name: string; url: string }[]> {
    calendarHome ??= await home(
      CALDAV,
      "calendar-home-set",
      `<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>`,
    );
    const doc = await dav(
      "PROPFIND",
      calendarHome,
      "1",
      `<d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/></d:prop></d:propfind>`,
    );
    return all(doc, "response")
      .filter((r) => first(r, "calendar") !== undefined)
      .map((r) => ({
        name: (first(r, "displayname")?.textContent ?? "").trim(),
        url: checkedUrl(new URL((first(r, "href")?.textContent ?? "").trim(), calendarHome).toString()),
      }));
  }

  function toMillis(time: ICAL.Time): number {
    if (time.isDate || time.zone === ICAL.Timezone.localTimezone) {
      // Dates and floating times mean wall-clock time in the operator's zone.
      const minuteStart = wallClockToUtc(
        { year: time.year, month: time.month, day: time.day, hour: time.isDate ? 0 : time.hour, minute: time.isDate ? 0 : time.minute },
        options.timeZone,
      );
      return minuteStart + (time.isDate ? 0 : time.second * 1000);
    }
    return time.toUnixTime() * 1000;
  }

  const organizerOf = (component: ICAL.Component): string =>
    String(component.getFirstPropertyValue("organizer") ?? "").replace(/^mailto:/i, "");

  // calendarId namespaces keys, so equal UIDs in two calendars never collide.
  function eventsFrom(data: string, calendarId: string, range: { start: number; end: number }): CalendarEvent[] {
    const calendar = new ICAL.Component(ICAL.parse(data));
    for (const zone of calendar.getAllSubcomponents("vtimezone")) {
      ICAL.TimezoneService.register(zone);
    }
    const vevents = calendar.getAllSubcomponents("vevent").map((v) => new ICAL.Event(v));
    const out: CalendarEvent[] = [];
    const push = (start: ICAL.Time, end: ICAL.Time, component: ICAL.Component, fallbackOrganizer: string, key: string): void => {
      const startMs = toMillis(start);
      const endMs = toMillis(end);
      if (startMs >= range.end || endMs <= range.start) return;
      const organizer = organizerOf(component);
      out.push({
        key: `icloud:${calendarId}:${key}`,
        title: String(component.getFirstPropertyValue("summary") ?? ""),
        start: startMs,
        end: endMs,
        allDay: start.isDate,
        // An exception without its own organizer keeps the series' organizer.
        organizer: organizer === "" ? fallbackOrganizer : organizer,
        cancelled: String(component.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED",
      });
    };

    for (const master of vevents.filter((e) => !e.isRecurrenceException())) {
      const exceptions = vevents.filter((x) => x.isRecurrenceException() && x.uid === master.uid);
      const exceptionIds = new Set(exceptions.map((x) => toMillis(x.recurrenceId)));
      // RANGE=THISANDFUTURE: the exception's shift and details apply to every later occurrence too.
      const futureRanges = exceptions
        .filter((x) => String(x.component.getFirstProperty("recurrence-id")?.getParameter("range") ?? "").toUpperCase() === "THISANDFUTURE")
        .map((x) => ({ from: toMillis(x.recurrenceId), shift: toMillis(x.startDate) - toMillis(x.recurrenceId), exception: x }))
        .sort((a, b) => a.from - b.from);
      const masterOrganizer = organizerOf(master.component);

      // Exceptions count by their own (possibly moved) dates.
      for (const exception of exceptions) {
        push(exception.startDate, exception.endDate, exception.component, masterOrganizer, `${master.uid}@${utc(toMillis(exception.recurrenceId))}`);
      }
      if (!master.isRecurring()) {
        push(master.startDate, master.endDate, master.component, "", master.uid);
        continue;
      }
      const iterator = master.iterator();
      for (let i = 0, next = iterator.next(); next !== undefined && next !== null && i < MAX_STEPS; i++, next = iterator.next()) {
        const occurrence = toMillis(next);
        if (exceptionIds.has(occurrence)) continue;
        const future = futureRanges.filter((f) => f.from < occurrence).at(-1);
        if ((future === undefined ? occurrence : occurrence + future.shift) >= range.end && occurrence >= range.end) break;
        const start = next.clone();
        if (future !== undefined) start.addDuration(ICAL.Duration.fromSeconds(future.shift / 1000));
        const end = start.clone();
        end.addDuration(future === undefined ? master.duration : future.exception.duration);
        const component = future === undefined ? master.component : future.exception.component;
        push(start, end, component, masterOrganizer, `${master.uid}@${utc(occurrence)}`);
      }
    }
    return out;
  }

  return {
    calendars,

    async events(names: readonly string[], range: { start: number; end: number }): Promise<CalendarEvent[]> {
      const available = await calendars();
      const events: CalendarEvent[] = [];
      for (const name of names) {
        const calendar = available.find((c) => c.name === name);
        if (calendar === undefined) throw new WatcherError(`icloud: calendar "${name}" not found`);
        const doc = await dav(
          "REPORT",
          calendar.url,
          "1",
          `<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data/></d:prop>` +
            `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">` +
            `<c:time-range start="${utc(range.start)}" end="${utc(range.end)}"/>` +
            `</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`,
        );
        const calendarId = new URL(calendar.url).pathname.split("/").filter(Boolean).at(-1) ?? "calendar";
        for (const data of all(doc, "calendar-data")) {
          try {
            events.push(...eventsFrom(data.textContent ?? "", calendarId, range));
          } catch {
            // One malformed event must not hide the rest of the calendar.
          }
        }
      }
      return events.sort((a, b) => a.start - b.start);
    },

    async birthdays(): Promise<Birthday[]> {
      if (addressbook === undefined) {
        const cardHome = await home(
          CARDDAV,
          "addressbook-home-set",
          `<d:propfind xmlns:d="DAV:" xmlns:cr="urn:ietf:params:xml:ns:carddav"><d:prop><cr:addressbook-home-set/></d:prop></d:propfind>`,
        );
        const doc = await dav("PROPFIND", cardHome, "1", `<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>`);
        const book = all(doc, "response").find((r) => first(r, "addressbook") !== undefined);
        const href = book === undefined ? undefined : first(book, "href")?.textContent?.trim();
        if (href === undefined) throw new WatcherError("icloud: no address book");
        addressbook = new URL(href, cardHome).toString();
      }
      const doc = await dav(
        "REPORT",
        addressbook,
        "1",
        `<cr:addressbook-query xmlns:d="DAV:" xmlns:cr="urn:ietf:params:xml:ns:carddav"><d:prop>` +
          `<cr:address-data><cr:prop name="FN"/><cr:prop name="BDAY"/></cr:address-data></d:prop></cr:addressbook-query>`,
      );
      const birthdays: Birthday[] = [];
      for (const data of all(doc, "address-data")) {
        const text = data.textContent ?? "";
        const name = /^FN[^:]*:(.*)$/m.exec(text)?.[1]?.trim();
        const bday = /^BDAY([^:]*):(?:(\d{4})-?|--)(\d{2})-?(\d{2})/m.exec(text);
        if (name === undefined || bday === null) continue;
        const omitYear = /X-APPLE-OMIT-YEAR/i.test(bday[1] ?? "");
        const year = bday[2] === undefined || omitYear ? undefined : Number(bday[2]);
        birthdays.push({ name, month: Number(bday[3]), day: Number(bday[4]), year });
      }
      return birthdays;
    },
  };
}

export type ICloudSource = ReturnType<typeof createICloudSource>;
