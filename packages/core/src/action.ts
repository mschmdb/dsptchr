export const ACTION_STATES = ["proposed", "approved", "needs_operator", "denied", "executed", "failed"] as const;
export type ActionState = (typeof ACTION_STATES)[number];

export type ActionEvent = "approve" | "ask_operator" | "deny" | "succeed" | "fail" | "retry";

export class ActionTransitionError extends Error {
  override name = "ActionTransitionError";
}

const TRANSITIONS: Record<ActionState, Partial<Record<ActionEvent, ActionState>>> = {
  proposed: { approve: "approved", ask_operator: "needs_operator", deny: "denied" },
  needs_operator: { approve: "approved", deny: "denied" },
  approved: { succeed: "executed", fail: "failed" },
  failed: { retry: "approved" },
  denied: {},
  executed: {},
};

export function nextActionState(from: ActionState, event: ActionEvent): ActionState {
  const to = TRANSITIONS[from][event];
  if (to === undefined) {
    throw new ActionTransitionError(`action cannot ${event} from ${from}`);
  }
  return to;
}
