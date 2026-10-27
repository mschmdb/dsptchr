import type { Store } from "@dsptchr/store";
import { sanitizeUntrusted, type HealthFinding, type HealthReport } from "@dsptchr/watchers";
import type { Dispatcher } from "./dispatch.ts";
import { formatDue } from "./format.ts";

export interface HealthMonitorDeps {
  store: Store;
  dispatcher: Dispatcher;
  check(): Promise<HealthReport>;
  intervalMs: number;
  now: () => number;
  timeZone?: string;
  failureThreshold?: number;
}

const SOURCE = "server-health";
const ACTOR = "watcher";
const MAX_TEXT = 160;
const MAX_KEY = 80;
// Stays well below the 4,096 characters a Telegram message can hold.
const MAX_MESSAGE = 3500;

interface Line {
  text: string;
  apply(): void;
}

// Turns server health reports into operator messages. Deterministic: no model sees the
// findings. Their text comes from the servers, so it is sanitized and only ever sent to
// the operator's own conversation (D-40).
export function createHealthMonitor({
  store,
  dispatcher,
  check,
  intervalMs,
  now,
  timeZone = "UTC",
  failureThreshold = 3,
}: HealthMonitorDeps) {
  const cursor = (name: string): string => `${SOURCE}:${name}`;
  const readNumber = (name: string): number | undefined => {
    const value = store.cursors.get(cursor(name));
    return value === undefined ? undefined : Number(value);
  };

  // Alerts once per failure streak; a denied or failed alert is retried on the next failure.
  async function reportFailure(error: unknown): Promise<void> {
    const failures = (readNumber("failures") ?? 0) + 1;
    store.cursors.set(cursor("failures"), String(failures));
    if (failures < failureThreshold || store.cursors.get(cursor("failure_alerted")) === "1") return;
    const lastSuccess = readNumber("last_success");
    const kind = error instanceof Error ? error.name : "unknown error";
    const action = await dispatcher.dispatch({
      type: "message.send",
      payload: {
        text: `Server health check failed ${failures} times in a row (${kind}). Last success: ${
          lastSuccess === undefined ? "never" : formatDue(lastSuccess, timeZone)
        }.`,
      },
      idempotencyKey: `${SOURCE}:failing:${now()}`,
      actor: ACTOR,
    });
    if (action.state === "executed") store.cursors.set(cursor("failure_alerted"), "1");
  }

  function diff(report: HealthReport): Line[] {
    const active = report.findings.filter((f) => f.severity !== "info");
    const activeKeys = new Set(active.map((f) => f.key));
    const evaluated = new Set(report.evaluatedHosts.map((h) => sanitizeUntrusted(h, MAX_KEY)));
    const lines: Line[] = [];

    for (const finding of active) {
      const existing = store.observations.get(SOURCE, finding.key);
      const observe = (): void => {
        store.observations.observe({
          source: SOURCE,
          externalId: finding.key,
          version: finding.severity,
          data: dataOf(finding),
        });
      };
      if (existing === undefined || existing.state === "resolved") {
        lines.push({ text: line(finding), apply: observe });
      } else if (existing.version !== finding.severity) {
        lines.push({ text: `${line(finding)} (was ${existing.version})`, apply: observe });
      } else {
        observe();
      }
    }

    for (const open of store.observations.listOpen(SOURCE)) {
      const host = (open.data as { host?: unknown }).host;
      if (activeKeys.has(open.externalId) || typeof host !== "string" || !evaluated.has(host)) continue;
      lines.push({
        text: `- resolved: ${sanitizeUntrusted(open.externalId, MAX_KEY)}`,
        apply: () => store.observations.resolve(SOURCE, open.externalId),
      });
    }
    return lines;
  }

  return {
    // Returns true when a check ran.
    async tick(): Promise<boolean> {
      if (store.flags.isPaused()) return false;
      const lastRun = readNumber("last_run");
      if (lastRun !== undefined && now() - lastRun < intervalMs) return false;
      store.cursors.set(cursor("last_run"), String(now()));

      let report: HealthReport;
      try {
        report = await check();
      } catch (error) {
        await reportFailure(error);
        return true;
      }
      store.cursors.set(cursor("failures"), "0");
      store.cursors.set(cursor("failure_alerted"), "0");
      store.cursors.set(cursor("last_success"), String(now()));

      const runAt = now();
      const parts = chunk(diff(report));
      for (const [index, part] of parts.entries()) {
        const title = parts.length === 1 ? "Server health" : `Server health (${index + 1}/${parts.length})`;
        const action = await dispatcher.dispatch({
          type: "message.send",
          payload: { text: [title, ...part.map((l) => l.text)].join("\n") },
          idempotencyKey: `${SOURCE}:${runAt}:${index}`,
          actor: ACTOR,
        });
        // Record changes only once the operator has been told; the rest is reported next run.
        if (action.state !== "executed") break;
        store.transaction(() => part.forEach((l) => l.apply()));
      }
      return true;
    },
  };
}

function chunk(lines: Line[]): Line[][] {
  const parts: Line[][] = [];
  let current: Line[] = [];
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

function dataOf(finding: HealthFinding): { host: string; text: string } {
  return { host: sanitizeUntrusted(finding.host, MAX_KEY), text: sanitizeUntrusted(finding.text, MAX_TEXT) };
}

function line(finding: HealthFinding): string {
  const { host, text } = dataOf(finding);
  return `- ${finding.severity.toUpperCase()} ${host}: ${text}`;
}
