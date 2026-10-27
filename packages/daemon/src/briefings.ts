import { addDays, wallClockOf, wallClockToUtc, type Todo } from "@dsptchr/core";
import type { Store } from "@dsptchr/store";
import type { Dispatcher } from "./dispatch.ts";
import { formatDue } from "./format.ts";

export type BriefingKind = "morning" | "evening";

interface ClockTime {
  hour: number;
  minute: number;
}

export interface BriefingDeps {
  store: Store;
  dispatcher: Dispatcher;
  timeZone: string;
  times: { [K in BriefingKind]?: ClockTime | undefined };
  now: () => number;
  // Watcher summaries for the morning briefing, one line each.
  extras?: () => string[];
  // Called once the morning briefing went out (e.g. to mark triage items as briefed).
  onMorningSent?: () => void;
}

const KINDS: readonly BriefingKind[] = ["morning", "evening"];

// Sends each briefing once per day at its time. A briefing missed while the machine
// slept runs once later the same day; missed days are not replayed.
export function createBriefings({ store, dispatcher, timeZone, times, now, extras = () => [], onMorningSent }: BriefingDeps) {
  const cursorKey = (kind: BriefingKind): string => `briefing:${kind}`;

  function todaySlot(time: ClockTime): number {
    const today = wallClockOf(now(), timeZone);
    return wallClockToUtc({ ...today, ...time }, timeZone);
  }

  function endOfToday(): number {
    const today = wallClockOf(now(), timeZone);
    return wallClockToUtc(addDays({ ...today, hour: 0, minute: 0 }, 1), timeZone);
  }

  function render(kind: BriefingKind): string {
    const active = store.todos.listActive();
    const startOfDay = wallClockToUtc({ ...wallClockOf(now(), timeZone), hour: 0, minute: 0 }, timeZone);
    const due = active.filter((t): t is Todo & { dueAt: number } => t.dueAt !== undefined && t.dueAt < endOfToday());
    const lines = due.map((t) =>
      t.dueAt < startOfDay ? `- overdue: ${t.text}` : `- ${formatDue(t.dueAt, timeZone).slice(-5)} ${t.text}`,
    );

    if (kind === "morning") {
      const undated = active.filter((t) => t.dueAt === undefined).length;
      const body = lines.length === 0 ? ["Nothing due today."] : ["Due today:", ...lines];
      const tail = undated > 0 ? [`${undated} more without a due date.`] : [];
      return ["Good morning.", ...body, ...tail, ...extras()].join("\n");
    }
    return ["Evening check.", ...(lines.length === 0 ? ["Nothing left open for today."] : ["Still open:", ...lines])].join("\n");
  }

  return {
    // Returns the number of briefings sent.
    async tick(): Promise<number> {
      if (store.flags.isPaused()) return 0;
      let sent = 0;
      for (const kind of KINDS) {
        const time = times[kind];
        if (time === undefined) continue;
        const slot = todaySlot(time);
        const last = Number(store.cursors.get(cursorKey(kind)) ?? 0);
        if (now() < slot || last >= slot) continue;

        const action = await dispatcher.dispatch({
          type: "message.send",
          payload: { text: render(kind) },
          idempotencyKey: `briefing:${kind}:${slot}`,
          actor: "scheduler",
        });
        if (action.state === "executed") {
          store.cursors.set(cursorKey(kind), String(slot));
          if (kind === "morning") onMorningSent?.();
          sent++;
        }
      }
      return sent;
    },
  };
}
