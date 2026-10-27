import { wallClockOf } from "@dsptchr/core";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n: number): string => String(n).padStart(2, "0");

// "Wed 28.10. 09:00" in the instance time zone.
export function formatDue(instant: number, timeZone: string): string {
  const w = wallClockOf(instant, timeZone);
  return `${WEEKDAYS[w.weekday] ?? ""} ${pad(w.day)}.${pad(w.month)}. ${pad(w.hour)}:${pad(w.minute)}`;
}
