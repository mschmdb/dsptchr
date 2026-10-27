import type { Store } from "@dsptchr/store";
import { sanitizeUntrusted, type HealthFinding, type HealthReport } from "@dsptchr/watchers";
import { claimRun, failureStreak, sendAlertLines, type AlertLine } from "./alerts.ts";
import type { Dispatcher } from "./dispatch.ts";

export interface HealthMonitorDeps {
  store: Store;
  dispatcher: Dispatcher;
  check(): Promise<HealthReport>;
  intervalMs: number;
  now: () => number;
  timeZone?: string;
  failureThreshold?: number;
}

export const HEALTH_SOURCE = "server-health";
const SOURCE = HEALTH_SOURCE;
const MAX_TEXT = 160;
const MAX_KEY = 80;

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
  const streak = failureStreak({
    store,
    dispatcher,
    source: SOURCE,
    label: "Server health check",
    now,
    timeZone,
    threshold: failureThreshold,
  });

  function diff(report: HealthReport): AlertLine[] {
    const active = report.findings.filter((f) => f.severity !== "info");
    const activeKeys = new Set(active.map((f) => f.key));
    const evaluated = new Set(report.evaluatedHosts.map((h) => sanitizeUntrusted(h, MAX_KEY)));
    const lines: AlertLine[] = [];

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
      const feedback = {
        source: "health",
        externalId: finding.key,
        features: { source: "health", host: dataOf(finding).host, check: checkName(finding.key) },
        label: line(finding).slice(2),
      };
      if (existing === undefined || existing.state === "resolved") {
        lines.push({ text: line(finding), apply: observe, feedback });
      } else if (existing.version !== finding.severity) {
        lines.push({ text: `${line(finding)} (was ${existing.version})`, apply: observe, feedback });
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
      if (!claimRun(store, SOURCE, intervalMs, now())) return false;
      let report: HealthReport;
      try {
        report = await check();
      } catch (error) {
        await streak.failed(error);
        return true;
      }
      streak.succeeded();
      await sendAlertLines(dispatcher, store, { title: "Server health", lines: diff(report), keyBase: `${SOURCE}:${now()}` });
      return true;
    },
  };
}

function dataOf(finding: HealthFinding): { host: string; text: string } {
  return { host: sanitizeUntrusted(finding.host, MAX_KEY), text: sanitizeUntrusted(finding.text, MAX_TEXT) };
}

function line(finding: HealthFinding): string {
  const { host, text } = dataOf(finding);
  return `- ${finding.severity.toUpperCase()} ${host}: ${text}`;
}

// Rule suffix of a finding key in a fixed vocabulary, for feedback and mute rules.
function checkName(key: string): string {
  const last = key.split(":").at(-1) ?? "";
  return /^[a-z_]{1,24}$/.test(last) ? last : "other";
}
