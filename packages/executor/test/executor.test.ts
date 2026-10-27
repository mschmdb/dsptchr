import type { Channel, OutboundMessage } from "@dsptchr/channels";
import { draftHash } from "@dsptchr/gate";
import { openStore, type Store } from "@dsptchr/store";
import { beforeEach, describe, expect, it } from "vitest";
import { createExecutor, ExecutorError, type Executor } from "../src/index.ts";

const T0 = Date.parse("2026-10-27T10:00:00Z");

function fakeChannel(options: { fail?: boolean } = {}) {
  const sent: OutboundMessage[] = [];
  const channel: Channel = {
    receive: async () => [],
    send: async (message) => {
      if (options.fail) throw new Error("network down");
      sent.push(message);
      return { conversation: message.conversation ?? "home", messageRef: String(sent.length) };
    },
    acknowledge: async () => {},
  };
  return { channel, sent };
}

let store: Store;
let clock: { now: number };

function approved(type: string, payload: unknown, key = `${type}-${Math.random()}`) {
  const { action } = store.actions.propose({
    type,
    payload,
    idempotencyKey: key,
    draftHash: draftHash({ type, payload }),
    actor: "test",
  });
  store.actions.transition(action.id, "approve", { actor: "gate" });
  return action;
}

function setup(channelOptions: { fail?: boolean } = {}): { executor: Executor; sent: OutboundMessage[] } {
  const { channel, sent } = fakeChannel(channelOptions);
  return { executor: createExecutor({ store, channel }), sent };
}

beforeEach(() => {
  clock = { now: T0 };
  store = openStore({ path: ":memory:", now: () => clock.now });
});

describe("telegram.send", () => {
  it("sends the message and records the reference", async () => {
    const { executor, sent } = setup();
    const action = approved("telegram.send", { text: "Hello", buttons: [[{ label: "Done", data: "todo:done:1" }]] });

    const result = await executor.execute(action.id);

    expect(sent).toEqual([{ text: "Hello", buttons: [[{ label: "Done", data: "todo:done:1" }]] }]);
    expect(result).toMatchObject({ state: "executed", result: { conversation: "home", messageRef: "1" } });
  });

  it("marks the action failed when the channel fails", async () => {
    const { executor } = setup({ fail: true });
    const action = approved("telegram.send", { text: "Hello" });

    const result = await executor.execute(action.id);

    expect(result).toMatchObject({ state: "failed", result: { error: "network down" } });
  });

  it.each([
    ["empty text", { text: "" }],
    ["text too long", { text: "x".repeat(4097) }],
    ["unknown field", { text: "x", chat_id: 1 }],
    ["oversized button data", { text: "x", buttons: [[{ label: "b", data: "x".repeat(65) }]] }],
  ])("fails on invalid payload: %s", async (_name, payload) => {
    const { executor, sent } = setup();
    const result = await executor.execute(approved("telegram.send", payload).id);
    expect(result.state).toBe("failed");
    expect(sent).toEqual([]);
  });
});

describe("todo.create", () => {
  it("creates a todo and schedules a reminder at the due time", async () => {
    const { executor } = setup();
    const result = await executor.execute(approved("todo.create", { text: "Buy milk", dueAt: T0 + 3_600_000 }).id);

    const todoId = (result.result as { todoId: string }).todoId;
    expect(store.todos.get(todoId)).toMatchObject({ text: "Buy milk", state: "open", dueAt: T0 + 3_600_000 });
    clock.now = T0 + 3_600_000;
    expect(store.reminders.due().map((r) => r.todoId)).toEqual([todoId]);
  });

  it("creates an undated todo without a reminder", async () => {
    const { executor } = setup();
    await executor.execute(approved("todo.create", { text: "Someday" }).id);
    clock.now = T0 + 10 * 365 * 86_400_000;
    expect(store.reminders.due()).toEqual([]);
    expect(store.todos.listActive()).toHaveLength(1);
  });
});

describe("todo.update", () => {
  async function createTodo(executor: Executor, dueAt = T0 + 1000): Promise<string> {
    const result = await executor.execute(approved("todo.create", { text: "x", dueAt }).id);
    return (result.result as { todoId: string }).todoId;
  }

  it("completes a todo and cancels its reminders", async () => {
    const { executor } = setup();
    const todoId = await createTodo(executor);

    const result = await executor.execute(approved("todo.update", { todoId, event: "complete" }).id);

    expect(result).toMatchObject({ state: "executed", result: { todoId, state: "done" } });
    clock.now = T0 + 5000;
    expect(store.reminders.due()).toEqual([]);
  });

  it("snoozes a todo to a new due time with a new reminder", async () => {
    const { executor } = setup();
    const todoId = await createTodo(executor);

    await executor.execute(approved("todo.update", { todoId, event: "snooze", dueAt: T0 + 7_200_000 }).id);

    expect(store.todos.get(todoId)).toMatchObject({ state: "snoozed", dueAt: T0 + 7_200_000 });
    clock.now = T0 + 5000;
    expect(store.reminders.due()).toEqual([]);
    clock.now = T0 + 7_200_000;
    expect(store.reminders.due()).toHaveLength(1);
  });

  it("requires a due time for snooze", async () => {
    const { executor } = setup();
    const todoId = await createTodo(executor);
    const result = await executor.execute(approved("todo.update", { todoId, event: "snooze" }).id);
    expect(result.state).toBe("failed");
  });

  it("fails on invalid transitions without changing the todo", async () => {
    const { executor } = setup();
    const todoId = await createTodo(executor);
    await executor.execute(approved("todo.update", { todoId, event: "complete" }).id);

    const result = await executor.execute(approved("todo.update", { todoId, event: "complete" }).id);

    expect(result.state).toBe("failed");
    expect(store.todos.get(todoId)?.state).toBe("done");
  });

  it("fails on unknown todos", async () => {
    const { executor } = setup();
    const result = await executor.execute(approved("todo.update", { todoId: "nope", event: "complete" }).id);
    expect(result).toMatchObject({ state: "failed", result: { error: expect.stringContaining("not found") } });
  });
});

describe("guards", () => {
  it("refuses actions that are not approved", async () => {
    const { executor, sent } = setup();
    const { action } = store.actions.propose({
      type: "telegram.send",
      payload: { text: "x" },
      idempotencyKey: "k",
      draftHash: draftHash({ type: "telegram.send", payload: { text: "x" } }),
      actor: "test",
    });

    await expect(executor.execute(action.id)).rejects.toThrow(ExecutorError);
    store.actions.transition(action.id, "deny", { actor: "gate" });
    await expect(executor.execute(action.id)).rejects.toThrow(/not approved/);
    expect(sent).toEqual([]);
  });

  it("never runs an action twice", async () => {
    const { executor, sent } = setup();
    const action = approved("telegram.send", { text: "once" });
    await executor.execute(action.id);
    await expect(executor.execute(action.id)).rejects.toThrow(/not approved/);
    expect(sent).toHaveLength(1);
  });

  it("fails actions whose payload no longer matches the approved draft hash", async () => {
    const { executor, sent } = setup();
    const { action } = store.actions.propose({
      type: "telegram.send",
      payload: { text: "changed after approval" },
      idempotencyKey: "k",
      draftHash: draftHash({ type: "telegram.send", payload: { text: "original" } }),
      actor: "test",
    });
    store.actions.transition(action.id, "approve", { actor: "gate" });

    const result = await executor.execute(action.id);

    expect(result).toMatchObject({ state: "failed", result: { error: "draft hash mismatch" } });
    expect(sent).toEqual([]);
  });

  it("fails actions without a draft hash", async () => {
    const { executor } = setup();
    const { action } = store.actions.propose({ type: "telegram.send", payload: { text: "x" }, idempotencyKey: "k", actor: "t" });
    store.actions.transition(action.id, "approve", { actor: "gate" });
    expect((await executor.execute(action.id)).state).toBe("failed");
  });

  it("fails unknown action types", async () => {
    const { executor } = setup();
    const result = await executor.execute(approved("shell.run", { cmd: "rm -rf /" }).id);
    expect(result).toMatchObject({ state: "failed", result: { error: "unknown action type" } });
  });

  it("rejects unknown action IDs", async () => {
    const { executor } = setup();
    await expect(executor.execute("nope")).rejects.toThrow(/not found/);
  });
});
