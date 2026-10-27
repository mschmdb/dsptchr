import { describe, expect, it } from "vitest";
import { openStore } from "../src/index.ts";

const T0 = Date.parse("2026-10-27T10:00:00Z");

function setup() {
  const clock = { now: T0 };
  return { store: openStore({ path: ":memory:", now: () => clock.now }), clock };
}

describe("observations", () => {
  it("reports new, changed and unchanged observations", () => {
    const { store } = setup();
    expect(store.observations.observe({ source: "health", externalId: "host-a:disk", version: "warn", data: { a: 1 } }).status).toBe("new");
    expect(store.observations.observe({ source: "health", externalId: "host-a:disk", version: "warn", data: { a: 2 } }).status).toBe(
      "unchanged",
    );
    const changed = store.observations.observe({ source: "health", externalId: "host-a:disk", version: "crit", data: { a: 3 } });
    expect(changed).toMatchObject({ status: "changed", previousVersion: "warn", item: { version: "crit", data: { a: 3 } } });
  });

  it("keeps sources apart", () => {
    const { store } = setup();
    store.observations.observe({ source: "health", externalId: "x", version: "1", data: {} });
    expect(store.observations.observe({ source: "github", externalId: "x", version: "1", data: {} }).status).toBe("new");
  });

  it("lists open items of a source and resolves them", () => {
    const { store, clock } = setup();
    store.observations.observe({ source: "health", externalId: "a", version: "warn", data: {} });
    store.observations.observe({ source: "health", externalId: "b", version: "crit", data: {} });
    clock.now += 1000;
    store.observations.resolve("health", "a");

    expect(store.observations.listOpen("health").map((i) => i.externalId)).toEqual(["b"]);
    expect(store.observations.get("health", "a")).toMatchObject({ state: "resolved", resolvedAt: T0 + 1000 });
  });

  it("reopens a resolved item as new when it shows up again", () => {
    const { store } = setup();
    store.observations.observe({ source: "health", externalId: "a", version: "warn", data: {} });
    store.observations.resolve("health", "a");
    expect(store.observations.observe({ source: "health", externalId: "a", version: "warn", data: {} }).status).toBe("new");
    expect(store.observations.get("health", "a")?.state).toBe("open");
  });

  it("audits new, changed and resolved items without their data", () => {
    const { store } = setup();
    store.observations.observe({ source: "health", externalId: "a", version: "warn", data: { text: "secret detail" } });
    store.observations.observe({ source: "health", externalId: "a", version: "crit", data: { text: "secret detail" } });
    store.observations.resolve("health", "a");
    const audit = store.audit.list();
    expect(audit.map((e) => e.event)).toEqual(["observation.new", "observation.changed", "observation.resolved"]);
    expect(JSON.stringify(audit)).not.toContain("secret detail");
  });
});
