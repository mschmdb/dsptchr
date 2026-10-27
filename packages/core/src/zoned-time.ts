export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// weekday: 0 = Sunday … 6 = Saturday
export function wallClockOf(instant: number, timeZone: string): WallClock & { weekday: number } {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(instant).map((p) => [p.type, p.value]));
  return {
    year: Number(parts["year"]),
    month: Number(parts["month"]),
    day: Number(parts["day"]),
    hour: Number(parts["hour"]),
    minute: Number(parts["minute"]),
    weekday: WEEKDAYS.indexOf(parts["weekday"] ?? ""),
  };
}

function offsetAt(instant: number, timeZone: string): number {
  const w = wallClockOf(instant, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  return asUtc - Math.floor(instant / 60_000) * 60_000;
}

// Gaps (spring forward) resolve to the instant after the gap; ambiguous times
// (fall back) resolve to the first occurrence.
export function wallClockToUtc(wall: WallClock, timeZone: string): number {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const offsetBefore = offsetAt(naive - 12 * 3_600_000, timeZone);
  const offsetAfter = offsetAt(naive + 12 * 3_600_000, timeZone);
  const candidates = [naive - offsetBefore, naive - offsetAfter].sort((a, b) => a - b);
  for (const candidate of candidates) {
    if (naive - offsetAt(candidate, timeZone) === candidate) {
      return candidate;
    }
  }
  return naive - offsetBefore;
}

export function isValidDate(year: number, month: number, day: number): boolean {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

export function addDays(wall: WallClock, days: number): WallClock {
  const d = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days));
  return { ...wall, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}
