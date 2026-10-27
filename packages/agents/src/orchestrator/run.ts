import type Anthropic from "@anthropic-ai/sdk";
import type { Usage } from "../pricing.ts";
import { ORCHESTRATOR_PROMPT } from "./prompt.ts";
import { INPUT_SCHEMAS, TOOL_DEFINITIONS, ToolInputError, type OrchestratorTools } from "./tools.ts";

export type CreateMessage = (params: Anthropic.Beta.MessageCreateParamsNonStreaming) => Promise<Anthropic.Beta.BetaMessage>;

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

export interface OrchestratorResult {
  outcome: "ok" | "refusal" | "iteration_limit" | "max_tokens" | "budget_exhausted";
  reply: string | undefined;
  iterations: number;
  usage: Usage;
  toolCalls: { name: string; ok: boolean }[];
}

type ToolName = keyof typeof INPUT_SCHEMAS;

// One orchestrator turn: a manual tool loop over the Messages API. The model only has the
// tools in TOOL_DEFINITIONS; there are no built-in shell, file or network tools (AR-1).
export async function runOrchestrator(request: OrchestratorRequest): Promise<OrchestratorResult> {
  const maxIterations = request.maxIterations ?? 6;
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const toolCalls: OrchestratorResult["toolCalls"] = [];
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...toMessages(request.history),
    { role: "user", content: `${request.context}\n\nOperator message:\n${request.input}` },
  ];
  const system: Anthropic.Beta.BetaTextBlockParam[] = [
    { type: "text", text: ORCHESTRATOR_PROMPT },
    {
      type: "text",
      text: request.role.trim() === "" ? "Operator preferences: none." : `Operator preferences:\n${request.role.trim()}`,
      cache_control: { type: "ephemeral" },
    },
  ];

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    if (request.mayCall !== undefined && !request.mayCall()) {
      return { outcome: "budget_exhausted", reply: undefined, iterations: iteration - 1, usage, toolCalls };
    }
    const response = await request.createMessage({
      model: request.model,
      max_tokens: 4000,
      system,
      tools: TOOL_DEFINITIONS,
      messages,
      output_config: { effort: request.effort },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    const responseUsage = toUsage(response.usage);
    addUsage(usage, responseUsage);
    request.onResponse?.(responseUsage);

    if (response.stop_reason === "refusal") {
      return { outcome: "refusal", reply: undefined, iterations: iteration, usage, toolCalls };
    }
    const uses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || uses.length === 0) {
      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text.trim())
        .filter((t) => t !== "")
        .join("\n");
      const outcome = response.stop_reason === "max_tokens" ? "max_tokens" : "ok";
      return { outcome, reply: text === "" ? undefined : text, iterations: iteration, usage, toolCalls };
    }

    messages.push({ role: "assistant", content: response.content as Anthropic.Beta.BetaContentBlockParam[] });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const use of uses) {
      const result = await callTool(request.tools, use);
      toolCalls.push({ name: use.name, ok: result.is_error !== true });
      results.push(result);
    }
    messages.push({ role: "user", content: results });
  }
  return { outcome: "iteration_limit", reply: undefined, iterations: maxIterations, usage, toolCalls };
}

async function callTool(tools: OrchestratorTools, use: Anthropic.Beta.BetaToolUseBlock): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
  const error = (content: string): Anthropic.Beta.BetaToolResultBlockParam => ({
    type: "tool_result",
    tool_use_id: use.id,
    content,
    is_error: true,
  });
  if (!Object.hasOwn(INPUT_SCHEMAS, use.name)) return error("unknown tool");
  const name = use.name as ToolName;
  const parsed = INPUT_SCHEMAS[name].safeParse(use.input);
  if (!parsed.success) {
    return error(`invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  }
  try {
    const content = await (tools[name] as (input: unknown) => Promise<string>)(parsed.data);
    return { type: "tool_result", tool_use_id: use.id, content };
  } catch (thrown) {
    if (thrown instanceof ToolInputError) return error(thrown.message);
    throw thrown;
  }
}

// The API needs the first message from the user; an orphaned leading reply is dropped.
function toMessages(history: readonly HistoryTurn[]): Anthropic.Beta.BetaMessageParam[] {
  const start = history.findIndex((t) => t.role === "operator");
  if (start === -1) return [];
  return history.slice(start).map((t) => ({ role: t.role === "operator" ? "user" : "assistant", content: t.text }));
}

function toUsage(usage: Anthropic.Beta.BetaUsage): Usage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

function addUsage(total: Usage, usage: Usage): void {
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.cacheReadTokens += usage.cacheReadTokens;
  total.cacheWriteTokens += usage.cacheWriteTokens;
}
