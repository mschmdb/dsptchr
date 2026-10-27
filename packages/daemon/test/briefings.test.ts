import { describe, expect, it } from "vitest";
import { createBriefings } from "../src/briefings.ts";
import { harness, T0, TZ } from "./support/harness.ts";

// T0 is Tuesday 2026-10-27 11:00 Berlin (UTC+1).
const at = (iso: string): number => Date.parse(iso);

function setup(times = { morning: { hour: 7, minute: 30 }, evening: { hour: 17, minute: 30 } }) {
  const h = harness();
  const briefings = createBriefings({ store: h.store, dispatcher: h.dispatcher, timeZone: TZ, times, now: () => h.clock.now });
  const todo = (text: string, dueAt?: number) =>
    h.store.todos.create({ text, ...(dueAt === undefined ? {} : { dueAt }), actor: "operator" });
  return { ...h, briefings, todo };
}

describe("briefings", () => {
  it("sends nothing before the first slot of the day", async () => {
    const h = setup();
    h.clock.now = at("2026-10-27T06:00:00Z"); // 07:00 local
    expect(await h.briefings.tick()).toBe(0);
    expect(h.sent).toEqual([]);
  });

  it("sends the morning briefing once at its time", async () => {
    const h = setup();
    h.clock.now = at("2026-10-27T06:30:00Z"); // 07:30 local
    expect(await h.briefings.tick()).toBe(1);
    expect(await h.briefings.tick()).toBe(0);
    expect(h.sent).toHaveLength(1);
  });

  it("catches up a missed morning briefing once on the same day", async () => {
    const h = setup();
    h.clock.now = at("2026-10-27T09:00:00Z"); // 10:00 local, after waking
    expect(await h.briefings.tick()).toBe(1);
    expect(h.sent[0]?.text).toMatch(/^Good morning/);
  });

  it("does not send yesterday's missed evening briefing the next morning", async () => {
    const h = setup();
    h.clock.now = at("2026-10-27T06:00:00Z"); // 07:00 local, before today's morning slot
    expect(await h.briefings.tick()).toBe(0);
  });

  it("sends both briefings on a normal day and again the next day", async () => {
    const h = setup();
    h.clock.now = at("2026-10-27T06:30:00Z");
    await h.briefings.tick();
    h.clock.now = at("2026-10-27T16:30:00Z"); // 17:30 local
    await h.briefings.tick();
    h.clock.now = at("2026-10-28T06:30:00Z");
    await h.briefings.tick();
    expect(h.sent.map((m) => m.text.split("\n")[0])).toEqual(["Good morning.", "Evening check.", "Good morning."]);
  });

  it("lists overdue and today's todos in the morning, not tomorrow's", async () => {
    const h = setup();
    h.todo("Pay rent", at("2026-10-26T09:00:00Z"));
    h.todo("Water plants", at("2026-10-27T17:00:00Z"));
    h.todo("Call bank", at("2026-10-27T08:15:00Z"));
    h.todo("Dentist", at("2026-10-28T08:00:00Z"));
    h.todo("Someday");
    h.clock.now = at("2026-10-27T06:30:00Z");

    await h.briefings.tick();

    expect(h.sent[0]?.text).toBe(
      ["Good morning.", "Due today:", "- overdue: Pay rent", "- 09:15 Call bank", "- 18:00 Water plants", "1 more without a due date."].join("\n"),
    );
  });

  it("says so when nothing is due", async () => {
    const h = setup();
    h.clock.now = at("2026-10-27T06:30:00Z");
    await h.briefings.tick();
    expect(h.sent[0]?.text).toBe("Good morning.\nNothing due today.");
  });

  it("lists what is still open in the evening", async () => {
    const h = setup();
    const done = h.todo("Water plants", at("2026-10-27T08:00:00Z"));
    h.store.todos.transition(done.id, "complete", { actor: "operator" });
    h.todo("Call bank", at("2026-10-27T10:00:00Z"));
    h.clock.now = at("2026-10-27T16:30:00Z");
    await h.briefings.tick();
    expect(h.sent.at(-1)?.text).toBe("Evening check.\nStill open:\n- 11:00 Call bank");
  });

  it("reports an empty evening", async () => {
    const h = setup();
    h.clock.now = at("2026-10-27T16:30:00Z");
    await h.briefings.tick();
    expect(h.sent.at(-1)?.text).toBe("Evening check.\nNothing left open for today.");
  });

  it("holds briefings while paused and sends them after resume the same day", async () => {
    const h = setup();
    h.store.flags.setPaused(true, "operator");
    h.clock.now = at("2026-10-27T06:30:00Z");
    expect(await h.briefings.tick()).toBe(0);
    h.store.flags.setPaused(false, "operator");
    h.clock.now = at("2026-10-27T07:00:00Z");
    expect(await h.briefings.tick()).toBe(1);
  });

  it("does nothing without configured times", async () => {
    const h = setup({} as never);
    h.clock.now = T0;
    expect(await h.briefings.tick()).toBe(0);
  });
});
