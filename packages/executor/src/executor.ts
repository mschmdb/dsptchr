import type { Channel } from "@dsptchr/channels";
import { draftHash } from "@dsptchr/gate";
import type { StoredAction, Store } from "@dsptchr/store";
import type { z } from "zod";
import { knowledgeWriteSchema, messageAckSchema, messageSendSchema, todoCreateSchema, todoUpdateSchema } from "./schemas.ts";

export class ExecutorError extends Error {
  override name = "ExecutorError";
}

export interface ExecutorDeps {
  store: Store;
  channel: Channel;
  // The operator's knowledge base through an instance-provided adapter (docs/knowledge.md).
  knowledge?: { write(request: { path: string; content: string; expected: string; append: boolean; message: string }): Promise<string> };
}

export interface Executor {
  execute(actionId: string): Promise<StoredAction>;
}

type Result = Record<string, unknown>;

// Local handlers change only the store and run synchronously, so their changes and the
// action's success commit in one transaction. Remote handlers reach the outside world;
// a crash after the effect but before the commit repeats the effect (at-least-once).
type Handler =
  | { kind: "local"; schema: z.ZodType; run(payload: unknown): Result }
  | { kind: "remote"; schema: z.ZodType; run(payload: unknown): Promise<Result> };

const ACTOR = "executor";

// One narrow handler per action type (AR-4). Nothing here decides; it only runs
// actions the gate approved, after re-checking payload and draft hash.
export function createExecutor({ store, channel, knowledge }: ExecutorDeps): Executor {
  const handlers: Record<string, Handler> = {
    "message.send": remote(messageSendSchema, async (payload) => {
      const sent = await channel.send({
        text: payload.text,
        ...(payload.conversation === undefined ? {} : { conversation: payload.conversation }),
        ...(payload.buttons === undefined ? {} : { buttons: payload.buttons }),
      });
      return { conversation: sent.conversation, messageRef: sent.messageRef };
    }),

    "message.ack": remote(messageAckSchema, async (payload) => {
      await channel.acknowledge(
        { conversation: payload.conversation, messageRef: payload.messageRef, callbackRef: payload.callbackRef },
        payload.note,
      );
      return {};
    }),

    "knowledge.write": remote(knowledgeWriteSchema, async (payload) => {
      if (knowledge === undefined) throw new Error("knowledge not configured");
      // Commit messages stay within 120 characters; long paths keep their meaningful end.
      const shown = payload.path.length > 100 ? `…${payload.path.slice(-99)}` : payload.path;
      const output = await knowledge.write({ ...payload, message: `dsptchr: write ${shown}` });
      let revision: unknown;
      try {
        revision = (JSON.parse(output) as { revision?: unknown }).revision;
      } catch {
        revision = undefined;
      }
      return typeof revision === "string" ? { revision } : {};
    }),

    "todo.create": local(todoCreateSchema, (payload) => {
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

    "todo.update": local(todoUpdateSchema, (payload) => {
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
  };

  const succeed = (actionId: string, result: Result): StoredAction =>
    store.actions.transition(actionId, "succeed", { actor: ACTOR, result });

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
        if (selected.kind === "local") {
          return store.transaction(() => succeed(actionId, selected.run(parsed.data)));
        }
        return succeed(actionId, await selected.run(parsed.data));
      } catch (error) {
        return fail(error instanceof Error ? error.message : "unknown error");
      }
    },
  };
}

function local<S extends z.ZodType>(schema: S, run: (payload: z.output<S>) => Result): Handler {
  return { kind: "local", schema, run: run as (payload: unknown) => Result };
}

function remote<S extends z.ZodType>(schema: S, run: (payload: z.output<S>) => Promise<Result>): Handler {
  return { kind: "remote", schema, run: run as (payload: unknown) => Promise<Result> };
}
