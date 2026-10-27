import type Anthropic from "@anthropic-ai/sdk";
import type { Usage } from "../pricing.ts";
import { runToolLoop, type LoopResult, type ToolSpec } from "../loop.ts";
import { ORCHESTRATOR_PROMPT } from "./prompt.ts";
import { INPUT_SCHEMAS, TOOL_DEFINITIONS, type OrchestratorTools } from "./tools.ts";

export type { CreateMessage } from "../loop.ts";
import type { CreateMessage } from "../loop.ts";

export interface HistoryTurn {
  role: "operator" | "assistant";
  text: string;
}

export interface OrchestratorRequest {
  createMessage: CreateMessage;
  model: string;
  effort: "low" | "medium" | "high";
  role: string;
  history: readonly HistoryTurn[];
  context: string;
  input: string;
  tools: OrchestratorTools;
  maxIterations?: number;
  // Called after every API response, so spend is recorded even if a later step fails.
  onResponse?: (usage: Usage) => void;
  // Checked before every API call; false stops the run (budget).
  mayCall?: () => boolean;
}

export type OrchestratorResult = LoopResult;

// One orchestrator turn: a manual tool loop over the Messages API. The model only has the
// tools in TOOL_DEFINITIONS; there are no built-in shell, file or network tools (AR-1).
export async function runOrchestrator(request: OrchestratorRequest): Promise<OrchestratorResult> {
  const tools: ToolSpec[] = TOOL_DEFINITIONS.map((definition) => {
    const name = definition.name as keyof typeof INPUT_SCHEMAS;
    return {
      definition,
      schema: INPUT_SCHEMAS[name],
      handler: (input: unknown) => (request.tools[name] as (i: unknown) => Promise<string>)(input),
    };
  });
  return runToolLoop({
    createMessage: request.createMessage,
    model: request.model,
    effort: request.effort,
    system: [
      { type: "text", text: ORCHESTRATOR_PROMPT },
      {
        type: "text",
        text: request.role.trim() === "" ? "Operator preferences: none." : `Operator preferences:\n${request.role.trim()}`,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      ...toMessages(request.history),
      { role: "user", content: `${request.context}\n\nOperator message:\n${request.input}` },
    ],
    tools,
    ...(request.maxIterations === undefined ? {} : { maxIterations: request.maxIterations }),
    ...(request.onResponse === undefined ? {} : { onResponse: request.onResponse }),
    ...(request.mayCall === undefined ? {} : { mayCall: request.mayCall }),
  });
}

// The API needs the first message from the user; an orphaned leading reply is dropped.
function toMessages(history: readonly HistoryTurn[]): Anthropic.Beta.BetaMessageParam[] {
  const start = history.findIndex((t) => t.role === "operator");
  if (start === -1) return [];
  return history.slice(start).map((t) => ({ role: t.role === "operator" ? "user" : "assistant", content: t.text }));
}
