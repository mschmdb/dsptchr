import type { InboundEvent } from "@dsptchr/channels";
import { describe, expect, it } from "vitest";
import type { OrchestratorOutcome } from "../src/orchestrator.ts";
import { createOperatorHandler } from "../src/operator.ts";
import { harness, text, TZ } from "./support/harness.ts";

function setup(outcome: OrchestratorOutcome) {
  const h = harness();
  const seen: string[] = [];
  const handler = createOperatorHandler({
    store: h.store,
    dispatcher: h.dispatcher,
    timeZone: TZ,
    now: () => h.clock.now,
    orchestrator: {
      handle: async (event: Extract<InboundEvent, { kind: "text" }>) => {
        seen.push(event.text);
        return outcome;
      },
    },
  });
  return { ...h, handler, seen };
}

describe("routing with an orchestrator", () => {
  it("sends free text to the orchestrator", async () => {
    const h = setup("handled");
    await h.handler.handle(text("wie ist die server health?"));
    expect(h.seen).toEqual(["wie ist die server health?"]);
    expect(h.store.todos.listActive()).toEqual([]);
  });

  it("keeps the kill switch and commands deterministic", async () => {
    const h = setup("handled");
    await h.handler.handle(text("/status"));
    await h.handler.handle(text("stop"));
    await h.handler.handle(text("start"));
    expect(h.seen).toEqual([]);
  });

  it.each([
    ["unavailable", /model unavailable/i],
    ["budget_exhausted", /budget/i],
  ] as const)("falls back to a plain todo when the orchestrator is %s", async (outcome, note) => {
    const h = setup(outcome);
    await h.handler.handle(text("Buy milk @ morgen 9:00"));
    expect(h.store.todos.listActive()).toMatchObject([{ text: "Buy milk" }]);
    expect(h.sent.at(-1)?.text).toMatch(note);
    expect(h.sent.at(-1)?.text).toMatch(/Saved: Buy milk/);
  });
});
