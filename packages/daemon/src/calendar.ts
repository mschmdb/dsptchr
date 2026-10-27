import { addDays, wallClockOf, wallClockToUtc, type WallClock } from "@dsptchr/core";
import type { Store } from "@dsptchr/store";
import { sanitizeUntrusted, type CalendarEvent } from "@dsptchr/watchers";
import { claimRun } from "./alerts.ts";

export const CALENDAR_SOURCE = "calendar";
const SOURCE = CALENDAR_SOURCE;
const MAX_TITLE = 80;

export interface CalendarMonitorDeps {
  store: Store;
  fetchEvents(range: { after: string; before: string }): Promise<CalendarEvent[]>;
  ownAddresses: readonly string[];
  intervalMs: number;
  now: () => number;
  timeZone: string;
  // Stored window around today; the model searches inside it.
  pastDays?: number;
  futureDays?: number;
}

const MAX_RESULTS = 50;

interface EventData {
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  own: boolean;
}

const pad = (n: number): string => String(n).padStart(2, "0");
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const day = (w: WallClock): string => `${w.year}-${pad(w.month)}-${pad(w.day)}`;

// Keeps today's and tomorrow's events in the store for briefings, /calendar and the model.
// Titles of invitations come from other people: the operator sees them, the model does not.
export function createCalendarMonitor(deps: CalendarMonitorDeps) {
  const { store, now, timeZone } = deps;
  const own = new Set(deps.ownAddresses.map((a) => a.toLowerCase()));

  function dayBounds(offset: number): [number, number] {
    const today = { ...wallClockOf(now(), timeZone), hour: 0, minute: 0 };
    return [wallClockToUtc(addDays(today, offset), timeZone), wallClockToUtc(addDays(today, offset + 1), timeZone)];
  }

  function eventsOn(offset: number): EventData[] {
    const [start, end] = dayBounds(offset);
    return store.observations
      .listOpen(SOURCE)
      .map((o) => o.data as EventData)
      .filter((e) => e.start < end && e.end > start)
      .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start);
  }

  function timeRange(e: EventData): string {
    const from = wallClockOf(e.start, timeZone);
    const to = wallClockOf(e.end, timeZone);
    return `${pad(from.hour)}:${pad(from.minute)}–${pad(to.hour)}:${pad(to.minute)}`;
  }

  function dateLabel(instant: number): string {
    const w = wallClockOf(instant, timeZone);
    return `${WEEKDAYS[w.weekday] ?? ""} ${pad(w.day)}.${pad(w.month)}.${w.year}`;
  }

  return {
    async tick(): Promise<boolean> {
      if (!claimRun(store, SOURCE, deps.intervalMs, now())) return false;
      const today = wallClockOf(now(), timeZone);
      const events = await deps.fetchEvents({
        after: day(addDays(today, -(deps.pastDays ?? 0))),
        before: day(addDays(today, deps.futureDays ?? 1)),
      });
      const seen = new Set<string>();
      store.transaction(() => {
        for (const event of events) {
          if (event.cancelled) continue;
          seen.add(event.key);
          const data: EventData = {
            title: sanitizeUntrusted(event.title, MAX_TITLE),
            start: event.start,
            end: event.end,
            allDay: event.allDay,
            // Own only when positively established: no organizer at all means a private event,
            // a missing field means unknown.
            own: event.organizer !== undefined && (event.organizer === "" || own.has(event.organizer.toLowerCase())),
          };
          store.observations.observe({ source: SOURCE, externalId: event.key, version: `${event.start}-${event.end}`, data });
        }
        for (const open of store.observations.listOpen(SOURCE)) {
          if (!seen.has(open.externalId)) store.observations.resolve(SOURCE, open.externalId);
        }
      });
      return true;
    },

    // One briefing line, or nothing for a free day.
    today(): string[] {
      const events = eventsOn(0);
      if (events.length === 0) return [];
      return [`Today: ${events.map((e) => `${e.allDay ? "all day" : timeRange(e)} ${e.title}`).join("; ")}.`];
    },

    lines(offset: number): string[] {
      return eventsOn(offset).map((e) => `- ${e.allDay ? "all day" : timeRange(e)} ${e.title}`);
    },

    // Search own event titles; invitations match no query but show as "(invitation)" in plain listings.
    search(input: { query?: string | null | undefined; from: string; to: string }): {
      events: { date: string; time: string; title: string }[];
      truncated: boolean;
      window: { from: string; to: string };
    } {
      const toMs = (date: string, offset: number): number => {
        const [year = 0, month = 0, dayOfMonth = 0] = date.split("-").map(Number);
        return wallClockToUtc(addDays({ year, month, day: dayOfMonth, hour: 0, minute: 0 }, offset), timeZone);
      };
      const from = toMs(input.from, 0);
      const to = toMs(input.to, 1);
      const query = input.query?.trim().toLowerCase() ?? "";
      const matches = store.observations
        .listOpen(SOURCE)
        .map((o) => o.data as EventData)
        .filter((e) => e.start < to && e.end > from)
        .filter((e) => query === "" || (e.own && e.title.toLowerCase().includes(query)))
        .sort((a, b) => b.start - a.start);
      const today = wallClockOf(now(), timeZone);
      return {
        events: matches.slice(0, MAX_RESULTS).map((e) => ({
          date: dateLabel(e.start),
          time: e.allDay ? "all day" : timeRange(e),
          title: e.own ? e.title : "(invitation)",
        })),
        truncated: matches.length > MAX_RESULTS,
        window: { from: day(addDays(today, -(deps.pastDays ?? 0))), to: day(addDays(today, deps.futureDays ?? 1)) },
      };
    },

    forModel(): { day: "today" | "tomorrow"; time: string; title: string }[] {
      return ([0, 1] as const).flatMap((offset) =>
        eventsOn(offset).map((e) => ({
          day: offset === 0 ? ("today" as const) : ("tomorrow" as const),
          time: e.allDay ? "all day" : timeRange(e),
          title: e.own ? e.title : "(invitation)",
        })),
      );
    },
  };
}

export type CalendarMonitor = ReturnType<typeof createCalendarMonitor>;
