import { addDays, isValidDate, wallClockOf, wallClockToUtc, type WallClock } from "./zoned-time.ts";

const DEFAULT_HOUR = 9;
const MAX_AHEAD_MS = 366 * 24 * 3_600_000;
const UNIT_MS: Record<string, number> = { m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000 };

const RELATIVE = /^in (\d{1,4}) ?(m|min|h|d)$/;
const TIME = /^(\d{1,2}):(\d{2})$/;
const DAY_WORD = /^(heute|today|morgen|tomorrow)(?: (\d{1,2}:\d{2}))?$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{1,2}:\d{2}))?$/;
const GERMAN_DATE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})?(?: (\d{1,2}:\d{2}))?$/;

// Deterministic fallback for explicit due expressions. The reader model handles
// free-form language; this parser only accepts unambiguous forms.
export function parseDue(input: string, now: number, timeZone: string): number | undefined {
  const text = input.trim().toLowerCase().replace(/\s+/g, " ");
  const due = parseExpression(text, now, timeZone);
  if (due === undefined || due <= now || due - now > MAX_AHEAD_MS) {
    return undefined;
  }
  return due;
}

function parseExpression(text: string, now: number, timeZone: string): number | undefined {
  const today = wallClockOf(now, timeZone);

  const relative = RELATIVE.exec(text);
  if (relative) {
    return now + Number(relative[1]) * (UNIT_MS[relative[2] ?? ""] ?? 0);
  }

  const time = TIME.exec(text);
  if (time) {
    const clock = parseClock(text);
    if (clock === undefined) return undefined;
    const todayAt = wallClockToUtc({ ...today, ...clock }, timeZone);
    return todayAt > now ? todayAt : wallClockToUtc(addDays({ ...today, ...clock }, 1), timeZone);
  }

  const dayWord = DAY_WORD.exec(text);
  if (dayWord) {
    const clock = dayWord[2] === undefined ? { hour: DEFAULT_HOUR, minute: 0 } : parseClock(dayWord[2]);
    if (clock === undefined) return undefined;
    const offset = dayWord[1] === "morgen" || dayWord[1] === "tomorrow" ? 1 : 0;
    return wallClockToUtc(addDays({ ...today, ...clock }, offset), timeZone);
  }

  const iso = ISO_DATE.exec(text);
  if (iso) {
    return atDate(Number(iso[1]), Number(iso[2]), Number(iso[3]), iso[4], timeZone);
  }

  const german = GERMAN_DATE.exec(text);
  if (german) {
    const day = Number(german[1]);
    const month = Number(german[2]);
    if (german[3] !== undefined) {
      return atDate(Number(german[3]), month, day, german[4], timeZone);
    }
    const thisYear = atDate(today.year, month, day, german[4], timeZone);
    if (thisYear === undefined || thisYear > now) return thisYear;
    return atDate(today.year + 1, month, day, german[4], timeZone);
  }

  return undefined;
}

function atDate(year: number, month: number, day: number, clockText: string | undefined, timeZone: string): number | undefined {
  if (!isValidDate(year, month, day)) return undefined;
  const clock = clockText === undefined ? { hour: DEFAULT_HOUR, minute: 0 } : parseClock(clockText);
  if (clock === undefined) return undefined;
  const wall: WallClock = { year, month, day, ...clock };
  return wallClockToUtc(wall, timeZone);
}

function parseClock(text: string): { hour: number; minute: number } | undefined {
  const match = TIME.exec(text);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return undefined;
  return { hour, minute };
}

export interface TodoInput {
  text: string;
  due?: string;
}

// "Call the bank @ morgen 9:00" -> text and due expression. Only " @ " with
// surrounding spaces separates, so mail addresses stay intact.
export function splitTodoInput(input: string): TodoInput {
  const trimmed = input.trim();
  const index = trimmed.lastIndexOf(" @ ");
  if (index === -1) {
    return { text: trimmed };
  }
  return { text: trimmed.slice(0, index).trim(), due: trimmed.slice(index + 3).trim() };
}
