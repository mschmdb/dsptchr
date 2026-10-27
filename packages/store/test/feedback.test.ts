import { describe, expect, it } from "vitest";
import { openStore } from "../src/index.ts";

const T0 = Date.parse("2026-10-27T10:00:00Z");

function setup() {
  const clock = { now: T0 };
  let n = 0;
  return { store: openStore({ path: ":memory:", now: () => clock.now, newId: () => `id-${++n}` }), clock };
}

const mailFeatures = { source: "mail", category: "newsletter", domain: "example.com" };

describe("notified items", () => {
  it("registers an item once and returns a short stable reference", () => {
    const { store } = setup();
    const a = store.feedback.register({ source: "mail", externalId: "m1", features: mailFeatures, label: "Weekly deals" });
    const again = store.feedback.register({ source: "mail", externalId: "m1", features: mailFeatures, label: "Weekly deals" });
    expect(a.ref).toMatch(/^[a-z0-9]{6,10}$/);
    expect(again.ref).toBe(a.ref);
    expect(store.feedback.item(a.ref)).toMatchObject({ source: "mail", externalId: "m1", features: mailFeatures, label: "Weekly deals" });
  });
});

describe("feedback events", () => {
  it("records verdicts and summarizes them by feature", () => {
    const { store } = setup();
    const a = store.feedback.register({ source: "mail", externalId: "m1", features: mailFeatures, label: "x" });
    const b = store.feedback.register({ source: "mail", externalId: "m2", features: mailFeatures, label: "y" });
    store.feedback.record(a.ref, "irrelevant");
    store.feedback.record(b.ref, "irrelevant");
    store.feedback.record(b.ref, "relevant");
    expect(store.feedback.summary()).toEqual([
      { features: mailFeatures, relevant: 1, irrelevant: 2 },
    ]);
    expect(store.audit.list().filter((e) => e.event === "feedback.recorded")).toHaveLength(3);
  });

  it("rejects unknown references and verdicts", () => {
    const { store } = setup();
    expect(() => store.feedback.record("nope", "relevant")).toThrow(/unknown/);
  });
});

describe("rules", () => {
  it("proposes, activates and matches mute rules", () => {
    const { store } = setup();
    const rule = store.rules.propose({ match: { source: "mail", domain: "example.com" }, origin: "button" });
    expect(rule.state).toBe("proposed");
    expect(store.rules.mutes({ source: "mail", domain: "example.com", category: "newsletter" })).toBe(false);

    store.rules.decide(rule.id, "active", "operator");
    expect(store.rules.mutes({ source: "mail", domain: "example.com", category: "newsletter" })).toBe(true);
    expect(store.rules.mutes({ source: "mail", domain: "other.example.com" })).toBe(false);
    expect(store.rules.active()).toEqual([expect.objectContaining({ id: rule.id, match: { source: "mail", domain: "example.com" } })]);
  });

  it("only changes a proposed rule once and audits the decision", () => {
    const { store } = setup();
    const rule = store.rules.propose({ match: { source: "github", repo: "owner-a/repo-a" }, origin: "chat" });
    store.rules.decide(rule.id, "rejected", "operator");
    expect(() => store.rules.decide(rule.id, "active", "operator")).toThrow(/not proposed/);
    expect(store.audit.list().map((e) => e.event)).toEqual(["rule.proposed", "rule.rejected"]);
  });

  it("refuses empty matches", () => {
    const { store } = setup();
    expect(() => store.rules.propose({ match: {}, origin: "chat" })).toThrow(/empty/);
  });
});
