import { describe, expect, it } from "vitest";
import { openStore } from "../src/index.ts";

const T0 = Date.parse("2026-10-27T10:00:00Z");

function setup() {
  const clock = { now: T0 };
  return { store: openStore({ path: ":memory:", now: () => clock.now }), clock };
}

describe("conversation", () => {
  it("returns the most recent turns in chronological order", () => {
    const { store, clock } = setup();
    for (let i = 0; i < 5; i++) {
      store.conversation.append({ role: "operator", text: `q${i}` });
      clock.now += 1000;
      store.conversation.append({ role: "assistant", text: `a${i}` });
      clock.now += 1000;
    }
    expect(store.conversation.recent(4).map((t) => t.text)).toEqual(["q3", "a3", "q4", "a4"]);
  });

  it("drops turns older than the given age", () => {
    const { store, clock } = setup();
    store.conversation.append({ role: "operator", text: "old" });
    clock.now += 3 * 3_600_000;
    store.conversation.append({ role: "operator", text: "new" });
    expect(store.conversation.recent(10, { since: clock.now - 3_600_000 }).map((t) => t.text)).toEqual(["new"]);
  });

  it("purges turns before a point in time", () => {
    const { store, clock } = setup();
    store.conversation.append({ role: "operator", text: "old" });
    clock.now += 10_000;
    store.conversation.append({ role: "operator", text: "new" });
    expect(store.conversation.purgeBefore(T0 + 5_000)).toBe(1);
    expect(store.conversation.recent(10).map((t) => t.text)).toEqual(["new"]);
  });
});

describe("runs", () => {
  it("records model runs and sums today's cost", () => {
    const { store, clock } = setup();
    store.runs.record({ role: "orchestrator", model: "m", inputTokens: 100, outputTokens: 50, costUsd: 0.25, outcome: "ok" });
    clock.now += 1000;
    store.runs.record({ role: "orchestrator", model: "m", inputTokens: 10, outputTokens: 5, costUsd: 0.5, outcome: "error" });
    expect(store.runs.costSince(T0)).toBeCloseTo(0.75);
    expect(store.runs.costSince(T0 + 1)).toBeCloseTo(0.5);
  });

  it("audits runs without content", () => {
    const { store } = setup();
    store.runs.record({ role: "orchestrator", model: "m", inputTokens: 1, outputTokens: 1, costUsd: 0.01, outcome: "ok" });
    expect(store.audit.list().map((e) => e.event)).toEqual(["run.recorded"]);
  });
});
