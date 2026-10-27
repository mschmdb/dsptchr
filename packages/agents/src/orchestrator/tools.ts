import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

export const readStateInput = z.strictObject({ scope: z.enum(["todos", "calendar", "birthdays", "mail", "health", "github", "status"]) });
export const createTodoInput = z.strictObject({
  text: z.string().trim().min(1).max(500),
  due_at: z.string().max(40).nullable().optional(),
});
export const updateTodoInput = z.strictObject({
  todo_id: z.string().min(1).max(64),
  action: z.enum(["complete", "drop", "snooze"]),
  due_at: z.string().max(40).nullable().optional(),
});

export const searchCalendarInput = z.strictObject({
  query: z.string().trim().max(100).nullable().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export type SearchCalendarInput = z.infer<typeof searchCalendarInput>;
export type ReadStateInput = z.infer<typeof readStateInput>;
export type CreateTodoInput = z.infer<typeof createTodoInput>;
export type UpdateTodoInput = z.infer<typeof updateTodoInput>;

// The orchestrator's whole capability surface (AR-1): read state, propose todo changes.
// Every write becomes a proposal that passes gate and executor.
export interface OrchestratorTools {
  read_state(input: ReadStateInput): Promise<string>;
  search_calendar(input: SearchCalendarInput): Promise<string>;
  create_todo(input: CreateTodoInput): Promise<string>;
  update_todo(input: UpdateTodoInput): Promise<string>;
}

// Thrown by handlers for input the model can fix; it goes back as an error tool result.
export class ToolInputError extends Error {
  override name = "ToolInputError";
}

export const INPUT_SCHEMAS = {
  read_state: readStateInput,
  search_calendar: searchCalendarInput,
  create_todo: createTodoInput,
  update_todo: updateTodoInput,
} as const;

const DUE_AT = {
  type: ["string", "null"],
  description:
    "Due time as ISO 8601 with UTC offset, e.g. 2026-10-28T09:00:00+01:00. Null when no time was given.",
};

export const TOOL_DEFINITIONS: Anthropic.Beta.BetaTool[] = [
  {
    name: "read_state",
    description:
      "Read current state. todos: open todos with id, text, due time. calendar: today's and tomorrow's events (titles of other people's invitations are hidden) and birthdays. birthdays: every contact's birthday with its next date. mail: counts of the last 24 h by category, how many need action or are urgent. health: open server health findings (host, severity, check, since). github: per repository, open PRs and issues by author type and the number of red CI workflows. status: pause state, counts, last health check.",
    input_schema: {
      type: "object",
      properties: { scope: { type: "string", enum: ["todos", "calendar", "birthdays", "mail", "health", "github", "status"] } },
      required: ["scope"],
      additionalProperties: false,
    },
  },
  {
    name: "search_calendar",
    description:
      "Search calendar events by title in a date range (YYYY-MM-DD, inclusive). Without query, lists all events in the range. Covers about 90 days back and 60 days ahead; the result states the window. Titles of other people's invitations are hidden and never match a query.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: ["string", "null"], description: "Words in the title, case-insensitive. Null for all events." },
        from: { type: "string", description: "First day, YYYY-MM-DD" },
        to: { type: "string", description: "Last day, YYYY-MM-DD" },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
  },
  {
    name: "create_todo",
    description: "Create a todo for the operator. Reminders fire at due_at.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string", description: "Short imperative todo text." }, due_at: DUE_AT },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "update_todo",
    description: "Complete, drop or snooze an existing todo. Snooze needs due_at. Get ids from read_state.",
    input_schema: {
      type: "object",
      properties: {
        todo_id: { type: "string" },
        action: { type: "string", enum: ["complete", "drop", "snooze"] },
        due_at: DUE_AT,
      },
      required: ["todo_id", "action"],
      additionalProperties: false,
    },
  },
];
