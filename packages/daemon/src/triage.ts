import type { TriageDecision, TriageItemRef } from "@dsptchr/agents";
import { wallClockOf } from "@dsptchr/core";
import type { Store, TriageItem } from "@dsptchr/store";
import { cursorsFor, sendAlertLines, type AlertLine } from "./alerts.ts";
import type { Dispatcher } from "./dispatch.ts";

interface ClockTime {
  hour: number;
  minute: number;
}

export interface TriageDeps {
  store: Store;
  dispatcher: Dispatcher;
  now: () => number;
  timeZone: string;
  // Waking hours: regular runs only inside; urgent items run any time.
  hours: { from: ClockTime; to: ClockTime };
  intervalMs: number;
  // The model's decision; undefined (or no run function) falls back to notifying everything.
  run?: (items: readonly TriageItemRef[]) => Promise<TriageDecision | undefined>;
}

const SOURCE = "triage";
const MAX_BRIEFING_LINES = 15;

// Lagebild (D-63): watchers queue their items here instead of alerting directly. A triage run
// decides what the operator sees now, in the briefing, or never.
export function createTriage(deps: TriageDeps) {
  const { store, dispatcher, now, timeZone } = deps;
  const cursors = cursorsFor(store, SOURCE);

  const inHours = (): boolean => {
    const w = wallClockOf(now(), timeZone);
    const minutes = w.hour * 60 + w.minute;
    return minutes >= deps.hours.from.hour * 60 + deps.hours.from.minute && minutes < deps.hours.to.hour * 60 + deps.hours.to.minute;
  };

  const toLine = (item: TriageItem, state: "notified"): AlertLine => ({
    text: item.text,
    apply: () => store.triage.settle([item.id], state),
    feedback: { source: item.source, externalId: item.externalId, features: item.features, label: item.label },
  });

  return {
    // Lines with feedback go to the queue and count as recorded; status lines without
    // feedback (resolved, green again) are sent directly under `directTitle`.
    async submit(lines: AlertLine[], isUrgent: (line: AlertLine) => boolean, directTitle = "Updates"): Promise<void> {
      const direct = lines.filter((l) => l.feedback === undefined);
      store.transaction(() => {
        for (const line of lines) {
          if (line.feedback === undefined) continue;
          if (!store.rules.mutes(line.feedback.features)) {
            store.triage.enqueue({ ...line.feedback, text: line.text, urgent: isUrgent(line) });
          }
          line.apply();
        }
      });
      if (direct.length > 0) {
        await sendAlertLines(dispatcher, store, { title: directTitle, lines: direct, keyBase: `${SOURCE}:direct:${now()}` });
      }
    },

    async tick(): Promise<boolean> {
      const pending = store.triage.pending().filter((item) => !store.rules.mutes(item.features));
      if (pending.length === 0) return false;
      const lastRun = cursors.number("last_run");
      const due = store.triage.hasUrgent() || (inHours() && (lastRun === undefined || now() - lastRun >= deps.intervalMs));
      if (!due) return false;
      cursors.set("last_run", now());

      // Short refs per run; the model never sees queue IDs or item text.
      const byRef = new Map(pending.map((item, index) => [`r${index + 1}`, item]));
      const refs: TriageItemRef[] = [...byRef].map(([ref, item]) => ({ ref, source: item.source, urgent: item.urgent, features: item.features }));
      let decision: TriageDecision | undefined;
      try {
        decision = await deps.run?.(refs);
      } catch {
        decision = undefined;
      }
      const notify = decision === undefined ? [...byRef.keys()] : decision.notify;
      const pick = (list: string[]): TriageItem[] => list.map((r) => byRef.get(r)).filter((i): i is TriageItem => i !== undefined);

      if (decision !== undefined) {
        store.triage.settle(pick(decision.briefing).map((i) => i.id), "briefing");
        store.triage.settle(pick(decision.drop).map((i) => i.id), "dropped");
      }
      const lines = pick(notify).map((item) => toLine(item, "notified"));
      if (lines.length > 0) {
        await sendAlertLines(dispatcher, store, {
          title: "Lagebild",
          lines,
          keyBase: `${SOURCE}:${now()}`,
          intro: decision?.message ?? null,
        });
      }
      return true;
    },

    briefing(): string[] {
      const items = store.triage.forBriefing();
      if (items.length === 0) return [];
      return [
        "Since yesterday:",
        ...items.slice(0, MAX_BRIEFING_LINES).map((i) => `- ${i.label}`),
        ...(items.length > MAX_BRIEFING_LINES ? [`… and ${items.length - MAX_BRIEFING_LINES} more`] : []),
      ];
    },

    // Called after the morning briefing went out.
    briefed(): void {
      store.triage.settle(store.triage.forBriefing().map((i) => i.id), "briefed");
    },
  };
}

export type Triage = ReturnType<typeof createTriage>;
