import type { Db, Row } from "./db.ts";

export type ReminderState = "pending" | "sent" | "cancelled" | "failed";

export interface Reminder {
  id: string;
  todoId: string;
  fireAt: number;
  state: ReminderState;
  attempts: number;
}

export function reminderRepo(db: Db, now: () => number, newId: () => string) {
  const get = (id: string): Reminder | undefined => {
    const row = db.get("SELECT * FROM reminders WHERE id = :id", { id });
    return row === undefined ? undefined : toReminder(row);
  };

  return {
    get,

    schedule(input: { todoId: string; fireAt: number }): Reminder {
      const id = newId();
      db.run(
        `INSERT INTO reminders (id, todo_id, fire_at, state, created_at)
         VALUES (:id, :todoId, :fireAt, 'pending', :at)`,
        { id, todoId: input.todoId, fireAt: input.fireAt, at: now() },
      );
      return { id, todoId: input.todoId, fireAt: input.fireAt, state: "pending", attempts: 0 };
    },

    due(): Reminder[] {
      return db
        .all("SELECT * FROM reminders WHERE state = 'pending' AND fire_at <= :now ORDER BY fire_at, created_at", {
          now: now(),
        })
        .map(toReminder);
    },

    markSent(id: string): void {
      db.run("UPDATE reminders SET state = 'sent', attempts = attempts + 1 WHERE id = :id AND state = 'pending'", { id });
    },

    markFailed(id: string, options: { maxAttempts: number; retryAt: number }): void {
      db.run(
        `UPDATE reminders
         SET attempts = attempts + 1,
             state = CASE WHEN attempts + 1 >= :max THEN 'failed' ELSE 'pending' END,
             fire_at = :retryAt
         WHERE id = :id AND state = 'pending'`,
        { id, max: options.maxAttempts, retryAt: options.retryAt },
      );
    },

    cancelForTodo(todoId: string): number {
      return db.run("UPDATE reminders SET state = 'cancelled' WHERE todo_id = :todoId AND state = 'pending'", { todoId })
        .changes;
    },
  };
}

export type ReminderRepo = ReturnType<typeof reminderRepo>;

function toReminder(row: Row): Reminder {
  return {
    id: String(row["id"]),
    todoId: String(row["todo_id"]),
    fireAt: Number(row["fire_at"]),
    state: row["state"] as ReminderState,
    attempts: Number(row["attempts"]),
  };
}
