import type { Store } from "@dsptchr/store";
import type { Dispatcher } from "./dispatch.ts";

export interface ReminderSchedulerDeps {
  store: Store;
  dispatcher: Dispatcher;
  now: () => number;
  maxAttempts?: number;
  retryDelayMs?: number;
}

const ACTOR = "scheduler";

// Fires due reminders deterministically, without a model call (AR-5).
export function createReminderScheduler({
  store,
  dispatcher,
  now,
  maxAttempts = 3,
  retryDelayMs = 5 * 60_000,
}: ReminderSchedulerDeps) {
  return {
    // Returns the number of reminders sent.
    async tick(): Promise<number> {
      if (store.flags.isPaused()) return 0;
      let sent = 0;

      for (const reminder of store.reminders.due()) {
        const todo = store.todos.get(reminder.todoId);
        if (todo === undefined || todo.state === "done" || todo.state === "dropped") {
          store.reminders.cancelForTodo(reminder.todoId);
          continue;
        }
        if (todo.state === "snoozed") {
          await dispatcher.dispatch({
            type: "todo.update",
            payload: { todoId: todo.id, event: "wake" },
            idempotencyKey: `reminder:${reminder.id}:wake`,
            actor: ACTOR,
          });
        }

        const action = await dispatcher.dispatch({
          type: "telegram.send",
          payload: {
            text: `Reminder: ${todo.text}`,
            buttons: [
              [
                { label: "Done", data: `todo:done:${todo.id}` },
                { label: "+1 h", data: `todo:hour:${todo.id}` },
                { label: "Tomorrow", data: `todo:tomorrow:${todo.id}` },
              ],
            ],
          },
          idempotencyKey: `reminder:${reminder.id}:${reminder.attempts}`,
          actor: ACTOR,
        });
        if (action.state === "executed") {
          store.reminders.markSent(reminder.id);
          sent++;
        } else {
          store.reminders.markFailed(reminder.id, { maxAttempts, retryAt: now() + retryDelayMs });
        }
      }
      return sent;
    },
  };
}
