import type { TriageDecision, TriageItemRef } from "@dsptchr/agents";
import { describe, expect, it } from "vitest";
import type { AlertLine } from "../src/alerts.ts";
import { createTriage } from "../src/triage.ts";
import { harness } from "./support/harness.ts";

// T0 = Tue 27.10.2026 11:00 Berlin, inside the default waking hours.
const line = (id: string, applied: string[], source = "mail"): AlertLine => ({
  text: `- ${source} ${id}`,
  apply: () => applied.push(id),
  feedback: { source, externalId: id, features: { source, category: "important", domain: "example.com" }, label: `${source} ${id}` },
});

function setup(decide: (items: readonly TriageItemRef[]) => TriageDecision | undefined | Error) {
  const h = harness();
  const runs: TriageItemRef[][] = [];
  const triage = createTriage({
    store: h.store,
    dispatcher: h.dispatcher,
    now: () => h.clock.now,
    timeZone: "Europe/Berlin",
    hours: { from: { hour: 8, minute: 0 }, to: { hour: 21, minute: 0 } },
    intervalMs: 60 * 60_000,
    run: async (items) => {
      runs.push([...items]);
      const result = decide(items);
      if (result instanceof Error) throw result;
      return result;
    },
  });
  return { ...h, triage, runs };
}

describe("triage runner", () => {
  it("records items when they are queued, not when they are sent", async () => {
    const h = setup(() => undefined);
    const applied: string[] = [];
    await h.triage.submit([line("m1", applied)], () => false);
    expect(applied).toEqual(["m1"]);
    expect(h.sent).toEqual([]);
  });

  it("runs on the interval and sends only what the model chose, with its intro", async () => {
    const h = setup((items) => ({
      notify: [items[0]?.ref ?? ""],
      briefing: [items[1]?.ref ?? ""],
      drop: [],
      message: "Eine Sache ist wichtig.",
    }));
    await h.triage.submit([line("m1", []), line("m2", [])], () => false);
    expect(await h.triage.tick()).toBe(true);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.text).toBe("Lagebild\nEine Sache ist wichtig.\n1. mail m1");
    expect(h.triage.briefing()).toEqual(["Since yesterday:", "- mail m2"]);
    expect(await h.triage.tick()).toBe(false);
  });

  it("waits for the interval unless something urgent arrives", async () => {
    const h = setup((items) => ({ notify: items.map((i) => i.ref), briefing: [], drop: [], message: null }));
    await h.triage.submit([line("m1", [])], () => false);
    await h.triage.tick();
    h.clock.now += 10 * 60_000;
    await h.triage.submit([line("m2", [])], () => false);
    expect(await h.triage.tick()).toBe(false);
    await h.triage.submit([line("m3", [])], () => true);
    expect(await h.triage.tick()).toBe(true);
    expect(h.runs.map((r) => r.map((i) => i.urgent))).toEqual([[false], [false, true]]);
  });

  it("stays quiet at night unless urgent, and catches up in the morning", async () => {
    const h = setup((items) => ({ notify: items.map((i) => i.ref), briefing: [], drop: [], message: null }));
    h.clock.now = Date.parse("2026-10-27T22:00:00Z"); // 23:00 local
    await h.triage.submit([line("m1", [])], () => false);
    expect(await h.triage.tick()).toBe(false);
    h.clock.now = Date.parse("2026-10-28T07:05:00Z"); // 08:05 local
    expect(await h.triage.tick()).toBe(true);
  });

  it("falls back to sending everything when the model gives no decision", async () => {
    const h = setup(() => new Error("overloaded"));
    await h.triage.submit([line("m1", []), line("m2", [])], () => false);
    await h.triage.tick();
    expect(h.sent[0]?.text).toBe("Lagebild\n1. mail m1\n2. mail m2");
  });

  it("drops muted items before the model sees them", async () => {
    const h = setup((items) => ({ notify: items.map((i) => i.ref), briefing: [], drop: [], message: null }));
    const rule = h.store.rules.propose({ match: { source: "mail", domain: "example.com" }, origin: "test" });
    h.store.rules.decide(rule.id, "active", "operator");
    await h.triage.submit([line("m1", [])], () => false);
    expect(await h.triage.tick()).toBe(false);
    expect(h.runs).toEqual([]);
  });

  it("sends lines without feedback directly", async () => {
    const h = setup(() => undefined);
    await h.triage.submit([{ text: "- resolved: host-a:disk", apply: () => {} }], () => false, "Server health");
    expect(h.sent).toEqual([{ text: "Server health\n- resolved: host-a:disk" }]);
  });

  it("marks briefing items as briefed once the briefing went out", async () => {
    const h = setup((items) => ({ notify: [], briefing: items.map((i) => i.ref), drop: [], message: null }));
    await h.triage.submit([line("m1", [])], () => false);
    await h.triage.tick();
    h.triage.briefed();
    expect(h.triage.briefing()).toEqual([]);
  });
});
