import { draftHash, parsePolicy } from "@dsptchr/gate";
import { describe, expect, it } from "vitest";
import { harness } from "./support/harness.ts";

describe("dispatcher", () => {
  it("runs approved proposals through the executor", async () => {
    const h = harness();
    const action = await h.dispatcher.dispatch({
      type: "message.send",
      payload: { text: "hi" },
      idempotencyKey: "k1",
      actor: "operator",
    });
    expect(action.state).toBe("executed");
    expect(h.sent).toEqual([{ text: "hi" }]);
    expect(h.store.audit.list({ subject: action.id }).map((e) => e.event)).toEqual([
      "action.proposed",
      "action.approve",
      "action.succeed",
    ]);
  });

  it("is idempotent per key", async () => {
    const h = harness();
    const input = { type: "message.send", payload: { text: "hi" }, idempotencyKey: "k1", actor: "operator" };
    const first = await h.dispatcher.dispatch(input);
    const second = await h.dispatcher.dispatch(input);
    expect(second.id).toBe(first.id);
    expect(h.sent).toHaveLength(1);
  });

  it("denies and never executes actions the policy forbids", async () => {
    const h = harness(parsePolicy("actions:\n  message.send:\n    level: never\n"));
    const action = await h.dispatcher.dispatch({
      type: "message.send",
      payload: { text: "hi" },
      idempotencyKey: "k",
      actor: "orchestrator",
    });
    expect(action.state).toBe("denied");
    expect(h.sent).toEqual([]);
    expect(h.store.audit.list({ subject: action.id }).at(-1)?.data).toMatchObject({ reason: "policy: never" });
  });

  it("parks ask actions for the operator", async () => {
    const h = harness(parsePolicy("actions:\n  message.send:\n    level: ask\n"));
    const action = await h.dispatcher.dispatch({ type: "message.send", payload: { text: "hi" }, idempotencyKey: "k", actor: "x" });
    expect(action.state).toBe("needs_operator");
    expect(h.sent).toEqual([]);
  });

  it("denies everything while paused", async () => {
    const h = harness();
    h.store.flags.setPaused(true, "operator");
    const action = await h.dispatcher.dispatch({ type: "todo.create", payload: { text: "x" }, idempotencyKey: "k", actor: "x" });
    expect(action.state).toBe("denied");
  });

  it("enforces the rate limit", async () => {
    const h = harness(parsePolicy("actions:\n  message.send:\n    level: auto\n    rate_limit: { max: 2, per_minutes: 60 }\n"));
    const states = [];
    for (let i = 0; i < 3; i++) {
      states.push((await h.dispatcher.dispatch({ type: "message.send", payload: { text: `m${i}` }, idempotencyKey: `k${i}`, actor: "x" })).state);
    }
    expect(states).toEqual(["executed", "executed", "denied"]);
  });

  it("resumes gate evaluation for an action stranded in proposed", async () => {
    const h = harness();
    h.store.actions.propose({
      type: "message.send",
      payload: { text: "hi" },
      idempotencyKey: "k",
      draftHash: draftHash({ type: "message.send", payload: { text: "hi" } }),
      actor: "x",
    });
    const result = await h.dispatcher.dispatch({ type: "message.send", payload: { text: "hi" }, idempotencyKey: "k", actor: "x" });
    expect(result.state).toBe("executed");
  });

  it("does not run a recovered approved action while paused", async () => {
    const h = harness();
    const { action } = h.store.actions.propose({
      type: "message.send",
      payload: { text: "hi" },
      idempotencyKey: "k",
      draftHash: draftHash({ type: "message.send", payload: { text: "hi" } }),
      actor: "x",
    });
    h.store.actions.transition(action.id, "approve", { actor: "gate" });
    h.store.flags.setPaused(true, "operator");

    const result = await h.dispatcher.dispatch({ type: "message.send", payload: { text: "hi" }, idempotencyKey: "k", actor: "x" });
    expect(result.state).toBe("approved");
    expect(h.sent).toEqual([]);
  });

  it("does not run a recovered approved action the policy no longer allows", async () => {
    const h = harness(parsePolicy("actions:\n  message.send:\n    level: never\n"));
    const { action } = h.store.actions.propose({
      type: "message.send",
      payload: { text: "hi" },
      idempotencyKey: "k",
      draftHash: draftHash({ type: "message.send", payload: { text: "hi" } }),
      actor: "x",
    });
    h.store.actions.transition(action.id, "approve", { actor: "gate" });

    const result = await h.dispatcher.dispatch({ type: "message.send", payload: { text: "hi" }, idempotencyKey: "k", actor: "x" });
    expect(result.state).toBe("approved");
    expect(h.sent).toEqual([]);
  });

  it("retries a failed action under the same key", async () => {
    const h = harness();
    const input = { type: "message.send", payload: { text: "hi" }, idempotencyKey: "k", actor: "x" };
    h.failSends.value = true;
    expect((await h.dispatcher.dispatch(input)).state).toBe("failed");
    h.failSends.value = false;
    const retried = await h.dispatcher.dispatch(input);
    expect(retried).toMatchObject({ state: "executed", retries: 1 });
    expect(h.sent).toHaveLength(1);
  });

  it("does not retry a failed action while paused", async () => {
    const h = harness();
    const input = { type: "message.send", payload: { text: "hi" }, idempotencyKey: "k", actor: "x" };
    h.failSends.value = true;
    await h.dispatcher.dispatch(input);
    h.failSends.value = false;
    h.store.flags.setPaused(true, "operator");
    expect((await h.dispatcher.dispatch(input)).state).toBe("failed");
    expect(h.sent).toEqual([]);
  });

  it("resumes an approved action left behind by a crash", async () => {
    const h = harness();
    const { action } = h.store.actions.propose({
      type: "message.send",
      payload: { text: "hi" },
      idempotencyKey: "k",
      draftHash: (await import("@dsptchr/gate")).draftHash({ type: "message.send", payload: { text: "hi" } }),
      actor: "x",
    });
    h.store.actions.transition(action.id, "approve", { actor: "gate" });

    const result = await h.dispatcher.dispatch({ type: "message.send", payload: { text: "hi" }, idempotencyKey: "k", actor: "x" });
    expect(result.state).toBe("executed");
    expect(h.sent).toHaveLength(1);
  });
});
