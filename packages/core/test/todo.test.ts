import { describe, expect, it } from "vitest";
import { nextTodoState, TodoTransitionError, type TodoEvent, type TodoState } from "../src/todo.ts";

describe("nextTodoState", () => {
  const allowed: [TodoState, TodoEvent, TodoState][] = [
    ["open", "snooze", "snoozed"],
    ["open", "complete", "done"],
    ["open", "drop", "dropped"],
    ["snoozed", "wake", "open"],
    ["snoozed", "snooze", "snoozed"],
    ["snoozed", "complete", "done"],
    ["snoozed", "drop", "dropped"],
  ];

  it.each(allowed)("%s + %s -> %s", (from, event, to) => {
    expect(nextTodoState(from, event)).toBe(to);
  });

  const forbidden: [TodoState, TodoEvent][] = [
    ["open", "wake"],
    ["done", "complete"],
    ["done", "snooze"],
    ["done", "wake"],
    ["done", "drop"],
    ["dropped", "complete"],
    ["dropped", "wake"],
  ];

  it.each(forbidden)("%s + %s is rejected", (from, event) => {
    expect(() => nextTodoState(from, event)).toThrow(TodoTransitionError);
  });
});
