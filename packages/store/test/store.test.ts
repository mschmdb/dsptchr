import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TodoTransitionError, ActionTransitionError } from "@dsptchr/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, AuditTamperError, type Store } from "../src/index.ts";

const T0 = Date.parse("2026-10-27T10:00:00Z");

function testStore(): { store: Store; clock: { now: number } } {
  const clock = { now: T0 };
  let n = 0;
  const store = openStore({ path: ":memory:", now: () => clock.now, newId: () => `id-${++n}` });
  return { store, clock };
}

describe("audit log", () => {
  it("appends entries with time, actor and data", () => {
    const { store } = testStore();
    store.audit.append({ actor: "operator", event: "test.event", subject: "s-1", data: { a: 1 } });

    expect(store.audit.list()).toEqual([
      expect.objectContaining({ seq: 1, at: T0, actor: "operator", event: "test.event", subject: "s-1", data: { a: 1 } }),
    ]);
  });

  it("filters by subject", () => {
    const { store } = testStore();
    store.audit.append({ actor: "system", event: "a", subject: "x" });
    store.audit.append({ actor: "system", event: "b", subject: "y" });
    expect(store.audit.list({ subject: "y" }).map((e) => e.event)).toEqual(["b"]);
  });

  it("rejects updates and deletes at the database level", () => {
    const { store } = testStore();
    store.audit.append({ actor: "system", event: "a" });
    expect(() => store.unsafeExec("UPDATE audit_log SET event = 'x'")).toThrow(/append-only/);
    expect(() => store.unsafeExec("DELETE FROM audit_log")).toThrow(/append-only/);
  });

  it("chains entries by hash and detects tampering", () => {
    const { store } = testStore();
    store.audit.append({ actor: "system", event: "a" });
    store.audit.append({ actor: "system", event: "b" });
    expect(store.audit.verify()).toBe(2);

    store.unsafeExec("DROP TRIGGER audit_log_no_update");
    store.unsafeExec("UPDATE audit_log SET event = 'forged' WHERE seq = 1");
    expect(() => store.audit.verify()).toThrow(AuditTamperError);
  });
});

describe("todos", () => {
  let store: Store;
  let clock: { now: number };

  beforeEach(() => {
    ({ store, clock } = testStore());
  });

  afterEach(() => store.close());

  it("creates an open todo and audits it", () => {
    const todo = store.todos.create({ text: "Buy milk", dueAt: T0 + 3_600_000, actor: "operator" });

    expect(todo).toEqual({ id: "id-1", text: "Buy milk", state: "open", dueAt: T0 + 3_600_000, createdAt: T0, updatedAt: T0 });
    expect(store.todos.get("id-1")).toEqual(todo);
    expect(store.audit.list({ subject: "id-1" })).toEqual([
      expect.objectContaining({ event: "todo.created", actor: "operator", data: { dueAt: T0 + 3_600_000 } }),
    ]);
  });

  it("does not write todo text into the audit log", () => {
    store.todos.create({ text: "private detail", actor: "operator" });
    expect(JSON.stringify(store.audit.list())).not.toContain("private detail");
  });

  it("rejects empty text", () => {
    expect(() => store.todos.create({ text: "  ", actor: "operator" })).toThrow(/empty/);
  });

  it("transitions through the state machine and audits each step", () => {
    const todo = store.todos.create({ text: "x", actor: "operator" });
    clock.now += 1000;
    const snoozed = store.todos.transition(todo.id, "snooze", { actor: "operator", dueAt: T0 + 7_200_000 });
    expect(snoozed).toMatchObject({ state: "snoozed", dueAt: T0 + 7_200_000, updatedAt: T0 + 1000 });

    const done = store.todos.transition(todo.id, "complete", { actor: "operator" });
    expect(done.state).toBe("done");
    expect(store.audit.list({ subject: todo.id }).map((e) => e.event)).toEqual([
      "todo.created",
      "todo.snooze",
      "todo.complete",
    ]);
  });

  it("rejects invalid transitions without side effects", () => {
    const todo = store.todos.create({ text: "x", actor: "operator" });
    store.todos.transition(todo.id, "complete", { actor: "operator" });
    expect(() => store.todos.transition(todo.id, "complete", { actor: "operator" })).toThrow(TodoTransitionError);
    expect(store.audit.list({ subject: todo.id })).toHaveLength(2);
  });

  it("throws on unknown todo IDs", () => {
    expect(() => store.todos.transition("nope", "complete", { actor: "operator" })).toThrow(/not found/);
    expect(store.todos.get("nope")).toBeUndefined();
  });

  it("lists open and snoozed todos ordered by due date, undated last", () => {
    const a = store.todos.create({ text: "a", actor: "operator" });
    const b = store.todos.create({ text: "b", dueAt: T0 + 2000, actor: "operator" });
    const c = store.todos.create({ text: "c", dueAt: T0 + 1000, actor: "operator" });
    const d = store.todos.create({ text: "d", actor: "operator" });
    store.todos.transition(d.id, "drop", { actor: "operator" });

    expect(store.todos.listActive().map((t) => t.id)).toEqual([c.id, b.id, a.id]);
  });
});

describe("reminders", () => {
  it("returns pending reminders that are due, oldest first", () => {
    const { store, clock } = testStore();
    const todo = store.todos.create({ text: "x", actor: "operator" });
    const later = store.reminders.schedule({ todoId: todo.id, fireAt: T0 + 2000 });
    const sooner = store.reminders.schedule({ todoId: todo.id, fireAt: T0 + 1000 });

    expect(store.reminders.due()).toEqual([]);
    clock.now = T0 + 5000;
    expect(store.reminders.due().map((r) => r.id)).toEqual([sooner.id, later.id]);
  });

  it("marks reminders sent and stops returning them", () => {
    const { store, clock } = testStore();
    const todo = store.todos.create({ text: "x", actor: "operator" });
    const reminder = store.reminders.schedule({ todoId: todo.id, fireAt: T0 });
    clock.now = T0 + 1;

    store.reminders.markSent(reminder.id);
    expect(store.reminders.due()).toEqual([]);
    expect(store.reminders.get(reminder.id)?.state).toBe("sent");
  });

  it("counts failed attempts and keeps the reminder pending until the limit", () => {
    const { store, clock } = testStore();
    const todo = store.todos.create({ text: "x", actor: "operator" });
    const reminder = store.reminders.schedule({ todoId: todo.id, fireAt: T0 });
    clock.now = T0 + 1;

    store.reminders.markFailed(reminder.id, { maxAttempts: 2, retryAt: T0 + 60_000 });
    expect(store.reminders.get(reminder.id)).toMatchObject({ state: "pending", attempts: 1, fireAt: T0 + 60_000 });
    store.reminders.markFailed(reminder.id, { maxAttempts: 2, retryAt: T0 + 120_000 });
    expect(store.reminders.get(reminder.id)).toMatchObject({ state: "failed", attempts: 2 });
  });

  it("cancels pending reminders of a todo", () => {
    const { store, clock } = testStore();
    const todo = store.todos.create({ text: "x", actor: "operator" });
    store.reminders.schedule({ todoId: todo.id, fireAt: T0 });
    store.reminders.schedule({ todoId: todo.id, fireAt: T0 + 10 });

    expect(store.reminders.cancelForTodo(todo.id)).toBe(2);
    clock.now = T0 + 100;
    expect(store.reminders.due()).toEqual([]);
  });

  it("rejects reminders for unknown todos", () => {
    const { store } = testStore();
    expect(() => store.reminders.schedule({ todoId: "nope", fireAt: T0 })).toThrow();
  });
});

describe("transactions", () => {
  it("rolls back all writes when the callback throws", () => {
    const { store } = testStore();
    expect(() =>
      store.transaction(() => {
        store.todos.create({ text: "x", actor: "operator" });
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(store.todos.listActive()).toEqual([]);
    expect(store.audit.list()).toEqual([]);
  });

  it("supports nesting by joining the outer transaction", () => {
    const { store } = testStore();
    store.transaction(() => {
      store.transaction(() => store.todos.create({ text: "x", actor: "operator" }));
    });
    expect(store.todos.listActive()).toHaveLength(1);
  });
});

describe("flags", () => {
  it("is not paused by default and audits pause changes", () => {
    const { store } = testStore();
    expect(store.flags.isPaused()).toBe(false);
    store.flags.setPaused(true, "operator");
    expect(store.flags.isPaused()).toBe(true);
    expect(store.audit.list().map((e) => e.event)).toEqual(["kill_switch.paused"]);
    store.flags.setPaused(false, "operator");
    expect(store.flags.isPaused()).toBe(false);
  });
});

describe("cursors", () => {
  it("stores and updates cursors per source", () => {
    const { store } = testStore();
    expect(store.cursors.get("telegram")).toBeUndefined();
    store.cursors.set("telegram", "42");
    store.cursors.set("telegram", "43");
    expect(store.cursors.get("telegram")).toBe("43");
  });
});

describe("actions", () => {
  it("proposes an action once per idempotency key", () => {
    const { store } = testStore();
    const first = store.actions.propose({ type: "telegram.send", payload: { a: 1 }, idempotencyKey: "k1", actor: "system" });
    const second = store.actions.propose({ type: "telegram.send", payload: { a: 2 }, idempotencyKey: "k1", actor: "system" });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.action.id).toBe(first.action.id);
    expect(second.action.payload).toEqual({ a: 1 });
  });

  it("follows the action state machine and audits transitions", () => {
    const { store } = testStore();
    const { action } = store.actions.propose({ type: "t", payload: {}, idempotencyKey: "k", actor: "system" });
    store.actions.transition(action.id, "approve", { actor: "gate" });
    const done = store.actions.transition(action.id, "succeed", { actor: "executor", result: { messageId: 7 } });

    expect(done).toMatchObject({ state: "executed", result: { messageId: 7 } });
    expect(() => store.actions.transition(action.id, "retry", { actor: "executor" })).toThrow(ActionTransitionError);
    expect(store.audit.list({ subject: action.id }).map((e) => e.event)).toEqual([
      "action.proposed",
      "action.approve",
      "action.succeed",
    ]);
  });

  it("records the gate reason in the audit log", () => {
    const { store } = testStore();
    const { action } = store.actions.propose({ type: "t", payload: {}, idempotencyKey: "k", actor: "system" });
    store.actions.transition(action.id, "deny", { actor: "gate", reason: "policy: never" });
    expect(store.audit.list({ subject: action.id }).at(-1)?.data).toMatchObject({ reason: "policy: never" });
  });

  it("increments the retry counter on retry", () => {
    const { store } = testStore();
    const { action } = store.actions.propose({ type: "t", payload: {}, idempotencyKey: "k", actor: "system" });
    store.actions.transition(action.id, "approve", { actor: "gate" });
    store.actions.transition(action.id, "fail", { actor: "executor", result: { error: "timeout" } });
    expect(store.actions.transition(action.id, "retry", { actor: "executor" }).retries).toBe(1);
  });
});

describe("actions: draft hash and counting", () => {
  it("stores the draft hash given at proposal time", () => {
    const { store } = testStore();
    const { action } = store.actions.propose({
      type: "t.x",
      payload: {},
      idempotencyKey: "k",
      draftHash: "abc",
      actor: "system",
    });
    expect(action.draftHash).toBe("abc");
  });

  it("counts gate-approved actions of a type since a point in time", () => {
    const { store, clock } = testStore();
    const make = (key: string, type = "t.x") =>
      store.actions.propose({ type, payload: {}, idempotencyKey: key, actor: "system" }).action;

    const old = make("old");
    store.actions.transition(old.id, "approve", { actor: "gate" });
    clock.now += 10_000;
    const executed = make("a");
    store.actions.transition(executed.id, "approve", { actor: "gate" });
    store.actions.transition(executed.id, "succeed", { actor: "executor" });
    const failed = make("b");
    store.actions.transition(failed.id, "approve", { actor: "gate" });
    store.actions.transition(failed.id, "fail", { actor: "executor" });
    const denied = make("c");
    store.actions.transition(denied.id, "deny", { actor: "gate" });
    make("d");
    const other = make("e", "t.y");
    store.actions.transition(other.id, "approve", { actor: "gate" });

    expect(store.actions.countApprovedSince("t.x", T0 + 5_000)).toBe(2);
    expect(store.actions.countApprovedSince("t.x", T0)).toBe(3);
  });
});

describe("persistence", () => {
  it("keeps data and migrations across reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "dsptchr-store-"));
    const path = join(dir, "state.db");
    try {
      const first = openStore({ path, now: () => T0 });
      const todo = first.todos.create({ text: "persist", actor: "operator" });
      first.close();

      const second = openStore({ path, now: () => T0 });
      expect(second.todos.get(todo.id)?.text).toBe("persist");
      expect(second.audit.verify()).toBe(1);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
