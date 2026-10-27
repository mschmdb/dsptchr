import { describe, expect, it } from "vitest";
import { parseDue, splitTodoInput } from "../src/due.ts";

const TZ = "Europe/Berlin";
// Tuesday 2026-10-27 12:49 in Berlin (UTC+1).
const NOW = Date.parse("2026-10-27T11:49:00Z");
const iso = (ms: number | undefined): string | undefined => (ms === undefined ? undefined : new Date(ms).toISOString());

describe("parseDue", () => {
  it.each([
    ["in 30m", "2026-10-27T12:19:00.000Z"],
    ["in 30 min", "2026-10-27T12:19:00.000Z"],
    ["in 2h", "2026-10-27T13:49:00.000Z"],
    ["in 3d", "2026-10-30T11:49:00.000Z"],
    ["18:00", "2026-10-27T17:00:00.000Z"],
    ["9:15", "2026-10-28T08:15:00.000Z"],
    ["12:49", "2026-10-28T11:49:00.000Z"],
    ["heute 20:00", "2026-10-27T19:00:00.000Z"],
    ["today 20:00", "2026-10-27T19:00:00.000Z"],
    ["morgen", "2026-10-28T08:00:00.000Z"],
    ["Tomorrow 7:30", "2026-10-28T06:30:00.000Z"],
    ["2026-11-02", "2026-11-02T08:00:00.000Z"],
    ["2026-11-02 14:00", "2026-11-02T13:00:00.000Z"],
    ["2.11.", "2026-11-02T08:00:00.000Z"],
    ["02.11.2026 14:00", "2026-11-02T13:00:00.000Z"],
    ["1.3.", "2027-03-01T08:00:00.000Z"],
  ])("%s", (input, expected) => {
    expect(iso(parseDue(input, NOW, TZ))).toBe(expected);
  });

  it.each(["", "soon", "in 0h", "in -2h", "25:00", "12:60", "2026-02-30", "31.04.", "heute 10:00", "2025-01-01", "in 9999d"])(
    "rejects %j",
    (input) => {
      expect(parseDue(input, NOW, TZ)).toBeUndefined();
    },
  );
});

describe("splitTodoInput", () => {
  it("splits text and due expression at the last @", () => {
    expect(splitTodoInput("Mail an user@example.com schreiben @ morgen 9:00")).toEqual({
      text: "Mail an user@example.com schreiben",
      due: "morgen 9:00",
    });
  });

  it("returns only text without a due expression", () => {
    expect(splitTodoInput("  Milch kaufen ")).toEqual({ text: "Milch kaufen" });
  });

  it("treats an @ inside a word as text", () => {
    expect(splitTodoInput("ping user@example.com")).toEqual({ text: "ping user@example.com" });
  });

  it("returns empty text for blank input", () => {
    expect(splitTodoInput("   ")).toEqual({ text: "" });
  });
});
