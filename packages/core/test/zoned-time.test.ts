import { describe, expect, it } from "vitest";
import { wallClockToUtc, wallClockOf } from "../src/zoned-time.ts";

const BERLIN = "Europe/Berlin";

describe("wallClockToUtc", () => {
  it("converts winter time (UTC+1)", () => {
    expect(new Date(wallClockToUtc({ year: 2026, month: 1, day: 15, hour: 9, minute: 0 }, BERLIN)).toISOString()).toBe(
      "2026-01-15T08:00:00.000Z",
    );
  });

  it("converts summer time (UTC+2)", () => {
    expect(new Date(wallClockToUtc({ year: 2026, month: 7, day: 1, hour: 9, minute: 30 }, BERLIN)).toISOString()).toBe(
      "2026-07-01T07:30:00.000Z",
    );
  });

  it("moves a time inside the spring-forward gap to after the gap", () => {
    // 2026-03-29 02:30 does not exist in Berlin.
    expect(new Date(wallClockToUtc({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, BERLIN)).toISOString()).toBe(
      "2026-03-29T01:30:00.000Z",
    );
  });

  it("picks the first occurrence of an ambiguous fall-back time", () => {
    // 2026-10-25 02:30 happens twice in Berlin; the first one is still UTC+2.
    expect(new Date(wallClockToUtc({ year: 2026, month: 10, day: 25, hour: 2, minute: 30 }, BERLIN)).toISOString()).toBe(
      "2026-10-25T00:30:00.000Z",
    );
  });

  it("works for UTC", () => {
    expect(wallClockToUtc({ year: 2026, month: 2, day: 28, hour: 23, minute: 59 }, "UTC")).toBe(
      Date.UTC(2026, 1, 28, 23, 59),
    );
  });
});

describe("wallClockOf", () => {
  it("returns the local wall clock of an instant", () => {
    expect(wallClockOf(Date.parse("2026-10-27T11:49:00Z"), BERLIN)).toEqual({
      year: 2026,
      month: 10,
      day: 27,
      hour: 12,
      minute: 49,
      weekday: 2,
    });
  });
});
