import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openStore } from "../src/index.ts";

const T0 = Date.parse("2026-10-27T10:00:00Z");

function setup() {
  const clock = { now: T0 };
  const store = openStore({ path: ":memory:", now: () => clock.now });
  return { store, clock };
}

const entry = (id: string, receivedAt = T0) => ({ id, receivedAt, payload: { kind: "text", text: `msg ${id}` } });

describe("inbox", () => {
  it("accepts entries once and returns them in arrival order", () => {
    const { store } = setup();
    expect(store.inbox.accept([entry("b", T0 + 1), entry("a", T0)])).toBe(2);
    expect(store.inbox.accept([entry("a")])).toBe(0);

    expect(store.inbox.due().map((e) => e.id)).toEqual(["a", "b"]);
    expect(store.inbox.due()[0]).toMatchObject({ id: "a", payload: { kind: "text", text: "msg a" }, attempts: 0 });
  });

  it("does not re-accept an entry that is already done", () => {
    const { store } = setup();
    store.inbox.accept([entry("a")]);
    store.inbox.markDone("a");
    expect(store.inbox.accept([entry("a")])).toBe(0);
    expect(store.inbox.due()).toEqual([]);
  });

  it("retries failed entries after the retry time", () => {
    const { store, clock } = setup();
    store.inbox.accept([entry("a")]);

    expect(store.inbox.markFailed("a", { maxAttempts: 3, retryAt: T0 + 60_000, error: "SqliteError" })).toBe("pending");
    expect(store.inbox.due()).toEqual([]);
    clock.now = T0 + 60_000;
    expect(store.inbox.due()).toMatchObject([{ id: "a", attempts: 1 }]);
  });

  it("moves an entry to dead after the last attempt and audits it", () => {
    const { store, clock } = setup();
    store.inbox.accept([entry("a")]);
    store.inbox.markFailed("a", { maxAttempts: 2, retryAt: T0, error: "E1" });
    expect(store.inbox.markFailed("a", { maxAttempts: 2, retryAt: T0, error: "E2" })).toBe("dead");

    clock.now = T0 + 10 * 60_000;
    expect(store.inbox.due()).toEqual([]);
    expect(store.inbox.get("a")).toMatchObject({ state: "dead", attempts: 2, lastError: "E2" });
    expect(store.audit.list({ subject: "a" }).map((e) => e.event)).toEqual([
      "inbox.accepted",
      "inbox.retry",
      "inbox.dead",
    ]);
  });

  it("never writes the payload into the audit log", () => {
    const { store } = setup();
    store.inbox.accept([entry("a")]);
    store.inbox.markFailed("a", { maxAttempts: 1, retryAt: T0, error: "E" });
    expect(JSON.stringify(store.audit.list())).not.toContain("msg a");
  });

  it("purges payloads of done entries but keeps their IDs for dedupe", () => {
    const { store, clock } = setup();
    store.inbox.accept([entry("old"), entry("new")]);
    store.inbox.markDone("old");
    clock.now = T0 + 8 * 86_400_000;
    store.inbox.markDone("new");

    expect(store.inbox.purgeDone(T0 + 7 * 86_400_000)).toBe(1);
    expect(store.inbox.get("old")).toMatchObject({ state: "done", payload: undefined });
    expect(store.inbox.get("new")?.payload).toBeDefined();
    expect(store.inbox.accept([entry("old")])).toBe(0);
  });

  it("limits the batch size", () => {
    const { store } = setup();
    store.inbox.accept([entry("a"), entry("b"), entry("c")]);
    expect(store.inbox.due(2)).toHaveLength(2);
  });

  it("survives a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "dsptchr-inbox-"));
    try {
      const path = join(dir, "state.db");
      const first = openStore({ path, now: () => T0 });
      first.inbox.accept([entry("a")]);
      first.close();
      const second = openStore({ path, now: () => T0 });
      expect(second.inbox.due().map((e) => e.id)).toEqual(["a"]);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
