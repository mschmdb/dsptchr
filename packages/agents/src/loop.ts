import type Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import { ToolInputError } from "./orchestrator/tools.ts";
import type { Usage } from "./pricing.ts";

export type CreateMessage = (params: Anthropic.Beta.MessageCreateParamsNonStreaming) => Promise<Anthropic.Beta.BetaMessage>;

export interface ToolSpec {
  definition: Anthropic.Beta.BetaTool;
  schema: z.ZodType;
  handler(input: unknown): Promise<string>;
}

export interface LoopRequest {
  createMessage: CreateMessage;
  model: string;
  effort: "low" | "medium" | "high";
  system: Anthropic.Beta.BetaTextBlockParam[];
  messages: Anthropic.Beta.BetaMessageParam[];
  tools: ToolSpec[];
  maxIterations?: number;
  // Called after every API response, so spend is recorded even if a later step fails.
  onResponse?: (usage: Usage) => void;
  // Checked before every API call; false stops the run (budget).
  mayCall?: () => boolean;
}

export interface LoopResult {
  outcome: "ok" | "refusal" | "iteration_limit" | "max_tokens" | "budget_exhausted";
  reply: string | undefined;
  iterations: number;
  usage: Usage;
  toolCalls: { name: string; ok: boolean }[];
}

// Manual tool loop over the Messages API. Only the given tools exist; there are no built-in
// shell, file or network tools (AR-1). Tool input is schema-checked before any handler runs.
export async function runToolLoop(request: LoopRequest): Promise<LoopResult> {
  const maxIterations = request.maxIterations ?? 6;
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const toolCalls: LoopResult["toolCalls"] = [];
  const messages = [...request.messages];
  const byName = new Map(request.tools.map((t) => [t.definition.name, t]));

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    if (request.mayCall !== undefined && !request.mayCall()) {
      return { outcome: "budget_exhausted", reply: undefined, iterations: iteration - 1, usage, toolCalls };
    }
    const response = await request.createMessage({
      model: request.model,
      max_tokens: 4000,
      system: request.system,
      tools: request.tools.map((t) => t.definition),
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
      const result = await callTool(byName, use);
      toolCalls.push({ name: use.name, ok: result.is_error !== true });
      results.push(result);
    }
    messages.push({ role: "user", content: results });
  }
  return { outcome: "iteration_limit", reply: undefined, iterations: maxIterations, usage, toolCalls };
}

async function callTool(tools: Map<string, ToolSpec>, use: Anthropic.Beta.BetaToolUseBlock): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
  const error = (content: string): Anthropic.Beta.BetaToolResultBlockParam => ({
    type: "tool_result",
    tool_use_id: use.id,
    content,
    is_error: true,
  });
  const tool = tools.get(use.name);
  if (tool === undefined) return error("unknown tool");
  const parsed = tool.schema.safeParse(use.input);
  if (!parsed.success) {
    return error(`invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  }
  try {
    return { type: "tool_result", tool_use_id: use.id, content: await tool.handler(parsed.data) };
  } catch (thrown) {
    if (thrown instanceof ToolInputError) return error(thrown.message);
    throw thrown;
  }
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
