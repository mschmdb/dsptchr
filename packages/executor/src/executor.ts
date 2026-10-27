import type { Channel } from "@dsptchr/channels";
import { draftHash } from "@dsptchr/gate";
import type { StoredAction, Store } from "@dsptchr/store";
import type { z } from "zod";
import { telegramSendSchema, todoCreateSchema, todoUpdateSchema } from "./schemas.ts";

export class ExecutorError extends Error {
  override name = "ExecutorError";
}

export interface ExecutorDeps {
  store: Store;
  channel: Channel;
}

export interface Executor {
  execute(actionId: string): Promise<StoredAction>;
}

interface Handler<S extends z.ZodType> {
  schema: S;
  run(payload: z.output<S>): Promise<Record<string, unknown>>;
}

const ACTOR = "executor";

// One narrow handler per action type (AR-4). Nothing here decides; it only runs
// actions the gate approved, after re-checking payload and draft hash.
export function createExecutor({ store, channel }: ExecutorDeps): Executor {
  const handlers: Record<string, Handler<z.ZodType>> = {
    "telegram.send": handler(telegramSendSchema, async (payload) => {
      const sent = await channel.send({
        text: payload.text,
        ...(payload.conversation === undefined ? {} : { conversation: payload.conversation }),
        ...(payload.buttons === undefined ? {} : { buttons: payload.buttons }),
      });
      return { conversation: sent.conversation, messageRef: sent.messageRef };
    }),

    "todo.create": handler(todoCreateSchema, async (payload) =>
      store.transaction(() => {
        const todo = store.todos.create({
          text: payload.text,
          ...(payload.dueAt === undefined ? {} : { dueAt: payload.dueAt }),
          actor: ACTOR,
        });
        if (payload.dueAt !== undefined) {
          store.reminders.schedule({ todoId: todo.id, fireAt: payload.dueAt });
        }
        return { todoId: todo.id };
      }),
    ),

    "todo.update": handler(todoUpdateSchema, async (payload) =>
      store.transaction(() => {
        const todo = store.todos.transition(payload.todoId, payload.event, {
          actor: ACTOR,
          ...(payload.dueAt === undefined ? {} : { dueAt: payload.dueAt }),
        });
        if (payload.event !== "wake") {
          store.reminders.cancelForTodo(todo.id);
        }
        if (payload.event === "snooze" && payload.dueAt !== undefined) {
          store.reminders.schedule({ todoId: todo.id, fireAt: payload.dueAt });
        }
        return { todoId: todo.id, state: todo.state };
      }),
    ),
  };

  return {
    async execute(actionId) {
      const action = store.actions.get(actionId);
      if (action === undefined) {
        throw new ExecutorError(`action ${actionId} not found`);
      }
      if (action.state !== "approved") {
        throw new ExecutorError(`action ${actionId} is not approved (${action.state})`);
      }
      const fail = (error: string): StoredAction =>
        store.actions.transition(actionId, "fail", { actor: ACTOR, result: { error } });

      if (action.draftHash === undefined || action.draftHash !== draftHash({ type: action.type, payload: action.payload })) {
        return fail("draft hash mismatch");
      }
      const selected = Object.hasOwn(handlers, action.type) ? handlers[action.type] : undefined;
      if (selected === undefined) {
        return fail("unknown action type");
      }
      const parsed = selected.schema.safeParse(action.payload);
      if (!parsed.success) {
        return fail(`invalid payload: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
      }
      try {
        const result = await selected.run(parsed.data);
        return store.actions.transition(actionId, "succeed", { actor: ACTOR, result });
      } catch (error) {
        return fail(error instanceof Error ? error.message : "unknown error");
      }
    },
  };
}

function handler<S extends z.ZodType>(schema: S, run: (payload: z.output<S>) => Promise<Record<string, unknown>>): Handler<z.ZodType> {
  return { schema, run } as Handler<z.ZodType>;
}
