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

describe("message.send", () => {
  it("sends the message and records the reference", async () => {
    const { executor, sent } = setup();
    const action = approved("message.send", { text: "Hello", buttons: [[{ label: "Done", data: "todo:done:1" }]] });

    const result = await executor.execute(action.id);

    expect(sent).toEqual([{ text: "Hello", buttons: [[{ label: "Done", data: "todo:done:1" }]] }]);
    expect(result).toMatchObject({ state: "executed", result: { conversation: "home", messageRef: "1" } });
  });

  it("marks the action failed when the channel fails", async () => {
    const { executor } = setup({ fail: true });
    const action = approved("message.send", { text: "Hello" });

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
    const result = await executor.execute(approved("message.send", payload).id);
    expect(result.state).toBe("failed");
    expect(sent).toEqual([]);
  });
});

describe("message.ack", () => {
  it("acknowledges the button press with a note", async () => {
    const acks: unknown[] = [];
    const { channel } = fakeChannel();
    channel.acknowledge = async (target, note) => {
      acks.push({ target, note });
    };
    const executor = createExecutor({ store, channel });
    const payload = { conversation: "-1002", messageRef: "77", callbackRef: "cb-1", note: "Done" };

    const result = await executor.execute(approved("message.ack", payload).id);

    expect(result.state).toBe("executed");
    expect(acks).toEqual([{ target: { conversation: "-1002", messageRef: "77", callbackRef: "cb-1" }, note: "Done" }]);
  });

  it("passes a replacement for the message text and buttons", async () => {
    const acks: unknown[] = [];
    const { channel } = fakeChannel();
    channel.acknowledge = async (_target, note, replacement) => {
      acks.push({ note, replacement });
    };
    const executor = createExecutor({ store, channel });
    const replacement = { text: "List", buttons: [[{ label: "Milch", data: "shop:t:1" }]] };
    const payload = { conversation: "-1002", messageRef: "77", callbackRef: "cb-1", note: "Checked", replacement };

    const result = await executor.execute(approved("message.ack", payload).id);

    expect(result.state).toBe("executed");
    expect(acks).toEqual([{ note: "Checked", replacement }]);
  });

  it("rejects payloads without a callback reference", async () => {
    const { executor } = setup();
    const result = await executor.execute(approved("message.ack", { conversation: "c", messageRef: "1", note: "x" }).id);
    expect(result.state).toBe("failed");
  });
});

describe("knowledge.write", () => {
  it("writes through the knowledge client and returns its result", async () => {
    const writes: unknown[] = [];
    const { channel } = fakeChannel();
    const executor = createExecutor({
      store,
      channel,
      knowledge: {
        write: async (request) => {
          writes.push(request);
          return '{"revision":"abc123"}';
        },
      },
    });
    const payload = { path: "notes/topic.md", content: "# T\n", expected: "new", append: false };
    const result = await executor.execute(approved("knowledge.write", payload).id);
    expect(result).toMatchObject({ state: "executed", result: { revision: "abc123" } });
    expect(writes).toEqual([{ ...payload, message: "dsptchr: write notes/topic.md" }]);
  });

  it("keeps the commit message short for long paths", async () => {
    const messages: string[] = [];
    const { channel } = fakeChannel();
    const executor = createExecutor({
      store,
      channel,
      knowledge: {
        write: async (request) => {
          messages.push(request.message);
          return "{}";
        },
      },
    });
    const path = `notes/${"a".repeat(180)}.md`;
    await executor.execute(approved("knowledge.write", { path, content: "x", expected: "new", append: false }).id);
    expect(messages[0]?.length).toBeLessThanOrEqual(120);
    expect(messages[0]).toMatch(/^dsptchr: write …a+\.md$/);
  });

  it("fails without a configured knowledge client", async () => {
    const { executor } = setup();
    const result = await executor.execute(approved("knowledge.write", { path: "notes/a.md", content: "x", expected: "new", append: false }).id);
    expect(result).toMatchObject({ state: "failed", result: { error: "knowledge not configured" } });
  });

  it("rejects oversized content", async () => {
    const { channel } = fakeChannel();
    const executor = createExecutor({ store, channel, knowledge: { write: async () => "{}" } });
    const result = await executor.execute(
      approved("knowledge.write", { path: "notes/a.md", content: "x".repeat(30_000), expected: "new", append: false }).id,
    );
    expect(result.state).toBe("failed");
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

describe("shopping.add", () => {
  it("adds an item and returns its id", async () => {
    const { executor } = setup();
    const result = await executor.execute(approved("shopping.add", { name: "Skyr", quantity: "4x", kind: "every" }).id);
    expect(result).toMatchObject({ state: "executed", result: { itemId: expect.any(String) } });
    expect(store.shopping.list()).toMatchObject([{ name: "Skyr", quantity: "4x", kind: "every", state: "needed" }]);
  });

  it.each([
    ["empty name", { name: " " }],
    ["name too long", { name: "x".repeat(61) }],
    ["unknown kind", { name: "Skyr", kind: "weekly" }],
    ["unknown field", { name: "Skyr", price: 2 }],
  ])("fails on invalid payload: %s", async (_name, payload) => {
    const { executor } = setup();
    expect((await executor.execute(approved("shopping.add", payload).id)).state).toBe("failed");
    expect(store.shopping.list()).toEqual([]);
  });
});

describe("shopping.update", () => {
  it("checks an item", async () => {
    const { executor } = setup();
    const item = store.shopping.add({ name: "Milch", actor: "test" });
    const result = await executor.execute(approved("shopping.update", { itemId: item.id, event: "check" }).id);
    expect(result).toMatchObject({ state: "executed", result: { itemId: item.id, state: "checked" } });
  });

  it("removes an item", async () => {
    const { executor } = setup();
    const item = store.shopping.add({ name: "Milch", actor: "test" });
    const result = await executor.execute(approved("shopping.update", { itemId: item.id, event: "remove" }).id);
    expect(result).toMatchObject({ state: "executed", result: { itemId: item.id, state: "removed" } });
    expect(store.shopping.get(item.id)).toBeUndefined();
  });

  it("fails on invalid transitions without changing the item", async () => {
    const { executor } = setup();
    const item = store.shopping.add({ name: "Milch", actor: "test" });
    const result = await executor.execute(approved("shopping.update", { itemId: item.id, event: "stock" }).id);
    expect(result.state).toBe("failed");
    expect(store.shopping.get(item.id)?.state).toBe("needed");
  });

  it("fails on unknown items", async () => {
    const { executor } = setup();
    expect((await executor.execute(approved("shopping.update", { itemId: "nope", event: "check" }).id)).state).toBe("failed");
  });
});

describe("shopping.finish", () => {
  it("finishes the trip and reports the counts", async () => {
    const { executor } = setup();
    const milk = store.shopping.add({ name: "Milch", actor: "test" });
    store.shopping.add({ name: "Brot", actor: "test" });
    store.shopping.transition(milk.id, "check", "test");
    const result = await executor.execute(approved("shopping.finish", {}).id);
    expect(result).toMatchObject({ state: "executed", result: { bought: 1, open: 1 } });
  });

  it("rejects any payload fields", async () => {
    const { executor } = setup();
    expect((await executor.execute(approved("shopping.finish", { all: true }).id)).state).toBe("failed");
  });
});

describe("atomicity", () => {
  it("rolls back local changes when the success transition cannot be recorded", async () => {
    const { channel } = fakeChannel();
    const brokenStore: Store = {
      ...store,
      actions: {
        ...store.actions,
        transition: (id, event, options) => {
          if (event === "succeed") throw new Error("disk full");
          return store.actions.transition(id, event, options);
        },
      },
    };
    const action = approved("todo.create", { text: "once", dueAt: T0 + 1000 });

    await createExecutor({ store: brokenStore, channel }).execute(action.id);

    expect(store.todos.listActive()).toEqual([]);
    clock.now = T0 + 5000;
    expect(store.reminders.due()).toEqual([]);
  });
});

describe("guards", () => {
  it("refuses actions that are not approved", async () => {
    const { executor, sent } = setup();
    const { action } = store.actions.propose({
      type: "message.send",
      payload: { text: "x" },
      idempotencyKey: "k",
      draftHash: draftHash({ type: "message.send", payload: { text: "x" } }),
      actor: "test",
    });

    await expect(executor.execute(action.id)).rejects.toThrow(ExecutorError);
    store.actions.transition(action.id, "deny", { actor: "gate" });
    await expect(executor.execute(action.id)).rejects.toThrow(/not approved/);
    expect(sent).toEqual([]);
  });

  it("never runs an action twice", async () => {
    const { executor, sent } = setup();
    const action = approved("message.send", { text: "once" });
    await executor.execute(action.id);
    await expect(executor.execute(action.id)).rejects.toThrow(/not approved/);
    expect(sent).toHaveLength(1);
  });

  it("fails actions whose payload no longer matches the approved draft hash", async () => {
    const { executor, sent } = setup();
    const { action } = store.actions.propose({
      type: "message.send",
      payload: { text: "changed after approval" },
      idempotencyKey: "k",
      draftHash: draftHash({ type: "message.send", payload: { text: "original" } }),
      actor: "test",
    });
    store.actions.transition(action.id, "approve", { actor: "gate" });

    const result = await executor.execute(action.id);

    expect(result).toMatchObject({ state: "failed", result: { error: "draft hash mismatch" } });
    expect(sent).toEqual([]);
  });

  it("fails actions without a draft hash", async () => {
    const { executor } = setup();
    const { action } = store.actions.propose({ type: "message.send", payload: { text: "x" }, idempotencyKey: "k", actor: "t" });
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
