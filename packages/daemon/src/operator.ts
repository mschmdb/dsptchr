import type { InboundEvent } from "@dsptchr/channels";
import { parseDue, splitTodoInput } from "@dsptchr/core";
import type { Store, StoredAction } from "@dsptchr/store";
import type { Dispatcher } from "./dispatch.ts";
import type { OrchestratorOutcome } from "./orchestrator.ts";
import { parseCommand, runCommand } from "./commands.ts";
import { formatDue } from "./format.ts";

export interface OperatorHandlerDeps {
  store: Store;
  dispatcher: Dispatcher;
  timeZone: string;
  now: () => number;
  // Optional model-backed handling of free text; without it every free text is a todo.
  orchestrator?: { handle(event: Extract<InboundEvent, { kind: "text" }>): Promise<OrchestratorOutcome> };
}

const FALLBACK_NOTES: Partial<Record<OrchestratorOutcome, string>> = {
  unavailable: "Model unavailable, handled as plain todo.",
  budget_exhausted: "Daily model budget used up, handled as plain todo.",
};

const STOP_WORDS = new Set(["stop", "stopp"]);
const START_WORDS = new Set(["start", "resume", "weiter"]);
const BUTTON = /^todo:(done|drop|hour|tomorrow):([^:]+)$/;
const ACTOR = "operator";
const MAX_NOTE = 120;

export class ActionFailedError extends Error {
  override name = "ActionFailedError";
}

// A failed action makes the handler throw, so the inbox retries the whole event.
// Every dispatch uses a key derived from the event ID, so completed steps do not repeat.
function ensureNotFailed(action: StoredAction): StoredAction {
  if (action.state === "failed") {
    throw new ActionFailedError(`action ${action.type} failed`);
  }
  return action;
}

function shorten(text: string): string {
  return text.length <= MAX_NOTE ? text : `${text.slice(0, MAX_NOTE - 1)}…`;
}

// Handles operator input from any channel. Every effect goes through the dispatcher.
export function createOperatorHandler({ store, dispatcher, timeZone, now, orchestrator }: OperatorHandlerDeps) {
  const reply = async (event: InboundEvent, text: string) =>
    ensureNotFailed(
      await dispatcher.dispatch({
        type: "message.send",
        payload: { text, conversation: event.conversation },
        idempotencyKey: `${event.id}:reply`,
        actor: ACTOR,
      }),
    );

  async function handleText(event: Extract<InboundEvent, { kind: "text" }>): Promise<void> {
    const word = event.text.trim().toLowerCase();
    if (STOP_WORDS.has(word)) {
      // dispatch() passes the gate synchronously before its first await, so the
      // confirmation is approved before the pause and the pause never waits for the network.
      const confirmation = reply(event, "Paused. All actions are blocked. Send \"start\" to resume.");
      if (!store.flags.isPaused()) store.flags.setPaused(true, ACTOR);
      await confirmation;
      return;
    }
    if (START_WORDS.has(word)) {
      if (store.flags.isPaused()) store.flags.setPaused(false, ACTOR);
      await reply(event, "Resumed.");
      return;
    }

    const command = parseCommand(event.text);
    if (command !== undefined || event.text.trim().startsWith("/")) {
      const result = runCommand(command ?? "", store, timeZone);
      ensureNotFailed(
        await dispatcher.dispatch({
          type: "message.send",
          payload: {
            text: result.text,
            conversation: event.conversation,
            ...(result.buttons === undefined ? {} : { buttons: result.buttons }),
          },
          idempotencyKey: `${event.id}:reply`,
          actor: ACTOR,
        }),
      );
      return;
    }

    // The kill switch and commands above never depend on a model.
    let note = "";
    if (orchestrator !== undefined) {
      const outcome = await orchestrator.handle(event);
      if (outcome === "handled") return;
      note = FALLBACK_NOTES[outcome] === undefined ? "" : `${FALLBACK_NOTES[outcome]}\n`;
    }

    const input = splitTodoInput(event.text);
    if (input.text === "") return;
    let dueAt: number | undefined;
    if (input.due !== undefined) {
      dueAt = parseDue(input.due, now(), timeZone);
      if (dueAt === undefined) {
        await reply(event, `Could not read the due date "${input.due}". Try "in 2h", "18:00", "morgen 9:00" or "2.11. 14:00".`);
        return;
      }
    }

    const action = ensureNotFailed(
      await dispatcher.dispatch({
        type: "todo.create",
        payload: dueAt === undefined ? { text: input.text } : { text: input.text, dueAt },
        idempotencyKey: `${event.id}:todo.create`,
        actor: ACTOR,
      }),
    );
    if (action.state === "executed") {
      await reply(
        event,
        `${note}${dueAt === undefined ? `Saved: ${input.text}` : `Saved: ${input.text} (due ${formatDue(dueAt, timeZone)})`}`,
      );
    }
  }

  const acknowledge = async (event: Extract<InboundEvent, { kind: "button" }>, note: string) =>
    ensureNotFailed(
      await dispatcher.dispatch({
        type: "message.ack",
        payload: {
          conversation: event.conversation,
          messageRef: event.messageRef,
          callbackRef: event.callbackRef,
          note: shorten(note),
        },
        idempotencyKey: `${event.id}:ack`,
        actor: ACTOR,
      }),
    );

  async function handleButton(event: Extract<InboundEvent, { kind: "button" }>): Promise<void> {
    const match = BUTTON.exec(event.data);
    if (match === null) {
      store.audit.append({ actor: ACTOR, event: "operator.unknown_button" });
      await acknowledge(event, "Unknown action");
      return;
    }
    const [, command, todoId = ""] = match;
    const todo = store.todos.get(todoId);
    if (todo === undefined) {
      await acknowledge(event, "Todo not found");
      return;
    }
    if (todo.state === "done" || todo.state === "dropped") {
      await acknowledge(event, `Already ${todo.state}: ${todo.text}`);
      return;
    }

    const payload =
      command === "done" || command === "drop"
        ? { todoId, event: command === "done" ? "complete" : "drop" }
        : { todoId, event: "snooze", dueAt: command === "hour" ? now() + 3_600_000 : (parseDue("morgen", now(), timeZone) ?? now()) };
    const action = ensureNotFailed(
      await dispatcher.dispatch({
        type: "todo.update",
        payload,
        idempotencyKey: `${event.id}:todo.update`,
        actor: ACTOR,
      }),
    );
    if (action.state !== "executed") return;
    await acknowledge(
      event,
      payload.dueAt === undefined
        ? `${command === "drop" ? "Dropped" : "Done"}: ${todo.text}`
        : `Snoozed until ${formatDue(payload.dueAt, timeZone)}`,
    );
  }

  return {
    async handle(event: InboundEvent): Promise<void> {
      if (event.kind === "text") {
        await handleText(event);
      } else {
        await handleButton(event);
      }
    },
  };
}
