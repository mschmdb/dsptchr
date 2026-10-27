import type { MailReading } from "@dsptchr/agents";
import { parseDue, splitTodoInput } from "@dsptchr/core";
import type { Store } from "@dsptchr/store";
import { sanitizeUntrusted, type MailMessage, type MailSummary } from "@dsptchr/watchers";
import { claimRun, cursorsFor, sendAlertLines, type AlertLine } from "./alerts.ts";
import type { Dispatcher } from "./dispatch.ts";
import { formatDue } from "./format.ts";

export const MAIL_SOURCE = "mail";
const SOURCE = MAIL_SOURCE;
const ACTOR = "watcher";
const KEEP_MS = 3 * 86_400_000;
const DAY_MS = 86_400_000;
const WORTH_READING = new Set(["personal", "important"]);

export interface MailMonitorDeps {
  store: Store;
  dispatcher: Dispatcher;
  listMail(window: { since: number; now: number }): Promise<{ mails: MailSummary[]; complete: boolean }>;
  readMail(id: string): Promise<MailMessage>;
  classify(message: MailMessage): Promise<MailReading>;
  mayClassify(): boolean;
  ownAddresses: readonly string[];
  todoAddress?: string;
  intervalMs: number;
  now: () => number;
  timeZone: string;
}

interface MailData {
  from: string;
  subject: string;
  category: MailReading["category"] | "todo";
  urgency: MailReading["urgency"];
  actionNeeded: boolean;
  summary: string;
  time: number;
}

// Mail is untrusted. The tool-less reader classifies it; sender, subject and summary reach the
// operator sanitized, the orchestrator sees counts only (AR-2, D-50).
export function createMailMonitor(deps: MailMonitorDeps) {
  const { store, dispatcher, now, timeZone } = deps;
  const cursors = cursorsFor(store, SOURCE);
  const own = new Set(deps.ownAddresses.map((a) => a.toLowerCase()));
  const todoAddress = deps.todoAddress?.toLowerCase();

  const recent = (): MailData[] =>
    store.observations
      .listOpen(SOURCE)
      .map((o) => o.data as MailData)
      .filter((d) => d.time >= now() - DAY_MS);

  // True once the todo exists; false leaves the mail unprocessed for the next run.
  async function captureTodo(message: MailMessage): Promise<boolean> {
    const input = splitTodoInput(message.subject);
    const text = input.text === "" ? "Todo from mail" : input.text.slice(0, 500);
    const dueAt = input.due === undefined ? undefined : parseDue(input.due, now(), timeZone);
    // A denial (e.g. rate limit) is final for its key, so each retry after a denial gets a new attempt.
    const attempt = cursors.number(`attempt:${message.id}`) ?? 0;
    const created = await dispatcher.dispatch({
      type: "todo.create",
      payload: dueAt === undefined ? { text } : { text, dueAt },
      idempotencyKey: `mail:${message.id}:todo:${attempt}`,
      actor: ACTOR,
    });
    if (created.state === "denied") cursors.set(`attempt:${message.id}`, attempt + 1);
    if (created.state !== "executed") return false;
    const todoId = (created.result as { todoId?: unknown }).todoId;
    if (typeof todoId === "string") cursors.set(`todo:${todoId}`, "1");
    const due = dueAt === undefined ? "" : ` (due ${formatDue(dueAt, timeZone)})`;
    const note = input.due !== undefined && dueAt === undefined ? ` (due date "${input.due}" not understood)` : "";
    await dispatcher.dispatch({
      type: "message.send",
      payload: { text: `Saved from mail: ${text}${due}${note}` },
      idempotencyKey: `mail:${message.id}:reply`,
      actor: ACTOR,
    });
    return true;
  }

  // undefined: handled; "retry": leave for the next run; AlertLine: handled once the alert went out.
  async function process(summary: MailSummary): Promise<AlertLine | "retry" | undefined> {
    const message = await deps.readMail(summary.id);
    const from = message.fromAddress.toLowerCase();
    const base = {
      from: sanitizeUntrusted(message.fromAddress, 120),
      subject: sanitizeUntrusted(message.subject, 120),
      time: message.time,
    };

    // Todo mail counts only from the operator's own addresses; others are ordinary mail.
    if (todoAddress !== undefined && own.has(from) && message.recipients.some((r) => r.toLowerCase() === todoAddress)) {
      if (!(await captureTodo(message))) return "retry";
      store.observations.observe({
        source: SOURCE,
        externalId: message.id,
        version: "todo",
        data: { ...base, category: "todo", urgency: "later", actionNeeded: false, summary: "" } satisfies MailData,
      });
      return undefined;
    }

    const reading: MailReading = deps.mayClassify()
      ? await deps.classify(message)
      : { category: "unclassified", urgency: "later", actionNeeded: false, summary: "" };
    const data: MailData = { ...base, ...reading, summary: sanitizeUntrusted(reading.summary, 200) };
    const observe = (): void => {
      store.observations.observe({ source: SOURCE, externalId: message.id, version: reading.category, data });
    };
    if (reading.urgency === "now" && WORTH_READING.has(reading.category)) {
      return { text: `- ${data.from}: ${data.subject}${data.summary === "" ? "" : `\n  ${data.summary}`}`, apply: observe };
    }
    observe();
    return undefined;
  }

  return {
    async tick(): Promise<boolean> {
      if (!claimRun(store, SOURCE, deps.intervalMs, now())) return false;
      const since = cursors.number("since");
      const listing = await deps.listMail({ since: since ?? now(), now: now() });
      if (since === undefined) {
        // First run: start from now instead of reading the whole inbox.
        cursors.set("since", now());
        return true;
      }
      const lines: AlertLine[] = [];
      let latest = since;
      // A listing cut short by the page limit means a large backlog. Waiting would refetch the same
      // newest pages forever, so the run continues; the operator hears once per backlog that older
      // mail was skipped, and that notice stays pending until it is delivered.
      let allHandled = true;
      const backlog = cursors.get("backlog") ?? "none";
      if (!listing.complete && backlog === "none") cursors.set("backlog", "pending");
      if (listing.complete && backlog === "sent") cursors.set("backlog", "none");
      if (cursors.get("backlog") === "pending") {
        const notice = await dispatcher.dispatch({
          type: "message.send",
          payload: { text: "Mail backlog too large to read at once; some older mail was skipped. Please check your inbox." },
          idempotencyKey: `${SOURCE}:backlog:${now()}`,
          actor: ACTOR,
        });
        if (notice.state === "executed") cursors.set("backlog", "sent");
      }
      for (const mail of listing.mails) {
        if (store.observations.get(SOURCE, mail.id) !== undefined) {
          latest = Math.max(latest, mail.time);
          continue;
        }
        const result = await process(mail);
        if (result === "retry") {
          allHandled = false;
          continue;
        }
        if (result !== undefined) lines.push(result);
        latest = Math.max(latest, mail.time);
      }
      const delivered = await sendAlertLines(dispatcher, store, { title: "Mail", lines, keyBase: `${SOURCE}:${now()}` });
      // The cursor only moves when every mail up to it is recorded; the rest is retried.
      if (allHandled && delivered) cursors.set("since", latest);
      for (const open of store.observations.listOpen(SOURCE)) {
        if ((open.data as MailData).time < now() - KEEP_MS) store.observations.resolve(SOURCE, open.externalId);
      }
      return true;
    },

    isMailTodo(todoId: string): boolean {
      return cursors.get(`todo:${todoId}`) === "1";
    },

    briefing(): string[] {
      const mails = recent().filter((d) => d.category !== "todo");
      if (mails.length === 0) return [];
      const worth = mails.filter((d) => WORTH_READING.has(d.category));
      const other = mails.length - worth.length;
      const head = `Mail (24 h): ${worth.length} worth reading${other === 0 ? "" : `, ${other} other`}.`;
      return [
        head,
        ...worth.slice(0, 5).map((d) => `- ${d.from}: ${d.subject}${d.actionNeeded ? " (action needed)" : ""}`),
        ...(worth.length > 5 ? [`… and ${worth.length - 5} more (/mail)`] : []),
      ];
    },

    lines(): string[] {
      return recent()
        .filter((d) => d.category !== "todo")
        .sort((a, b) => b.time - a.time)
        .slice(0, 20)
        .map((d) => `- [${d.category}] ${d.from}: ${d.subject}${d.summary === "" ? "" : `\n  ${d.summary}`}`);
    },

    forModel(): { last_24h: Record<string, number>; action_needed: number; urgent: number } {
      const mails = recent().filter((d) => d.category !== "todo");
      const counts: Record<string, number> = {};
      for (const d of mails) counts[d.category] = (counts[d.category] ?? 0) + 1;
      return {
        last_24h: counts,
        action_needed: mails.filter((d) => d.actionNeeded).length,
        urgent: mails.filter((d) => d.urgency === "now").length,
      };
    },
  };
}

export type MailMonitor = ReturnType<typeof createMailMonitor>;
