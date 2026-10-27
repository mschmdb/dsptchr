import type { Store } from "@dsptchr/store";
import type { Dispatcher } from "./dispatch.ts";
import { formatDue } from "./format.ts";

// Shared plumbing for watcher monitors: run interval, failure streaks and chunked alerts.

export interface AlertLine {
  text: string;
  // Records the change; runs only after the operator was told.
  apply(): void;
}

const ACTOR = "watcher";
// Stays well below the 4,096 characters a Telegram message can hold.
const MAX_MESSAGE = 3500;

export function cursorsFor(store: Store, source: string) {
  const key = (name: string): string => `${source}:${name}`;
  return {
    get: (name: string): string | undefined => store.cursors.get(key(name)),
    number: (name: string): number | undefined => {
      const value = store.cursors.get(key(name));
      return value === undefined ? undefined : Number(value);
    },
    set: (name: string, value: string | number): void => store.cursors.set(key(name), String(value)),
  };
}

// True when a run is due; records the run start. Never runs while paused.
export function claimRun(store: Store, source: string, intervalMs: number, now: number): boolean {
  if (store.flags.isPaused()) return false;
  const cursors = cursorsFor(store, source);
  const lastRun = cursors.number("last_run");
  if (lastRun !== undefined && now - lastRun < intervalMs) return false;
  cursors.set("last_run", now);
  return true;
}

export interface FailureStreakDeps {
  store: Store;
  dispatcher: Dispatcher;
  source: string;
  label: string;
  now: () => number;
  timeZone: string;
  threshold: number;
}

// Alerts once per failure streak; a denied or failed alert is retried on the next failure.
export function failureStreak({ store, dispatcher, source, label, now, timeZone, threshold }: FailureStreakDeps) {
  const cursors = cursorsFor(store, source);
  return {
    async failed(error: unknown): Promise<void> {
      const failures = (cursors.number("failures") ?? 0) + 1;
      cursors.set("failures", failures);
      if (failures < threshold || cursors.get("failure_alerted") === "1") return;
      const lastSuccess = cursors.number("last_success");
      const kind = error instanceof Error ? error.name : "unknown error";
      const action = await dispatcher.dispatch({
        type: "message.send",
        payload: {
          text: `${label} failed ${failures} times in a row (${kind}). Last success: ${
            lastSuccess === undefined ? "never" : formatDue(lastSuccess, timeZone)
          }.`,
        },
        idempotencyKey: `${source}:failing:${now()}`,
        actor: ACTOR,
      });
      if (action.state === "executed") cursors.set("failure_alerted", "1");
    },
    succeeded(): void {
      cursors.set("failures", 0);
      cursors.set("failure_alerted", "0");
      cursors.set("last_success", now());
    },
  };
}

// Sends lines in as many messages as needed and applies each part once it went out.
// Undelivered parts stay unrecorded, so the next run reports them again.
export async function sendAlertLines(
  dispatcher: Dispatcher,
  store: Store,
  options: { title: string; lines: AlertLine[]; keyBase: string },
): Promise<void> {
  const parts = chunk(options.lines);
  for (const [index, part] of parts.entries()) {
    const title = parts.length === 1 ? options.title : `${options.title} (${index + 1}/${parts.length})`;
    const action = await dispatcher.dispatch({
      type: "message.send",
      payload: { text: [title, ...part.map((l) => l.text)].join("\n") },
      idempotencyKey: `${options.keyBase}:${index}`,
      actor: ACTOR,
    });
    if (action.state !== "executed") break;
    store.transaction(() => part.forEach((l) => l.apply()));
  }
}

function chunk(lines: AlertLine[]): AlertLine[][] {
  const parts: AlertLine[][] = [];
  let current: AlertLine[] = [];
  let size = 0;
  for (const line of lines) {
    if (current.length > 0 && size + line.text.length + 1 > MAX_MESSAGE) {
      parts.push(current);
      current = [];
      size = 0;
    }
    current.push(line);
    size += line.text.length + 1;
  }
  if (current.length > 0) parts.push(current);
  return parts;
}
