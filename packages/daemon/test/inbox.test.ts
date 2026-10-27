import type { InboundEvent } from "@dsptchr/channels";
import { openStore } from "@dsptchr/store";
import { describe, expect, it } from "vitest";
import { createInbox } from "../src/inbox.ts";
import { T0, text } from "./support/harness.ts";

function setup(handle: (event: InboundEvent) => Promise<void>, options: { maxAttempts?: number } = {}) {
  const clock = { now: T0 };
  const store = openStore({ path: ":memory:", now: () => clock.now });
  const dead: string[] = [];
  const inbox = createInbox({
    store,
    handle,
    now: () => clock.now,
    onDead: async (entryId) => {
      dead.push(entryId);
    },
    ...options,
  });
  return { store, clock, inbox, dead };
}

describe("inbox processor", () => {
  it("handles accepted events in arrival order and marks them done", async () => {
    const handled: string[] = [];
    const { inbox, store } = setup(async (event) => {
      handled.push(event.id);
    });
    const a = text("a");
    const b = text("b");

    inbox.accept([a, b]);
    expect(await inbox.drain()).toBe(2);

    expect(handled).toEqual([a.id, b.id]);
    expect(store.inbox.get(a.id)?.state).toBe("done");
    expect(await inbox.drain()).toBe(0);
  });

  it("round-trips the event unchanged through the database", async () => {
    const received: InboundEvent[] = [];
    const { inbox } = setup(async (event) => {
      received.push(event);
    });
    const event = text("Water plants @ in 1h");
    inbox.accept([event]);
    await inbox.drain();
    expect(received).toEqual([event]);
  });

  it("ignores redelivered events", async () => {
    let calls = 0;
    const { inbox } = setup(async () => {
      calls++;
    });
    const event = text("a");
    inbox.accept([event]);
    await inbox.drain();
    inbox.accept([event]);
    await inbox.drain();
    expect(calls).toBe(1);
  });

  it("retries a failed event with growing delays", async () => {
    let failures = 2;
    const { inbox, store, clock } = setup(async () => {
      if (failures-- > 0) throw new Error("database is locked");
    });
    const event = text("a");
    inbox.accept([event]);

    expect(await inbox.drain()).toBe(0);
    expect(store.inbox.get(event.id)).toMatchObject({ state: "pending", attempts: 1, lastError: "Error" });
    clock.now += 60_000;
    expect(await inbox.drain()).toBe(0);
    clock.now += 60_000;
    expect(await inbox.drain()).toBe(0);
    clock.now += 3 * 60_000;
    expect(await inbox.drain()).toBe(1);
    expect(store.inbox.get(event.id)?.state).toBe("done");
  });

  it("moves an event to dead after the last attempt and reports it", async () => {
    const { inbox, store, clock, dead } = setup(
      async () => {
        throw new Error("boom");
      },
      { maxAttempts: 2 },
    );
    const event = text("a");
    inbox.accept([event]);
    await inbox.drain();
    clock.now += 60 * 60_000;
    await inbox.drain();

    expect(store.inbox.get(event.id)?.state).toBe("dead");
    expect(dead).toEqual([event.id]);
  });

  it("does not block later events behind a failing one", async () => {
    const handled: string[] = [];
    const bad = text("bad");
    const good = text("good");
    const { inbox } = setup(async (event) => {
      if (event.id === bad.id) throw new Error("boom");
      handled.push(event.id);
    });
    inbox.accept([bad, good]);
    await inbox.drain();
    expect(handled).toEqual([good.id]);
  });

  it("treats a corrupt payload as dead without calling the handler", async () => {
    let calls = 0;
    const { inbox, store, dead } = setup(async () => {
      calls++;
    });
    store.inbox.accept([{ id: "x", receivedAt: T0, payload: { kind: "mystery" } }]);
    await inbox.drain();
    expect(calls).toBe(0);
    expect(store.inbox.get("x")?.state).toBe("dead");
    expect(dead).toEqual(["x"]);
  });

  it("serializes concurrent drains so no event runs twice", async () => {
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { inbox } = setup(async () => {
      calls++;
      await gate;
    });
    inbox.accept([text("a")]);
    const first = inbox.drain();
    const second = inbox.drain();
    release();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
  });
});
