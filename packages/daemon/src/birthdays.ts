import { addDays, isValidDate, wallClockOf } from "@dsptchr/core";
import type { Store } from "@dsptchr/store";
import { sanitizeUntrusted, type Birthday } from "@dsptchr/watchers";
import { claimRun, cursorsFor } from "./alerts.ts";

export const BIRTHDAY_SOURCE = "birthdays";

export interface BirthdayMonitorDeps {
  store: Store;
  fetchBirthdays(): Promise<Birthday[]>;
  intervalMs: number;
  now: () => number;
  timeZone: string;
}

// Birthdays from the operator's contacts, refreshed twice a day and kept in the store.
export function createBirthdayMonitor(deps: BirthdayMonitorDeps) {
  const { store, now, timeZone } = deps;
  const cursors = cursorsFor(store, BIRTHDAY_SOURCE);

  const stored = (): Birthday[] => {
    const raw = cursors.get("list");
    return raw === undefined ? [] : (JSON.parse(raw) as Birthday[]);
  };

  // 29 February falls on 28 February in non-leap years.
  const fallsOn = (b: Birthday, year: number, month: number, day: number): boolean => {
    if (b.month === 2 && b.day === 29 && !isValidDate(year, 2, 29)) return month === 2 && day === 28;
    return b.month === month && b.day === day;
  };

  function on(offset: number): { name: string; age?: number }[] {
    const date = addDays({ ...wallClockOf(now(), timeZone), hour: 0, minute: 0 }, offset);
    return stored()
      .filter((b) => fallsOn(b, date.year, date.month, date.day))
      .map((b) => (b.year === undefined ? { name: b.name } : { name: b.name, age: date.year - b.year }));
  }

  const label = (b: { name: string; age?: number }): string => (b.age === undefined ? b.name : `${b.name} (${b.age})`);

  return {
    async tick(): Promise<boolean> {
      if (!claimRun(store, BIRTHDAY_SOURCE, deps.intervalMs, now())) return false;
      const list = (await deps.fetchBirthdays()).map((b) => ({ ...b, name: sanitizeUntrusted(b.name, 80) }));
      cursors.set("list", JSON.stringify(list));
      return true;
    },

    briefing(): string[] {
      const today = on(0);
      const tomorrow = on(1);
      if (today.length === 0 && tomorrow.length === 0) return [];
      const parts = [
        ...(today.length === 0 ? [] : [`today ${today.map(label).join(", ")}`]),
        ...(tomorrow.length === 0 ? [] : [`tomorrow ${tomorrow.map(label).join(", ")}`]),
      ];
      return [`Birthdays: ${parts.join("; ")}.`];
    },

    forModel(): { day: "today" | "tomorrow"; name: string; age?: number }[] {
      return [
        ...on(0).map((b) => ({ day: "today" as const, ...b })),
        ...on(1).map((b) => ({ day: "tomorrow" as const, ...b })),
      ];
    },
  };
}

export type BirthdayMonitor = ReturnType<typeof createBirthdayMonitor>;
