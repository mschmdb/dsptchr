import { wallClockOf } from "@dsptchr/core";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n: number): string => String(n).padStart(2, "0");

// "Wed 28.10. 09:00" in the instance time zone.
export function formatDue(instant: number, timeZone: string): string {
  const w = wallClockOf(instant, timeZone);
  return `${WEEKDAYS[w.weekday] ?? ""} ${pad(w.day)}.${pad(w.month)}. ${pad(w.hour)}:${pad(w.minute)}`;
}

// "Tue 27.10.2026 11:00 (Europe/Berlin, UTC+01:00)": the model's sense of "now".
export function formatNow(instant: number, timeZone: string): string {
  const w = wallClockOf(instant, timeZone);
  const offsetMinutes = Math.round((Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - Math.floor(instant / 60_000) * 60_000) / 60_000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const offset = `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return `${WEEKDAYS[w.weekday] ?? ""} ${pad(w.day)}.${pad(w.month)}.${w.year} ${pad(w.hour)}:${pad(w.minute)} (${timeZone}, ${offset})`;
}
