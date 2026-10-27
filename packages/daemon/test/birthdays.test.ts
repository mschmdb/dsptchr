import type { Birthday } from "@dsptchr/watchers";
import { describe, expect, it } from "vitest";
import { createBirthdayMonitor } from "../src/birthdays.ts";
import { harness, TZ } from "./support/harness.ts";

// T0 = Tue 27.10.2026 11:00 Berlin
function setup(list: Birthday[]) {
  const h = harness();
  let calls = 0;
  const monitor = createBirthdayMonitor({
    store: h.store,
    fetchBirthdays: async () => {
      calls++;
      return list;
    },
    intervalMs: 12 * 3_600_000,
    now: () => h.clock.now,
    timeZone: TZ,
  });
  return { ...h, monitor, calls: () => calls };
}

describe("birthday monitor", () => {
  it("lists today's and tomorrow's birthdays with age when the year is known", async () => {
    const h = setup([
      { name: "Anna Example", month: 10, day: 27, year: 1990 },
      { name: "Ben Example", month: 10, day: 28, year: undefined },
      { name: "Cara Example", month: 12, day: 1, year: 1980 },
    ]);
    await h.monitor.tick();
    expect(h.monitor.briefing()).toEqual(["Birthdays: today Anna Example (36); tomorrow Ben Example."]);
    expect(h.monitor.forModel()).toEqual([
      { day: "today", name: "Anna Example", age: 36 },
      { day: "tomorrow", name: "Ben Example" },
    ]);
  });

  it("handles 29 February in non-leap years on 28 February", async () => {
    const h = setup([{ name: "Leap Example", month: 2, day: 29, year: 2000 }]);
    h.clock.now = Date.parse("2027-02-28T10:00:00Z");
    await h.monitor.tick();
    expect(h.monitor.briefing()).toEqual(["Birthdays: today Leap Example (27)."]);
  });

  it("says nothing when no birthday is near", async () => {
    const h = setup([{ name: "Cara Example", month: 12, day: 1, year: 1980 }]);
    await h.monitor.tick();
    expect(h.monitor.briefing()).toEqual([]);
  });

  it("refreshes at most once per interval", async () => {
    const h = setup([{ name: "Anna Example", month: 10, day: 27, year: 1990 }]);
    await h.monitor.tick();
    await h.monitor.tick();
    expect(h.calls()).toBe(1);
  });

  it("sanitizes names", async () => {
    const h = setup([{ name: "Anna‮\nExample", month: 10, day: 27, year: undefined }]);
    await h.monitor.tick();
    expect(h.monitor.briefing()).toEqual(["Birthdays: today Anna Example."]);
  });
});
