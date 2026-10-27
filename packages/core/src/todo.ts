export const TODO_STATES = ["open", "snoozed", "done", "dropped"] as const;
export type TodoState = (typeof TODO_STATES)[number];

export type TodoEvent = "snooze" | "wake" | "complete" | "drop";

export class TodoTransitionError extends Error {
  override name = "TodoTransitionError";
}

const TRANSITIONS: Record<TodoState, Partial<Record<TodoEvent, TodoState>>> = {
  open: { snooze: "snoozed", complete: "done", drop: "dropped" },
  snoozed: { snooze: "snoozed", wake: "open", complete: "done", drop: "dropped" },
  done: {},
  dropped: {},
};

export function nextTodoState(from: TodoState, event: TodoEvent): TodoState {
  const to = TRANSITIONS[from][event];
  if (to === undefined) {
    throw new TodoTransitionError(`todo cannot ${event} from ${from}`);
  }
  return to;
}

export interface Todo {
  id: string;
  text: string;
  state: TodoState;
  dueAt: number | undefined;
  createdAt: number;
  updatedAt: number;
}
