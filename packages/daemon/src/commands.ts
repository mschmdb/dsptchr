import type { Button } from "@dsptchr/channels";
import type { Store } from "@dsptchr/store";
import { formatDue } from "./format.ts";
import { HEALTH_SOURCE } from "./health.ts";

export interface CommandReply {
  text: string;
  buttons?: Button[][];
}

const MAX_BUTTON_ROWS = 8;
// 25 lines of at most ~150 characters stay well inside one 4,096-character message.
const MAX_LINES = 25;
const MAX_TEXT = 120;
const COMMAND = /^\/([a-z]+)(?:@\w+)?$/i;

export const HELP = "Commands: /todos, /health, /status. Any other text becomes a todo; add a due date after \" @ \".";

// Fixed, deterministic read-only commands. Free questions need the orchestrator (model).
export function parseCommand(text: string): string | undefined {
  return COMMAND.exec(text.trim())?.[1]?.toLowerCase();
}

export function runCommand(name: string, store: Store, timeZone: string): CommandReply {
  switch (name) {
    case "todos":
      return todos(store, timeZone);
    case "health":
      return { text: health(store, timeZone) };
    case "status":
      return { text: status(store, timeZone) };
    default:
      return { text: HELP };
  }
}

function todos(store: Store, timeZone: string): CommandReply {
  const active = store.todos.listActive();
  if (active.length === 0) return { text: "No open todos." };
  const lines = capped(
    active.map((t, i) => `${i + 1}. ${shorten(t.text)}${t.dueAt === undefined ? "" : ` (due ${formatDue(t.dueAt, timeZone)})`}`),
  );
  const buttons = active.slice(0, MAX_BUTTON_ROWS).map((t, i) => [
    { label: `${i + 1} Done`, data: `todo:done:${t.id}` },
    { label: `${i + 1} Drop`, data: `todo:drop:${t.id}` },
  ]);
  return { text: ["Open todos:", ...lines].join("\n"), buttons };
}

function lastHealthCheck(store: Store): number | undefined {
  const value = store.cursors.get(`${HEALTH_SOURCE}:last_success`);
  return value === undefined ? undefined : Number(value);
}

function health(store: Store, timeZone: string): string {
  const last = lastHealthCheck(store);
  if (last === undefined) return "Server health: no successful check yet.";
  const open = capped(
    store.observations.listOpen(HEALTH_SOURCE).map((o) => {
      const data = o.data as { host?: string; text?: string };
      return `- ${o.version.toUpperCase()} ${data.host ?? "?"}: ${shorten(data.text ?? "")}`;
    }),
  );
  return [`Server health (last check ${formatDue(last, timeZone)})`, ...(open.length === 0 ? ["All clear."] : open)].join(
    "\n",
  );
}

function status(store: Store, timeZone: string): string {
  const todoCount = store.todos.listActive().length;
  const findings = store.observations.listOpen(HEALTH_SOURCE).length;
  const last = lastHealthCheck(store);
  return [
    store.flags.isPaused() ? "Paused." : "Running.",
    `${todoCount} open ${todoCount === 1 ? "todo" : "todos"}.`,
    `${findings} open health ${findings === 1 ? "finding" : "findings"}.`,
    `Last health check ${last === undefined ? "never" : formatDue(last, timeZone)}.`,
  ].join(" ");
}

function shorten(text: string): string {
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 1)}…`;
}

function capped(lines: string[]): string[] {
  return lines.length <= MAX_LINES ? lines : [...lines.slice(0, MAX_LINES), `… and ${lines.length - MAX_LINES} more`];
}
