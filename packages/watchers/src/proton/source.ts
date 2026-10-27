import { z } from "zod";
import { WatcherError } from "../server-health/server-health.ts";
import type { ProtonCommand } from "./cli.ts";

export interface MailSummary {
  id: string;
  // Untrusted: written by the sender.
  subject: string;
  fromName: string;
  fromAddress: string;
  time: number;
}

export interface MailMessage {
  id: string;
  subject: string;
  fromAddress: string;
  recipients: string[];
  time: number;
  // Untrusted: may only reach a tool-less reader, never the orchestrator.
  body: string;
}

export interface CalendarEvent {
  key: string;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  // Undefined when the CLI reports none; only a present organizer can establish ownership.
  organizer: string | undefined;
  cancelled: boolean;
}

const listSchema = z.object({
  has_more: z.boolean().optional(),
  messages: z.array(
    z.object({
      id: z.string(),
      subject: z.string(),
      from_name: z.string(),
      from_address: z.string(),
      time: z.number(),
    }),
  ),
});
const person = z.object({ Address: z.string() });
const getSchema = z.object({
  id: z.string(),
  subject: z.string(),
  from: person,
  to: z.array(person),
  cc: z.array(person).optional(),
  time: z.number(),
  body: z.string(),
});
const eventsSchema = z.object({
  events: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      start: z.string(),
      end: z.string(),
      all_day: z.boolean(),
      occurrence: z.string().optional(),
      organizer: z.string().optional(),
      status: z.string().optional(),
    }),
  ),
});

const MAX_LOOKBACK_HOURS = 7 * 24;

function parse<S extends z.ZodType>(schema: S, raw: unknown, what: string): z.output<S> {
  const result = schema.safeParse(raw);
  if (!result.success) throw new WatcherError(`proton: unexpected ${what} format`);
  return result.data;
}

export function createProtonSource(deps: { call(command: ProtonCommand): Promise<unknown>; maxPages?: number }) {
  const maxPages = deps.maxPages ?? 10;
  return {
    // Inbox mail with time > since, oldest first. complete is false when the page limit cut it short.
    async newMail(window: { since: number; now: number }): Promise<{ mails: MailSummary[]; complete: boolean }> {
      const hours = Math.min(MAX_LOOKBACK_HOURS, Math.max(1, Math.ceil((window.now - window.since) / 3_600_000)));
      const newerThan = hours >= MAX_LOOKBACK_HOURS ? "7d" : `${hours}h`;
      const mails: MailSummary[] = [];
      let complete = false;
      for (let page = 0; page < maxPages; page++) {
        const raw = await deps.call({ kind: "mail.list", folder: "inbox", newerThan, limit: 50, page });
        const parsed = parse(listSchema, raw, "mail list");
        mails.push(
          ...parsed.messages.map((m) => ({
            id: m.id,
            subject: m.subject,
            fromName: m.from_name,
            fromAddress: m.from_address,
            time: m.time * 1000,
          })),
        );
        if (parsed.has_more !== true) {
          complete = true;
          break;
        }
      }
      return { mails: mails.filter((m) => m.time > window.since).sort((a, b) => a.time - b.time), complete };
    },

    async readMail(id: string): Promise<MailMessage> {
      const m = parse(getSchema, await deps.call({ kind: "mail.get", id }), "message");
      return {
        id: m.id,
        subject: m.subject,
        fromAddress: m.from.Address,
        recipients: [...m.to, ...(m.cc ?? [])].map((p) => p.Address),
        time: m.time * 1000,
        body: m.body,
      };
    },

    async events(range: { after: string; before: string }): Promise<CalendarEvent[]> {
      const raw = await deps.call({ kind: "calendar.list", after: range.after, before: range.before });
      return parse(eventsSchema, raw, "calendar").events.map((e) => ({
        key: e.occurrence === undefined || e.occurrence === "" ? e.id : `${e.id}@${e.occurrence}`,
        title: e.title,
        start: Date.parse(e.start),
        end: Date.parse(e.end),
        allDay: e.all_day,
        organizer: e.organizer,
        cancelled: e.status === "cancelled",
      }));
    },
  };
}

export type ProtonSource = ReturnType<typeof createProtonSource>;
