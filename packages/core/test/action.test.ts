import { describe, expect, it } from "vitest";
import { ActionTransitionError, nextActionState, type ActionEvent, type ActionState } from "../src/action.ts";

describe("nextActionState", () => {
  const allowed: [ActionState, ActionEvent, ActionState][] = [
    ["proposed", "approve", "approved"],
    ["proposed", "ask_operator", "needs_operator"],
    ["proposed", "deny", "denied"],
    ["needs_operator", "approve", "approved"],
    ["needs_operator", "deny", "denied"],
    ["approved", "succeed", "executed"],
    ["approved", "fail", "failed"],
    ["failed", "retry", "approved"],
  ];

  it.each(allowed)("%s + %s -> %s", (from, event, to) => {
    expect(nextActionState(from, event)).toBe(to);
  });

  const forbidden: [ActionState, ActionEvent][] = [
    ["proposed", "succeed"],
    ["denied", "approve"],
    ["denied", "retry"],
    ["executed", "succeed"],
    ["executed", "retry"],
    ["needs_operator", "succeed"],
    ["approved", "approve"],
  ];

  it.each(forbidden)("%s + %s is rejected", (from, event) => {
    expect(() => nextActionState(from, event)).toThrow(ActionTransitionError);
  });
});
