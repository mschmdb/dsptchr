import { describe, expect, it } from "vitest";
import { openStore } from "../src/index.ts";

const T0 = Date.parse("2026-10-27T10:00:00Z");

function setup() {
  const clock = { now: T0 };
  let n = 0;
  return { store: openStore({ path: ":memory:", now: () => clock.now, newId: () => `q${++n}` }), clock };
}

const item = (externalId: string, urgent = false) => ({
  source: "mail",
  externalId,
  text: `- mail ${externalId}`,
  urgent,
  features: { source: "mail", category: "important", domain: "example.com" },
  label: `mail ${externalId}`,
});

describe("triage queue", () => {
  it("queues items once and lists pending ones oldest first", () => {
    const { store, clock } = setup();
    store.triage.enqueue(item("m1"));
    clock.now += 1000;
    store.triage.enqueue(item("m2", true));
    store.triage.enqueue(item("m1"));
    expect(store.triage.pending().map((i) => [i.externalId, i.urgent])).toEqual([
      ["m1", false],
      ["m2", true],
    ]);
    expect(store.triage.hasUrgent()).toBe(true);
  });

  it("settles items as notified, briefing or dropped", () => {
    const { store } = setup();
    const a = store.triage.enqueue(item("m1"));
    const b = store.triage.enqueue(item("m2"));
    const c = store.triage.enqueue(item("m3"));
    store.triage.settle([a.id], "notified");
    store.triage.settle([b.id], "briefing");
    store.triage.settle([c.id], "dropped");
    expect(store.triage.pending()).toEqual([]);
    expect(store.triage.forBriefing().map((i) => i.externalId)).toEqual(["m2"]);
    store.triage.settle([b.id], "briefed");
    expect(store.triage.forBriefing()).toEqual([]);
  });

  it("only settles pending or briefing items", () => {
    const { store } = setup();
    const a = store.triage.enqueue(item("m1"));
    store.triage.settle([a.id], "dropped");
    store.triage.settle([a.id], "notified");
    expect(store.triage.get(a.id)?.state).toBe("dropped");
  });
});
