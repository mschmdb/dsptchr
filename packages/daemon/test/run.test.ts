import type { Channel, InboundEvent } from "@dsptchr/channels";
import { describe, expect, it } from "vitest";
import { runDaemon, type DaemonLog } from "../src/run.ts";
import { text } from "./support/harness.ts";

function scriptedChannel(batches: (InboundEvent[] | Error)[], controller: AbortController): Channel {
  return {
    receive: async () => {
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

function memoryLog(): DaemonLog & { lines: string[] } {
  const lines: string[] = [];
  return { lines, info: (m) => lines.push(`info ${m}`), error: (m) => lines.push(`error ${m}`) };
}

describe("runDaemon", () => {
  it("hands every received event to the handler and stops on abort", async () => {
    const controller = new AbortController();
    const handled: string[] = [];
    const a = text("a");
    const b = text("b");

    await runDaemon({
      channel: scriptedChannel([[a], [b]], controller),
      handle: async (event) => {
        handled.push(event.id);
      },
      tick: async () => 0,
      log: memoryLog(),
      signal: controller.signal,
      sleep: async () => {},
    });

    expect(handled).toEqual([a.id, b.id]);
  });

  it("keeps going when a handler throws", async () => {
    const controller = new AbortController();
    const log = memoryLog();
    const handled: string[] = [];
    const bad = text("bad");
    const good = text("good");

    await runDaemon({
      channel: scriptedChannel([[bad, good]], controller),
      handle: async (event) => {
        if (event.id === bad.id) throw new Error("boom");
        handled.push(event.id);
      },
      tick: async () => 0,
      log,
      signal: controller.signal,
      sleep: async () => {},
    });

    expect(handled).toEqual([good.id]);
    expect(log.lines.some((l) => l.startsWith("error") && l.includes("boom"))).toBe(true);
  });

  it("backs off exponentially on receive errors and honours retry-after", async () => {
    const controller = new AbortController();
    const waits: number[] = [];
    const rateLimited = Object.assign(new Error("429"), { retryAfterSeconds: 7 });

    await runDaemon({
      channel: scriptedChannel([new Error("down"), new Error("down"), rateLimited, [], new Error("down")], controller),
      handle: async () => {},
      tick: async () => 0,
      log: memoryLog(),
      signal: controller.signal,
      tickIntervalMs: 999_999,
      sleep: async (ms) => {
        if (ms !== 999_999) waits.push(ms);
      },
    });

    expect(waits).toEqual([1000, 2000, 7000, 1000]);
  });

  it("runs the scheduler tick on its own interval and survives tick errors", async () => {
    const controller = new AbortController();
    let ticks = 0;
    const log = memoryLog();

    await runDaemon({
      channel: { receive: () => new Promise(() => {}), send: async () => ({ conversation: "", messageRef: "" }), acknowledge: async () => {} },
      handle: async () => {},
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
    expect(log.lines.some((l) => l.includes("tick failed"))).toBe(true);
  });
});
