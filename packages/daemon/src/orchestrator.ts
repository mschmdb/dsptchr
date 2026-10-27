import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import {
  costUsd,
  runOrchestrator,
  ToolInputError,
  type CreateMessage,
  type OrchestratorTools,
} from "@dsptchr/agents";
import type { InboundEvent } from "@dsptchr/channels";
import { wallClockOf, wallClockToUtc } from "@dsptchr/core";
import type { Store, StoredAction } from "@dsptchr/store";
import { sanitizeUntrusted } from "@dsptchr/watchers";
import type { Dispatcher } from "./dispatch.ts";
import { formatDue, formatNow } from "./format.ts";
import { HEALTH_SOURCE } from "./health.ts";

export interface OrchestratorDeps {
  store: Store;
  dispatcher: Dispatcher;
  timeZone: string;
  now: () => number;
  createMessage: CreateMessage;
  model: string;
  effort: "low" | "medium" | "high";
  dailyBudgetUsd: number;
  role: string;
}

export type OrchestratorOutcome = "handled" | "paused" | "budget_exhausted" | "unavailable";

const ACTOR = "orchestrator";
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_AHEAD_MS = 366 * 86_400_000;
const HISTORY_TURNS = 12;
const HISTORY_MAX_AGE_MS = 6 * 3_600_000;

export class ActionFailedError extends Error {
  override name = "ActionFailedError";
}

// Free-text operator messages go to the model. It reads state and proposes todo changes;
// every change passes gate and executor like any other proposal.
export function createOrchestrator(deps: OrchestratorDeps) {
  const { store, dispatcher, timeZone, now } = deps;

  function startOfToday(): number {
    return wallClockToUtc({ ...wallClockOf(now(), timeZone), hour: 0, minute: 0 }, timeZone);
  }

  function parseDueAt(value: string | null | undefined): number | undefined {
    if (value === null || value === undefined) return undefined;
    const due = ISO_WITH_OFFSET.test(value) ? Date.parse(value) : Number.NaN;
    if (Number.isNaN(due)) throw new ToolInputError("due_at must be ISO 8601 with a UTC offset");
    if (due <= now()) throw new ToolInputError("due_at is in the past");
    if (due - now() > MAX_AHEAD_MS) throw new ToolInputError("due_at is more than a year ahead");
    return due;
  }

  async function dispatch(event: InboundEvent, type: string, payload: unknown): Promise<StoredAction> {
    const digest = createHash("sha256").update(JSON.stringify([type, payload])).digest("hex").slice(0, 16);
    const action = await dispatcher.dispatch({ type, payload, idempotencyKey: `${event.id}:orch:${digest}`, actor: ACTOR });
    if (action.state === "failed") throw new ActionFailedError(`action ${type} failed`);
    return action;
  }

  function tools(event: InboundEvent): OrchestratorTools {
    return {
      async read_state({ scope }) {
        if (scope === "todos") {
          return JSON.stringify({
            todos: store.todos.listActive().map((t) => ({
              id: t.id,
              text: t.text,
              state: t.state,
              ...(t.dueAt === undefined ? {} : { due: formatDue(t.dueAt, timeZone) }),
            })),
          });
        }
        if (scope === "health") {
          // Structured fields only: finding text comes from the servers and stays out of model context.
          return JSON.stringify({
            findings: store.observations.listOpen(HEALTH_SOURCE).map((o) => {
              const host = String((o.data as { host?: unknown }).host ?? "");
              const check = o.externalId.startsWith(`${host}:`) ? o.externalId.slice(host.length + 1) : o.externalId;
              return {
                host: sanitizeUntrusted(host, 60),
                severity: o.version,
                check: sanitizeUntrusted(check, 60),
                since: formatDue(o.firstSeenAt, timeZone),
              };
            }),
          });
        }
        const last = store.cursors.get(`${HEALTH_SOURCE}:last_success`);
        return JSON.stringify({
          paused: store.flags.isPaused(),
          open_todos: store.todos.listActive().length,
          open_health_findings: store.observations.listOpen(HEALTH_SOURCE).length,
          last_health_check: last === undefined ? null : formatDue(Number(last), timeZone),
        });
      },

      async create_todo({ text, due_at }) {
        const dueAt = parseDueAt(due_at);
        const action = await dispatch(event, "todo.create", dueAt === undefined ? { text } : { text, dueAt });
        if (action.state !== "executed") return `Not allowed right now (${action.state}).`;
        const id = (action.result as { todoId?: string }).todoId ?? "?";
        return dueAt === undefined ? `Created todo ${id} without due time.` : `Created todo ${id} due ${formatDue(dueAt, timeZone)}.`;
      },

      async update_todo({ todo_id, action: change, due_at }) {
        const todo = store.todos.get(todo_id);
        if (todo === undefined || todo.state === "done" || todo.state === "dropped") {
          throw new ToolInputError(`todo ${todo_id} not found or already finished`);
        }
        const dueAt = parseDueAt(due_at);
        if (change === "snooze" && dueAt === undefined) throw new ToolInputError("snooze needs due_at");
        const event_ = change === "complete" ? "complete" : change === "drop" ? "drop" : "snooze";
        const payload = event_ === "snooze" ? { todoId: todo_id, event: event_, dueAt } : { todoId: todo_id, event: event_ };
        const action = await dispatch(event, "todo.update", payload);
        if (action.state !== "executed") return `Not allowed right now (${action.state}).`;
        return event_ === "snooze" && dueAt !== undefined
          ? `Snoozed "${todo.text}" until ${formatDue(dueAt, timeZone)}.`
          : `${event_ === "complete" ? "Completed" : "Dropped"} "${todo.text}".`;
      },
    };
  }

  return {
    async handle(event: Extract<InboundEvent, { kind: "text" }>): Promise<OrchestratorOutcome> {
      if (store.flags.isPaused()) return "paused";
      if (store.runs.costSince(startOfToday()) >= deps.dailyBudgetUsd) return "budget_exhausted";

      const history = store.conversation.recent(HISTORY_TURNS, { since: now() - HISTORY_MAX_AGE_MS });
      let result;
      try {
        result = await runOrchestrator({
          createMessage: deps.createMessage,
          model: deps.model,
          effort: deps.effort,
          role: deps.role,
          history,
          context: `Current time: ${formatNow(now(), timeZone)}`,
          input: event.text,
          tools: tools(event),
        });
      } catch (error) {
        if (isModelApiError(error)) {
          store.runs.record({ role: ACTOR, model: deps.model, inputTokens: 0, outputTokens: 0, costUsd: 0, outcome: "api_error" });
          return "unavailable";
        }
        throw error;
      }
      store.runs.record({
        role: ACTOR,
        model: deps.model,
        inputTokens: result.usage.inputTokens + result.usage.cacheReadTokens + result.usage.cacheWriteTokens,
        outputTokens: result.usage.outputTokens,
        costUsd: costUsd(deps.model, result.usage),
        outcome: result.outcome,
      });

      const reply =
        result.reply ??
        (result.outcome === "refusal"
          ? "Sorry, I can't help with that. Try /todos, /health or /status."
          : "Sorry, I couldn't finish that. Please try again or rephrase.");
      const sent = await dispatcher.dispatch({
        type: "message.send",
        payload: { text: reply.slice(0, 4000), conversation: event.conversation },
        idempotencyKey: `${event.id}:reply`,
        actor: ACTOR,
      });
      if (sent.state === "failed") throw new ActionFailedError("reply failed");
      store.conversation.append({ role: "operator", text: event.text });
      store.conversation.append({ role: "assistant", text: reply });
      return "handled";
    },
  };
}

// API and connection errors mean "model unavailable"; anything else is our bug and propagates.
function isModelApiError(error: unknown): boolean {
  return error instanceof Anthropic.APIError || typeof (error as { status?: unknown }).status === "number";
}

export function anthropicCreateMessage(apiKey: string): CreateMessage {
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 45_000 });
  return (params) => client.beta.messages.create(params);
}
