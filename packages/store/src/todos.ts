import { nextTodoState, type Todo, type TodoEvent, type TodoState } from "@dsptchr/core";
import type { AuditLog } from "./audit.ts";
import type { Db, Row } from "./db.ts";

export interface CreateTodo {
  text: string;
  dueAt?: number;
  actor: string;
}

export interface TransitionOptions {
  actor: string;
  dueAt?: number;
}

// Todo text is operator content; the audit log records only IDs, states and times.
export function todoRepo(db: Db, audit: AuditLog, now: () => number, newId: () => string) {
  const get = (id: string): Todo | undefined => {
    const row = db.get("SELECT * FROM todos WHERE id = :id", { id });
    return row === undefined ? undefined : toTodo(row);
  };

  return {
    get,

    create(input: CreateTodo): Todo {
      const text = input.text.trim();
      if (text === "") {
        throw new Error("todo text is empty");
      }
      return db.transaction(() => {
        const id = newId();
        const at = now();
        db.run(
          `INSERT INTO todos (id, text, state, due_at, created_at, updated_at)
           VALUES (:id, :text, 'open', :dueAt, :at, :at)`,
          { id, text, dueAt: input.dueAt, at },
        );
        audit.append({ actor: input.actor, event: "todo.created", subject: id, data: { dueAt: input.dueAt ?? null } });
        return mustGet(get, id);
      });
    },

    transition(id: string, event: TodoEvent, options: TransitionOptions): Todo {
      return db.transaction(() => {
        const todo = get(id);
        if (todo === undefined) {
          throw new Error(`todo ${id} not found`);
        }
        const state = nextTodoState(todo.state, event);
        const dueAt = options.dueAt ?? todo.dueAt;
        db.run("UPDATE todos SET state = :state, due_at = :dueAt, updated_at = :at WHERE id = :id", {
          id,
          state,
          dueAt,
          at: now(),
        });
        audit.append({
          actor: options.actor,
          event: `todo.${event}`,
          subject: id,
          data: { from: todo.state, to: state, dueAt: dueAt ?? null },
        });
        return mustGet(get, id);
      });
    },

    listActive(): Todo[] {
      return db
        .all(
          `SELECT * FROM todos WHERE state IN ('open', 'snoozed')
           ORDER BY due_at IS NULL, due_at, created_at`,
        )
        .map(toTodo);
    },
  };
}

export type TodoRepo = ReturnType<typeof todoRepo>;

function mustGet(get: (id: string) => Todo | undefined, id: string): Todo {
  const todo = get(id);
  if (todo === undefined) {
    throw new Error(`todo ${id} vanished`);
  }
  return todo;
}

function toTodo(row: Row): Todo {
  return {
    id: String(row["id"]),
    text: String(row["text"]),
    state: row["state"] as TodoState,
    dueAt: row["due_at"] === null ? undefined : Number(row["due_at"]),
    createdAt: Number(row["created_at"]),
    updatedAt: Number(row["updated_at"]),
  };
}
