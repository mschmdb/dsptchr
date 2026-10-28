import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import {
  costUsd,
  runOrchestrator,
  runTriage,
  ToolInputError,
  type CreateMessage,
  type OrchestratorTools,
  type TriageDecision,
  type TriageItemRef,
} from "@dsptchr/agents";
import type { InboundEvent } from "@dsptchr/channels";
import { nextShoppingState, ShoppingTransitionError, wallClockOf, wallClockToUtc } from "@dsptchr/core";
import type { Store, StoredAction } from "@dsptchr/store";
import { sanitizeUntrusted } from "@dsptchr/watchers";
import type { Dispatcher } from "./dispatch.ts";
import { formatDue, formatNow } from "./format.ts";
import { GITHUB_SOURCE } from "./github.ts";
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
  calendar?: { forModel(): unknown[]; search(input: { query?: string | null | undefined; from: string; to: string }): unknown };
  birthdays?: { forModel(): unknown[]; all(): unknown[] };
  mail?: { forModel(): unknown };
  analytics?: { forModel(): unknown[] };
  // Todos created from mail carry text a spoofed sender may control; the model gets a placeholder.
  isMailTodo?: (todoId: string) => boolean;
  knowledge?: { context(query: string): Promise<string>; read(path: string, section?: string): Promise<string> };
}

export type OrchestratorOutcome = "handled" | "paused" | "budget_exhausted" | "unavailable";

const ACTOR = "orchestrator";
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_AHEAD_MS = 366 * 86_400_000;
const HISTORY_TURNS = 12;
const HISTORY_MAX_AGE_MS = 6 * 3_600_000;
const CHECK_NAME = /^[a-z_]{1,24}$/;
// Caps what one operator message can change, even with a misbehaving model.
const MAX_WRITES_PER_MESSAGE = 10;
// A reply that sounds like a change while no tool changed anything gets a visible note.
const CLAIMS_CHANGE =
  /\b(erledigt|angelegt|eingetragen|gespeichert|notiert|verschoben|erinnere dich|done|created|saved|added|snoozed|completed|i('ll| will) remind)\b/i;

type Counts = Record<"self" | "bot" | "other", number>;
const emptyCounts = (): Counts => ({ self: 0, bot: 0, other: 0 });

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

  // Finding keys come from the servers (e.g. container names). The model gets only the
  // rule suffix in a fixed format and whether it concerns a container, never the raw key.
  function checkOf(externalId: string): { scope: "host" | "container"; check: string } {
    const parts = externalId.split(":");
    const last = parts.at(-1) ?? "";
    return { scope: parts[1] === "ctr" ? "container" : "host", check: CHECK_NAME.test(last) ? last : "other" };
  }

  async function dispatch(event: InboundEvent, type: string, payload: unknown): Promise<StoredAction> {
    if ((store.orchestratorEvents.get(event.id)?.writes.length ?? 0) >= MAX_WRITES_PER_MESSAGE) {
      throw new ToolInputError(`limit of ${MAX_WRITES_PER_MESSAGE} changes per message reached`);
    }
    return dispatchUncounted(event, type, payload);
  }

  // Like dispatch(), but the caller records one write for a whole batch.
  async function dispatchUncounted(event: InboundEvent, type: string, payload: unknown): Promise<StoredAction> {
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
              text: deps.isMailTodo?.(t.id) === true ? "(todo from mail)" : t.text,
              state: t.state,
              ...(t.dueAt === undefined ? {} : { due: formatDue(t.dueAt, timeZone) }),
            })),
          });
        }
        if (scope === "shopping") {
          return JSON.stringify({
            items: store.shopping.list().map((i) => ({
              id: i.id,
              name: i.name,
              ...(i.quantity === undefined ? {} : { quantity: i.quantity }),
              kind: i.kind,
              state: i.state,
            })),
          });
        }
        if (scope === "calendar") {
          return JSON.stringify({
            events: deps.calendar?.forModel() ?? [],
            birthdays: deps.birthdays?.forModel() ?? [],
          });
        }
        if (scope === "birthdays") {
          return JSON.stringify({ birthdays: deps.birthdays?.all() ?? [] });
        }
        if (scope === "analytics") {
          return JSON.stringify({ sites: deps.analytics?.forModel() ?? [] });
        }
        if (scope === "mail") {
          return JSON.stringify(deps.mail === undefined ? { mail: "not configured" } : deps.mail.forModel());
        }
        if (scope === "health") {
          // Structured fields only: finding text comes from the servers and stays out of model context.
          return JSON.stringify({
            // Hosts passed the instance allowlist; everything else is reduced to a fixed vocabulary.
            findings: store.observations.listOpen(HEALTH_SOURCE).map((o) => ({
              host: sanitizeUntrusted(String((o.data as { host?: unknown }).host ?? ""), 60),
              severity: o.version === "crit" ? "crit" : "warn",
              ...checkOf(o.externalId),
              since: formatDue(o.firstSeenAt, timeZone),
            })),
          });
        }
        if (scope === "github") {
          // Counts only: titles and workflow names come from GitHub and stay out of model context.
          const repos = new Map<string, { open_prs: Counts; open_issues: Counts; ci_red: number }>();
          for (const o of store.observations.listOpen(GITHUB_SOURCE)) {
            const d = o.data as { repo?: unknown; kind?: unknown; author?: unknown };
            if (typeof d.repo !== "string") continue;
            const name = d.repo;
            const entry = repos.get(name) ?? { open_prs: emptyCounts(), open_issues: emptyCounts(), ci_red: 0 };
            if (d.kind === "ci") {
              if (o.version === "red") entry.ci_red++;
            } else if (d.author === "self" || d.author === "bot" || d.author === "other") {
              (d.kind === "pr" ? entry.open_prs : entry.open_issues)[d.author]++;
            }
            repos.set(name, entry);
          }
          return JSON.stringify({ repos: [...repos.entries()].map(([repo, e]) => ({ repo, ...e })) });
        }
        const last = store.cursors.get(`${HEALTH_SOURCE}:last_success`);
        return JSON.stringify({
          paused: store.flags.isPaused(),
          open_todos: store.todos.listActive().length,
          open_health_findings: store.observations.listOpen(HEALTH_SOURCE).length,
          last_health_check: last === undefined ? null : formatDue(Number(last), timeZone),
        });
      },

      async search_calendar(input) {
        if (deps.calendar === undefined) return JSON.stringify({ calendar: "not configured" });
        return JSON.stringify(deps.calendar.search(input));
      },

      async search_knowledge({ query }) {
        if (deps.knowledge === undefined) return JSON.stringify({ knowledge: "not configured" });
        return knowledgeCall(() => deps.knowledge!.context(query));
      },

      async read_knowledge({ path, section }) {
        if (deps.knowledge === undefined) return JSON.stringify({ knowledge: "not configured" });
        return knowledgeCall(() => deps.knowledge!.read(path, section ?? undefined));
      },

      async write_knowledge({ path, content, mode, expected }) {
        const revision = mode === "create" ? "new" : (expected ?? "");
        if (revision === "") throw new ToolInputError(`${mode} needs expected = the note's current revision`);
        let action: StoredAction;
        try {
          action = await dispatch(event, "knowledge.write", { path, content, expected: revision, append: mode === "append" });
        } catch (error) {
          // A stale revision or an invalid path is something the model can fix by reading again.
          if (error instanceof ActionFailedError) {
            throw new ToolInputError("write failed: the note changed, the path is invalid or outside the scope; read it again");
          }
          throw error;
        }
        if (action.state !== "executed") return `Not allowed right now (${action.state}).`;
        const summary = `${mode === "create" ? "Created note" : mode === "append" ? "Appended to note" : "Replaced note"} ${path}.`;
        store.orchestratorEvents.addWrite(event.id, summary);
        const newRevision = (action.result as { revision?: string } | undefined)?.revision;
        return newRevision === undefined ? summary : `${summary} New revision ${newRevision}.`;
      },

      async create_todo({ text, due_at }) {
        const dueAt = parseDueAt(due_at);
        const action = await dispatch(event, "todo.create", dueAt === undefined ? { text } : { text, dueAt });
        if (action.state !== "executed") return `Not allowed right now (${action.state}).`;
        const id = (action.result as { todoId?: string }).todoId ?? "?";
        const summary =
          dueAt === undefined ? `Created todo "${text}" without due time.` : `Created todo "${text}" due ${formatDue(dueAt, timeZone)}.`;
        store.orchestratorEvents.addWrite(event.id, summary);
        return `${summary} (id ${id})`;
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
        const shown = deps.isMailTodo?.(todo.id) === true ? "(todo from mail)" : todo.text;
        const summary =
          event_ === "snooze" && dueAt !== undefined
            ? `Snoozed "${shown}" until ${formatDue(dueAt, timeZone)}.`
            : `${event_ === "complete" ? "Completed" : "Dropped"} "${shown}".`;
        store.orchestratorEvents.addWrite(event.id, summary);
        return summary;
      },

      // One call counts as one change: shopping items only touch the local list and are easy to undo.
      async add_to_shopping_list({ items }) {
        const before = store.orchestratorEvents.get(event.id)?.writes.length ?? 0;
        if (before >= MAX_WRITES_PER_MESSAGE) throw new ToolInputError(`limit of ${MAX_WRITES_PER_MESSAGE} changes per message reached`);
        const added: string[] = [];
        const summary = (): string => `Added to the shopping list: ${added.join(", ")}.`;
        try {
          for (const item of items) {
            const payload = {
              name: item.name,
              ...(item.quantity === null || item.quantity === undefined ? {} : { quantity: item.quantity }),
              ...(item.kind === null || item.kind === undefined ? {} : { kind: item.kind }),
            };
            const action = await dispatchUncounted(event, "shopping.add", payload);
            if (action.state !== "executed") break;
            added.push(payload.quantity === undefined ? payload.name : `${payload.name} (${payload.quantity})`);
          }
        } catch (error) {
          // Items added before the failure stay added; they still get a receipt.
          if (added.length > 0) store.orchestratorEvents.addWrite(event.id, summary());
          throw error;
        }
        if (added.length === 0) return "Not allowed right now.";
        store.orchestratorEvents.addWrite(event.id, summary());
        return added.length === items.length ? summary() : `${summary()} The rest was not allowed right now.`;
      },

      async update_shopping_item({ item_id, action: change }) {
        const item = store.shopping.get(item_id);
        if (item === undefined) throw new ToolInputError(`shopping item ${item_id} not found`);
        if (change !== "remove") {
          if (change === "stock" && item.kind === "once") {
            throw new ToolInputError("a one-off item cannot be in stock; remove it instead");
          }
          try {
            nextShoppingState(item.kind, item.state, change);
          } catch (error) {
            if (error instanceof ShoppingTransitionError) throw new ToolInputError(error.message);
            throw error;
          }
        }
        const action = await dispatch(event, "shopping.update", { itemId: item_id, event: change });
        if (action.state !== "executed") return `Not allowed right now (${action.state}).`;
        const summary = {
          check: `Checked "${item.name}" on the shopping list.`,
          uncheck: `Put "${item.name}" back on the shopping list.`,
          need: `Put "${item.name}" on the shopping list.`,
          stock: `Marked "${item.name}" as in stock.`,
          remove: `Removed "${item.name}" from the shopping list.`,
        }[change];
        store.orchestratorEvents.addWrite(event.id, summary);
        return summary;
      },
    };
  }

  const withinBudget = (): boolean => store.runs.costSince(startOfToday()) < deps.dailyBudgetUsd;

  async function sendReply(event: InboundEvent, reply: string): Promise<void> {
    store.orchestratorEvents.setReply(event.id, reply);
    const sent = await dispatcher.dispatch({
      type: "message.send",
      payload: { text: reply.slice(0, 4000), conversation: event.conversation },
      idempotencyKey: `${event.id}:reply`,
      actor: ACTOR,
    });
    if (sent.state === "failed") throw new ActionFailedError("reply failed");
  }

  function doneSoFar(event: InboundEvent, reason: string): string | undefined {
    const writes = store.orchestratorEvents.get(event.id)?.writes ?? [];
    return writes.length === 0 ? undefined : [`${reason} Done so far:`, ...writes.map((w) => `- ${w}`)].join("\n");
  }

  const recordUsage = (usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }) =>
    store.runs.record({
      role: ACTOR,
      model: deps.model,
      inputTokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
      outputTokens: usage.outputTokens,
      costUsd: costUsd(deps.model, usage),
      outcome: "response",
    });

  return {
    // Lagebild run over queued watcher items; undefined means "no decision" (paused, budget,
    // API trouble) and the caller falls back to deterministic delivery.
    async triage(items: readonly TriageItemRef[]): Promise<TriageDecision | undefined> {
      if (store.flags.isPaused() || !withinBudget()) return undefined;
      const runId = `triage:${now()}`;
      const handlers = tools({ kind: "text", id: runId, text: "", conversation: "triage", receivedAt: now() });
      try {
        const result = await runTriage({
          createMessage: deps.createMessage,
          model: deps.model,
          effort: deps.effort,
          context: `Current time: ${formatNow(now(), timeZone)}`,
          items,
          feedback: store.feedback.summary(),
          rules: store.rules.active().map((r) => r.match),
          tools: { read_state: handlers.read_state, search_calendar: handlers.search_calendar, create_todo: handlers.create_todo },
          onResponse: recordUsage,
          mayCall: withinBudget,
        });
        return result.decision;
      } catch (error) {
        if (isModelApiError(error)) return undefined;
        throw error;
      }
    },

    async handle(event: Extract<InboundEvent, { kind: "text" }>): Promise<OrchestratorOutcome> {
      if (store.flags.isPaused()) return "paused";

      // A retried event whose run already finished only needs its reply (again).
      const previous = store.orchestratorEvents.get(event.id);
      if (previous?.reply !== undefined) {
        await sendReply(event, previous.reply);
        return "handled";
      }
      if (!withinBudget()) {
        // Completed writes must never be followed by a fallback todo for the same message.
        const partial = doneSoFar(event, "Daily model budget reached mid-answer.");
        if (partial === undefined) return "budget_exhausted";
        await sendReply(event, partial);
        return "handled";
      }

      const history = store.conversation.recent(HISTORY_TURNS, { since: now() - HISTORY_MAX_AGE_MS });
      const alreadyDone =
        previous === undefined || previous.writes.length === 0
          ? ""
          : `\n\nAlready done for this message:\n${previous.writes.map((w) => `- ${w}`).join("\n")}\nDo not repeat these.`;
      let result;
      try {
        result = await runOrchestrator({
          createMessage: deps.createMessage,
          model: deps.model,
          effort: deps.effort,
          role: deps.role,
          history,
          context: `Current time: ${formatNow(now(), timeZone)}${alreadyDone}`,
          input: event.text,
          tools: tools(event),
          mayCall: withinBudget,
          onResponse: (usage) =>
            store.runs.record({
              role: ACTOR,
              model: deps.model,
              inputTokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
              outputTokens: usage.outputTokens,
              costUsd: costUsd(deps.model, usage),
              outcome: "response",
            }),
        });
      } catch (error) {
        if (!isModelApiError(error)) throw error;
        // After a completed write a fallback todo would duplicate work; report what happened instead.
        const partial = doneSoFar(event, "The model failed mid-answer.");
        if (partial === undefined) return "unavailable";
        await sendReply(event, partial);
        return "handled";
      }

      const modelReply =
        result.reply ??
        (result.outcome === "budget_exhausted"
          ? (doneSoFar(event, "Daily model budget reached mid-answer.") ??
            "Daily model budget reached mid-answer. Try /todos, /health or /status.")
          : result.outcome === "refusal"
            ? "Sorry, I can't help with that. Try /todos, /health or /status."
            : (doneSoFar(event, "I couldn't finish that.") ?? "Sorry, I couldn't finish that. Please try again or rephrase."));
      // Receipts come from code, not from the model: they list what really changed.
      const writes = store.orchestratorEvents.get(event.id)?.writes ?? [];
      const receipts =
        writes.length > 0
          ? `\n\n${writes.map((w) => `✓ ${w}`).join("\n")}`
          : CLAIMS_CHANGE.test(modelReply)
            ? "\n\n(No change was made.)"
            : "";
      const reply = `${modelReply}${receipts}`;
      await sendReply(event, reply);
      store.conversation.append({ role: "operator", text: event.text });
      store.conversation.append({ role: "assistant", text: reply });
      return "handled";
    },
  };
}

// Knowledge errors (bad path, unknown revision, scope) go back to the model as fixable input.
async function knowledgeCall(call: () => Promise<string>): Promise<string> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof Error && error.name === "KnowledgeError") throw new ToolInputError(error.message);
    throw error;
  }
}

// API and connection errors mean "model unavailable"; anything else is our bug and propagates.
function isModelApiError(error: unknown): boolean {
  return error instanceof Anthropic.APIError || typeof (error as { status?: unknown }).status === "number";
}

export function anthropicCreateMessage(apiKey: string): CreateMessage {
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 45_000 });
  return (params) => client.beta.messages.create(params);
}
