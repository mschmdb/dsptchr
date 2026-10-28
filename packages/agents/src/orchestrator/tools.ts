import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

const SCOPES = ["todos", "shopping", "calendar", "birthdays", "mail", "health", "github", "analytics", "status"] as const;
export const readStateInput = z.strictObject({ scope: z.enum(SCOPES) });
export const createTodoInput = z.strictObject({
  text: z.string().trim().min(1).max(500),
  due_at: z.string().max(40).nullable().optional(),
});
export const updateTodoInput = z.strictObject({
  todo_id: z.string().min(1).max(64),
  action: z.enum(["complete", "drop", "snooze"]),
  due_at: z.string().max(40).nullable().optional(),
});

export const addToShoppingListInput = z.strictObject({
  items: z
    .array(
      z.strictObject({
        name: z.string().trim().min(1).max(60),
        quantity: z.string().trim().min(1).max(20).nullable().optional(),
        kind: z.enum(["once", "every", "empty"]).nullable().optional(),
      }),
    )
    .min(1)
    .max(20),
});
export const updateShoppingItemInput = z.strictObject({
  item_id: z.string().min(1).max(64),
  action: z.enum(["check", "uncheck", "need", "stock", "remove"]),
});

export const searchCalendarInput = z.strictObject({
  query: z.string().trim().max(100).nullable().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const searchKnowledgeInput = z.strictObject({ query: z.string().trim().min(1).max(300) });
export const readKnowledgeInput = z.strictObject({
  path: z.string().min(1).max(200),
  section: z.string().max(200).nullable().optional(),
});
export const writeKnowledgeInput = z.strictObject({
  path: z.string().min(1).max(200),
  content: z.string().min(1).max(20_000),
  mode: z.enum(["create", "replace", "append"]),
  expected: z.string().max(64).nullable().optional(),
});

export type SearchKnowledgeInput = z.infer<typeof searchKnowledgeInput>;
export type ReadKnowledgeInput = z.infer<typeof readKnowledgeInput>;
export type WriteKnowledgeInput = z.infer<typeof writeKnowledgeInput>;
export type SearchCalendarInput = z.infer<typeof searchCalendarInput>;
export type ReadStateInput = z.infer<typeof readStateInput>;
export type CreateTodoInput = z.infer<typeof createTodoInput>;
export type UpdateTodoInput = z.infer<typeof updateTodoInput>;
export type AddToShoppingListInput = z.infer<typeof addToShoppingListInput>;
export type UpdateShoppingItemInput = z.infer<typeof updateShoppingItemInput>;

// The orchestrator's whole capability surface (AR-1): read state, propose todo, shopping
// list and knowledge changes.
// Every write becomes a proposal that passes gate and executor.
export interface OrchestratorTools {
  read_state(input: ReadStateInput): Promise<string>;
  search_calendar(input: SearchCalendarInput): Promise<string>;
  search_knowledge(input: SearchKnowledgeInput): Promise<string>;
  read_knowledge(input: ReadKnowledgeInput): Promise<string>;
  write_knowledge(input: WriteKnowledgeInput): Promise<string>;
  create_todo(input: CreateTodoInput): Promise<string>;
  update_todo(input: UpdateTodoInput): Promise<string>;
  add_to_shopping_list(input: AddToShoppingListInput): Promise<string>;
  update_shopping_item(input: UpdateShoppingItemInput): Promise<string>;
}

// Thrown by handlers for input the model can fix; it goes back as an error tool result.
export class ToolInputError extends Error {
  override name = "ToolInputError";
}

export const INPUT_SCHEMAS = {
  read_state: readStateInput,
  search_calendar: searchCalendarInput,
  search_knowledge: searchKnowledgeInput,
  read_knowledge: readKnowledgeInput,
  write_knowledge: writeKnowledgeInput,
  create_todo: createTodoInput,
  update_todo: updateTodoInput,
  add_to_shopping_list: addToShoppingListInput,
  update_shopping_item: updateShoppingItemInput,
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
      "Read current state. todos: open todos with id, text, due time. shopping: every shopping list item with id, name, quantity, kind and state (needed, checked = in the cart, stocked = staple at home). calendar: today's and tomorrow's events (titles of other people's invitations are hidden) and birthdays. birthdays: every contact's birthday with its next date. mail: counts of the last 24 h by category, how many need action or are urgent. health: open server health findings (host, severity, check, since). github: per repository, open PRs and issues by author type and the number of red CI workflows. analytics: web analytics of the operator's sites (yesterday and the last 30 days). status: pause state, counts, last health check.",
    input_schema: {
      type: "object",
      properties: { scope: { type: "string", enum: [...SCOPES] } },
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
    name: "search_knowledge",
    description:
      "Search the operator's knowledge base (Markdown notes). Returns matching notes with path, key fact, matching lines and revision. Use before writing, to extend an existing note instead of creating a duplicate.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Question or keywords." } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "read_knowledge",
    description: "Read one note of the knowledge base, optionally one section. Returns its text and revision.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path from search_knowledge, e.g. notes/topic.md" },
        section: { type: ["string", "null"], description: "Heading of a section, or null for the whole note." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "write_knowledge",
    description:
      "Change the knowledge base. create: a new note (path must not exist). append: add text to the end of an existing note. replace: replace a whole note. append and replace need expected = the note's current revision from search_knowledge or read_knowledge. Only when the operator asks to note, remember or update something.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string", description: "Markdown. For create and replace, the full note incl. frontmatter." },
        mode: { type: "string", enum: ["create", "replace", "append"] },
        expected: { type: ["string", "null"], description: "Current revision; null for create." },
      },
      required: ["path", "content", "mode"],
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
  {
    name: "add_to_shopping_list",
    description:
      "Put items on the shopping list. An item already on it is merged, not duplicated. kind: once = buy one time; every = staple bought on every trip; empty = staple bought only when it has run out. Null keeps an existing item's kind (new items become once). Mark staples only when the operator says so.",
    input_schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Product name only, e.g. Milch. At most 60 characters." },
              quantity: { type: ["string", "null"], description: "Short amount like 2, 500 g or 4x; null if none." },
              kind: { type: ["string", "null"], enum: ["once", "every", "empty", null] },
            },
            required: ["name"],
            additionalProperties: false,
          },
        },
      },
      required: ["items"],
      additionalProperties: false,
    },
  },
  {
    name: "update_shopping_item",
    description:
      "Change one shopping list item; take item_id from read_state shopping. check: in the cart. uncheck: back to needed. need: a staple has run out. stock: a staple is at home, off the list. remove: delete the item for good, staples included.",
    input_schema: {
      type: "object",
      properties: {
        item_id: { type: "string" },
        action: { type: "string", enum: ["check", "uncheck", "need", "stock", "remove"] },
      },
      required: ["item_id", "action"],
      additionalProperties: false,
    },
  },
];
