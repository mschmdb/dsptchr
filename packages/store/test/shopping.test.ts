import { describe, expect, it } from "vitest";
import { openStore } from "../src/index.ts";

const T0 = Date.parse("2026-10-28T10:00:00Z");

function setup() {
  const clock = { now: T0 };
  let n = 0;
  return { store: openStore({ path: ":memory:", now: () => clock.now, newId: () => `id-${++n}` }), clock };
}

describe("shopping list", () => {
  it("adds a one-off item as needed", () => {
    const { store } = setup();
    const item = store.shopping.add({ name: "Milch", actor: "operator" });
    expect(item).toMatchObject({ name: "Milch", kind: "once", state: "needed", quantity: undefined });
    expect(store.shopping.list()).toEqual([item]);
  });

  it("merges an item added twice and keeps the newest quantity", () => {
    const { store } = setup();
    const first = store.shopping.add({ name: "Gurken", quantity: "1", actor: "operator" });
    const again = store.shopping.add({ name: " gurken ", quantity: "2", actor: "operator" });
    expect(again.id).toBe(first.id);
    expect(again.quantity).toBe("2");
    expect(store.shopping.list()).toHaveLength(1);
  });

  it("puts a stocked staple back on the list without downgrading it", () => {
    const { store } = setup();
    const staple = store.shopping.add({ name: "Kapern", kind: "empty", actor: "operator" });
    store.shopping.transition(staple.id, "stock", "operator");
    const again = store.shopping.add({ name: "Kapern", actor: "operator" });
    expect(again).toMatchObject({ id: staple.id, kind: "empty", state: "needed" });
  });

  it("changes the kind when one is given", () => {
    const { store } = setup();
    store.shopping.add({ name: "Skyr", actor: "operator" });
    expect(store.shopping.add({ name: "Skyr", kind: "every", actor: "operator" }).kind).toBe("every");
  });

  it("keeps a checked item checked when it is added again", () => {
    const { store } = setup();
    const item = store.shopping.add({ name: "Eier", actor: "operator" });
    store.shopping.transition(item.id, "check", "operator");
    expect(store.shopping.add({ name: "Eier", actor: "operator" }).state).toBe("checked");
  });

  it("rejects empty and overlong names", () => {
    const { store } = setup();
    expect(() => store.shopping.add({ name: "  ", actor: "operator" })).toThrow();
    expect(() => store.shopping.add({ name: "x".repeat(61), actor: "operator" })).toThrow();
  });

  it("checks and unchecks items", () => {
    const { store } = setup();
    const item = store.shopping.add({ name: "Eier", actor: "operator" });
    expect(store.shopping.transition(item.id, "check", "operator").state).toBe("checked");
    expect(store.shopping.transition(item.id, "uncheck", "operator").state).toBe("needed");
  });

  it("refuses transitions for unknown items", () => {
    const { store } = setup();
    expect(() => store.shopping.transition("nope", "check", "operator")).toThrow(/not found/);
  });

  it("removes an item", () => {
    const { store } = setup();
    const item = store.shopping.add({ name: "Eier", actor: "operator" });
    store.shopping.remove(item.id, "operator");
    expect(store.shopping.get(item.id)).toBeUndefined();
    expect(() => store.shopping.remove(item.id, "operator")).toThrow(/not found/);
  });

  it("finishes a trip: bought one-offs go, staples return to their rhythm, open items stay", () => {
    const { store } = setup();
    const milk = store.shopping.add({ name: "Milch", actor: "operator" });
    const bread = store.shopping.add({ name: "Brot", actor: "operator" });
    const skyr = store.shopping.add({ name: "Skyr", kind: "every", actor: "operator" });
    const capers = store.shopping.add({ name: "Kapern", kind: "empty", actor: "operator" });
    for (const id of [milk.id, skyr.id, capers.id]) store.shopping.transition(id, "check", "operator");

    expect(store.shopping.finishTrip("operator")).toEqual({ bought: 3, open: 2 });
    expect(store.shopping.get(milk.id)).toBeUndefined();
    expect(store.shopping.get(bread.id)?.state).toBe("needed");
    expect(store.shopping.get(skyr.id)?.state).toBe("needed");
    expect(store.shopping.get(capers.id)?.state).toBe("stocked");
  });

  it("lists items in the order they were added", () => {
    const { store, clock } = setup();
    store.shopping.add({ name: "B", actor: "operator" });
    clock.now += 1000;
    store.shopping.add({ name: "A", actor: "operator" });
    store.shopping.add({ name: "C", actor: "operator" });
    expect(store.shopping.list().map((i) => i.name)).toEqual(["B", "A", "C"]);
  });

  it("audits ids and states but never item names", () => {
    const { store } = setup();
    const item = store.shopping.add({ name: "Geheimzutat", actor: "operator" });
    store.shopping.transition(item.id, "check", "operator");
    store.shopping.finishTrip("operator");
    const entries = store.audit.list();
    expect(entries.map((e) => e.event)).toEqual(["shopping.added", "shopping.check", "shopping.trip_finished"]);
    expect(JSON.stringify(entries)).not.toContain("Geheimzutat");
  });
});
