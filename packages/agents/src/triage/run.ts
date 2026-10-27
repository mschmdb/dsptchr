import { z } from "zod";
import { runToolLoop, type CreateMessage, type LoopResult, type ToolSpec } from "../loop.ts";
import {
  createTodoInput,
  readStateInput,
  searchCalendarInput,
  TOOL_DEFINITIONS,
  type CreateTodoInput,
  type ReadStateInput,
  type SearchCalendarInput,
} from "../orchestrator/tools.ts";
import type { Usage } from "../pricing.ts";

export const TRIAGE_PROMPT = `You triage new events for the operator of a personal dispatcher. Each item is a reference with structured features only (source, category, urgency, author type, repository, host, check). You never see subjects, titles or message text, and you do not need them.

For every item decide:
- notify: the operator should see it now. Only what needs attention within the next hours.
- briefing: worth a line in the next morning briefing.
- drop: not worth mentioning.

Weigh urgency, the operator's feedback history and active mute rules, the time of day and what is on the calendar (read_state, search_calendar). Prefer fewer, calmer notifications. If an item clearly needs an action, you may create a todo with a short, neutral text (create_todo).

Finish by calling decide exactly once. Its message is an optional single sentence before the item list, in the operator's language (German by default), without item details; the system appends the items itself.`;

const decideInput = z.strictObject({
  notify: z.array(z.string().max(32)).max(200),
  briefing: z.array(z.string().max(32)).max(200),
  drop: z.array(z.string().max(32)).max(200),
  message: z.string().max(300).nullable(),
});

export interface TriageDecision {
  notify: string[];
  briefing: string[];
  drop: string[];
  message: string | null;
}

export interface TriageItemRef {
  ref: string;
  source: string;
  urgent: boolean;
  features: Record<string, string>;
}

export interface TriageTools {
  read_state(input: ReadStateInput): Promise<string>;
  search_calendar(input: SearchCalendarInput): Promise<string>;
  create_todo(input: CreateTodoInput): Promise<string>;
}

export interface TriageRequest {
  createMessage: CreateMessage;
  model: string;
  effort: "low" | "medium" | "high";
  context: string;
  items: readonly TriageItemRef[];
  feedback: readonly { features: Record<string, string>; relevant: number; irrelevant: number }[];
  rules: readonly Record<string, string>[];
  tools: TriageTools;
  onResponse?: (usage: Usage) => void;
  mayCall?: () => boolean;
}

export interface TriageResult extends Pick<LoopResult, "outcome" | "usage"> {
  decision: TriageDecision | undefined;
}

const DECIDE_DEFINITION = {
  name: "decide",
  description: "Final triage decision. Every item ref belongs in exactly one list.",
  input_schema: {
    type: "object" as const,
    properties: {
      notify: { type: "array", items: { type: "string" } },
      briefing: { type: "array", items: { type: "string" } },
      drop: { type: "array", items: { type: "string" } },
      message: { type: ["string", "null"] },
    },
    required: ["notify", "briefing", "drop", "message"],
    additionalProperties: false,
  },
};

const definition = (name: string) => {
  const found = TOOL_DEFINITIONS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`missing tool definition ${name}`);
  return found;
};

// Triage run over watcher items (Lagebild). Same safety model as the orchestrator: no untrusted
// text in context, writes only as proposals through the gate.
export async function runTriage(request: TriageRequest): Promise<TriageResult> {
  let decision: TriageDecision | undefined;
  const tools: ToolSpec[] = [
    { definition: definition("read_state"), schema: readStateInput, handler: (i) => request.tools.read_state(i as ReadStateInput) },
    {
      definition: definition("search_calendar"),
      schema: searchCalendarInput,
      handler: (i) => request.tools.search_calendar(i as SearchCalendarInput),
    },
    { definition: definition("create_todo"), schema: createTodoInput, handler: (i) => request.tools.create_todo(i as CreateTodoInput) },
    {
      definition: DECIDE_DEFINITION,
      schema: decideInput,
      handler: async (i) => {
        decision = i as TriageDecision;
        return "Decision recorded.";
      },
    },
  ];

  const result = await runToolLoop({
    createMessage: request.createMessage,
    model: request.model,
    effort: request.effort,
    system: [{ type: "text", text: TRIAGE_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: [
          request.context,
          `Items:\n${request.items.map((i) => JSON.stringify(i)).join("\n")}`,
          `Feedback so far (operator's own ratings):\n${JSON.stringify(request.feedback)}`,
          `Active mute rules:\n${JSON.stringify(request.rules)}`,
        ].join("\n\n"),
      },
    ],
    tools,
    maxIterations: 6,
    ...(request.onResponse === undefined ? {} : { onResponse: request.onResponse }),
    ...(request.mayCall === undefined ? {} : { mayCall: request.mayCall }),
  });

  return { outcome: result.outcome, usage: result.usage, decision: decision === undefined ? undefined : normalize(decision, request.items) };
}

// Unknown refs are ignored; an item in several lists counts once (notify > briefing > drop);
// items the model forgot go to the briefing.
function normalize(decision: TriageDecision, items: readonly TriageItemRef[]): TriageDecision {
  const known = new Set(items.map((i) => i.ref));
  const notify = [...new Set(decision.notify.filter((r) => known.has(r)))];
  const briefing = [...new Set(decision.briefing.filter((r) => known.has(r) && !notify.includes(r)))];
  const drop = [...new Set(decision.drop.filter((r) => known.has(r) && !notify.includes(r) && !briefing.includes(r)))];
  const decided = new Set([...notify, ...briefing, ...drop]);
  briefing.push(...items.map((i) => i.ref).filter((r) => !decided.has(r)));
  return { notify, briefing, drop, message: decision.message };
}
