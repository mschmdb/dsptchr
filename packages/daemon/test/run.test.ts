import type { Channel, InboundEvent } from "@dsptchr/channels";
import { describe, expect, it, vi } from "vitest";
import type { Inbox } from "../src/inbox.ts";
import { abortableSleep, runDaemon, type DaemonLog } from "../src/run.ts";
import { text } from "./support/harness.ts";

function scriptedChannel(batches: (InboundEvent[] | Error)[], controller: AbortController, calls?: string[]): Channel {
  return {
    receive: async () => {
      calls?.push("receive");
      const next = batches.shift();
      if (next === undefined) {
        controller.abort();
        return [];
      }
      if (next instanceof Error) throw next;
      return next;
    },
    send: async () => ({ conversation: "c", messageRef: "1" }),
    acknowledge: async () => {},
  };
}

function memoryInbox(calls: string[] = [], failAccepts = 0): Inbox & { accepted: string[] } {
  const accepted: string[] = [];
  return {
    accepted,
    accept: (events) => {
      calls.push("accept");
      if (failAccepts-- > 0) throw new Error("database is locked");
      accepted.push(...events.map((e) => e.id));
    },
    drain: async () => {
      calls.push("drain");
      return 0;
    },
  };
}

function memoryLog(): DaemonLog & { lines: string[] } {
  const lines: string[] = [];
  return { lines, info: (m) => lines.push(`info ${m}`), error: (m) => lines.push(`error ${m}`) };
}

const idle = { tick: async () => 0, tickIntervalMs: 999_999 };

describe("runDaemon", () => {
  it("stores received events before draining and before the next receive", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const inbox = memoryInbox(calls);
    const a = text("a");

    await runDaemon({
      channel: scriptedChannel([[a]], controller, calls),
      inbox,
      ...idle,
      log: memoryLog(),
      signal: controller.signal,
      sleep: async () => {},
    });

    expect(inbox.accepted).toEqual([a.id]);
    const firstReceive = calls.indexOf("receive");
    const accept = calls.indexOf("accept");
    const secondReceive = calls.indexOf("receive", firstReceive + 1);
    expect(firstReceive).toBeLessThan(accept);
    expect(accept).toBeLessThan(secondReceive);
    expect(calls.slice(accept, secondReceive)).toContain("drain");
  });

  it("retries storing events instead of receiving (and confirming) the next batch", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const inbox = memoryInbox(calls, 2);
    const a = text("a");

    await runDaemon({
      channel: scriptedChannel([[a]], controller, calls),
      inbox,
      ...idle,
      log: memoryLog(),
      signal: controller.signal,
      sleep: async () => {},
    });

    const firstReceive = calls.indexOf("receive");
    const secondReceive = calls.indexOf("receive", firstReceive + 1);
    expect(calls.slice(firstReceive, secondReceive).filter((c) => c === "accept")).toHaveLength(3);
    expect(inbox.accepted).toEqual([a.id]);
  });

  it("backs off exponentially on receive errors and honours retry-after", async () => {
    const controller = new AbortController();
    const waits: number[] = [];
    const rateLimited = Object.assign(new Error("429"), { retryAfterSeconds: 7 });

    await runDaemon({
      channel: scriptedChannel([new Error("down"), new Error("down"), rateLimited, [], new Error("down")], controller),
      inbox: memoryInbox(),
      ...idle,
      log: memoryLog(),
      signal: controller.signal,
      sleep: async (ms) => {
        if (ms !== 999_999) waits.push(ms);
      },
    });

    expect(waits).toEqual([1000, 2000, 7000, 1000]);
  });

  it("drains the inbox and runs the scheduler on its own interval, surviving errors", async () => {
    const controller = new AbortController();
    let ticks = 0;
    const calls: string[] = [];
    const log = memoryLog();

    await runDaemon({
      channel: { receive: () => new Promise(() => {}), send: async () => ({ conversation: "", messageRef: "" }), acknowledge: async () => {} },
      inbox: memoryInbox(calls),
      tick: async () => {
        ticks++;
        if (ticks === 1) throw new Error("tick failed");
        if (ticks === 3) controller.abort();
        return 0;
      },
      log,
      signal: controller.signal,
      sleep: async () => {},
    });

    expect(ticks).toBe(3);
    expect(calls.filter((c) => c === "drain")).toHaveLength(3);
    expect(log.lines.some((l) => l.includes("tick failed"))).toBe(true);
  });
});

describe("abortableSleep", () => {
  it("removes its abort listener after the timer fires", async () => {
    const controller = new AbortController();
    const spy = vi.spyOn(controller.signal, "removeEventListener");

    await abortableSleep(1, controller.signal);
    expect(spy.mock.calls.map(([type]) => type)).toEqual(["abort"]);
  });
});
