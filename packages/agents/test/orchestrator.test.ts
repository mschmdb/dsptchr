import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  costUsd,
  runOrchestrator,
  ToolInputError,
  type CreateMessage,
  type OrchestratorTools,
} from "../src/index.ts";

type Block = Anthropic.Beta.BetaContentBlock;

function message(content: Block[], stop: string, usage = { input_tokens: 100, output_tokens: 20 }): Anthropic.Beta.BetaMessage {
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content,
    stop_reason: stop,
    stop_details: null,
    usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage },
  } as unknown as Anthropic.Beta.BetaMessage;
}

const textBlock = (text: string): Block => ({ type: "text", text, citations: null }) as unknown as Block;
const toolUse = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input }) as unknown as Block;

function scripted(responses: Anthropic.Beta.BetaMessage[]): CreateMessage & { requests: Anthropic.Beta.MessageCreateParamsNonStreaming[] } {
  const requests: Anthropic.Beta.MessageCreateParamsNonStreaming[] = [];
  const fn = (async (params: Anthropic.Beta.MessageCreateParamsNonStreaming) => {
    requests.push(structuredClone(params));
    const next = responses.shift();
    if (next === undefined) throw new Error("no scripted response");
    return next;
  }) as CreateMessage & { requests: typeof requests };
  fn.requests = requests;
  return fn;
}

function tools(overrides: Partial<OrchestratorTools> = {}): OrchestratorTools & { calls: [string, unknown][] } {
  const calls: [string, unknown][] = [];
  return {
    calls,
    read_state: async (input) => {
      calls.push(["read_state", input]);
      return JSON.stringify({ todos: [] });
    },
    create_todo: async (input) => {
      calls.push(["create_todo", input]);
      return "created todo t-1";
    },
    update_todo: async (input) => {
      calls.push(["update_todo", input]);
      return "updated";
    },
    ...overrides,
  };
}

const base = {
  model: "claude-sonnet-5-5",
  effort: "low" as const,
  role: "Be brief.",
  history: [],
  context: "Current time: Tue 27.10.2026 16:50 (Europe/Berlin)",
  input: "Remind me to call the bank tomorrow",
};

describe("runOrchestrator", () => {
  it("returns the final text when no tool is needed", async () => {
    const create = scripted([message([textBlock("Hi!")], "end_turn")]);
    const result = await runOrchestrator({ ...base, createMessage: create, tools: tools() });
    expect(result).toMatchObject({ outcome: "ok", reply: "Hi!", iterations: 1 });
  });

  it("runs tool calls, feeds results back and returns the final reply", async () => {
    const create = scripted([
      message([toolUse("u1", "create_todo", { text: "Call the bank", due_at: "2026-10-28T09:00:00+01:00" })], "tool_use"),
      message([textBlock("Saved for tomorrow 09:00.")], "end_turn"),
    ]);
    const t = tools();

    const result = await runOrchestrator({ ...base, createMessage: create, tools: t });

    expect(t.calls).toEqual([["create_todo", { text: "Call the bank", due_at: "2026-10-28T09:00:00+01:00" }]]);
    expect(result.reply).toBe("Saved for tomorrow 09:00.");
    const second = create.requests[1]?.messages.at(-1);
    expect(second).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "u1", content: "created todo t-1" }],
    });
    expect(result.toolCalls).toEqual([{ name: "create_todo", ok: true }]);
  });

  it("answers several tool calls of one turn in a single user message", async () => {
    const create = scripted([
      message([toolUse("u1", "read_state", { scope: "todos" }), toolUse("u2", "read_state", { scope: "health" })], "tool_use"),
      message([textBlock("ok")], "end_turn"),
    ]);
    await runOrchestrator({ ...base, createMessage: create, tools: tools() });
    const results = create.requests[1]?.messages.at(-1)?.content as unknown[];
    expect(results).toHaveLength(2);
  });

  it("returns invalid tool input as an error result instead of calling the handler", async () => {
    const create = scripted([
      message([toolUse("u1", "update_todo", { todo_id: "t", action: "explode" })], "tool_use"),
      message([textBlock("Sorry.")], "end_turn"),
    ]);
    const t = tools();
    await runOrchestrator({ ...base, createMessage: create, tools: t });
    expect(t.calls).toEqual([]);
    expect(create.requests[1]?.messages.at(-1)?.content).toEqual([
      expect.objectContaining({ type: "tool_result", tool_use_id: "u1", is_error: true }),
    ]);
  });

  it("passes handler input errors back to the model", async () => {
    const create = scripted([
      message([toolUse("u1", "create_todo", { text: "x", due_at: "yesterday" })], "tool_use"),
      message([textBlock("When exactly?")], "end_turn"),
    ]);
    const t = tools({
      create_todo: async () => {
        throw new ToolInputError("due_at must be ISO 8601 with offset");
      },
    });
    const result = await runOrchestrator({ ...base, createMessage: create, tools: t });
    expect(create.requests[1]?.messages.at(-1)?.content).toEqual([
      { type: "tool_result", tool_use_id: "u1", content: "due_at must be ISO 8601 with offset", is_error: true },
    ]);
    expect(result.toolCalls).toEqual([{ name: "create_todo", ok: false }]);
  });

  it("rejects unknown tools", async () => {
    const create = scripted([message([toolUse("u1", "shell", { cmd: "ls" })], "tool_use"), message([textBlock("no")], "end_turn")]);
    await runOrchestrator({ ...base, createMessage: create, tools: tools() });
    expect(create.requests[1]?.messages.at(-1)?.content).toEqual([
      expect.objectContaining({ is_error: true, content: "unknown tool" }),
    ]);
  });

  it("lets unexpected handler errors fail the run", async () => {
    const create = scripted([message([toolUse("u1", "read_state", { scope: "todos" })], "tool_use")]);
    const t = tools({
      read_state: async () => {
        throw new Error("database is locked");
      },
    });
    await expect(runOrchestrator({ ...base, createMessage: create, tools: t })).rejects.toThrow("database is locked");
  });

  it("stops after the iteration limit", async () => {
    const loop = Array.from({ length: 10 }, (_, i) => message([toolUse(`u${i}`, "read_state", { scope: "todos" })], "tool_use"));
    const result = await runOrchestrator({ ...base, createMessage: scripted(loop), tools: tools(), maxIterations: 3 });
    expect(result).toMatchObject({ outcome: "iteration_limit", iterations: 3 });
  });

  it("reports refusals without a reply", async () => {
    const result = await runOrchestrator({ ...base, createMessage: scripted([message([], "refusal")]), tools: tools() });
    expect(result).toMatchObject({ outcome: "refusal", reply: undefined });
  });

  it("sums usage across iterations", async () => {
    const create = scripted([
      message([toolUse("u1", "read_state", { scope: "todos" })], "tool_use", { input_tokens: 1000, output_tokens: 50 }),
      message([textBlock("ok")], "end_turn", { input_tokens: 1200, output_tokens: 30 }),
    ]);
    const result = await runOrchestrator({ ...base, createMessage: create, tools: tools() });
    expect(result.usage).toEqual({ inputTokens: 2200, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it("sends a stable, cached system prompt, the history and the context with the input", async () => {
    const create = scripted([message([textBlock("ok")], "end_turn")]);
    await runOrchestrator({
      ...base,
      history: [
        { role: "assistant", text: "orphan reply" },
        { role: "operator", text: "earlier question" },
        { role: "assistant", text: "earlier answer" },
      ],
      createMessage: create,
      tools: tools(),
    });
    const request = create.requests[0];
    const system = request?.system as { text: string; cache_control?: unknown }[];
    expect(system.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
    expect(system.map((s) => s.text).join("\n")).toContain("Be brief.");
    expect(request?.messages).toEqual([
      { role: "user", content: "earlier question" },
      { role: "assistant", content: "earlier answer" },
      { role: "user", content: `${base.context}\n\nOperator message:\n${base.input}` },
    ]);
    expect(request?.tools?.map((t) => (t as { name: string }).name)).toEqual(["read_state", "create_todo", "update_todo"]);
    expect(request?.output_config).toEqual({ effort: "low" });
  });

  it("reports each response's usage as it arrives", async () => {
    const seen: number[] = [];
    const create = scripted([
      message([toolUse("u1", "read_state", { scope: "todos" })], "tool_use", { input_tokens: 10, output_tokens: 1 }),
      message([textBlock("ok")], "end_turn", { input_tokens: 20, output_tokens: 2 }),
    ]);
    await runOrchestrator({ ...base, createMessage: create, tools: tools(), onResponse: (u) => seen.push(u.inputTokens) });
    expect(seen).toEqual([10, 20]);
  });

  it("checks the budget before every call and stops when it is used up", async () => {
    let calls = 0;
    const create = scripted([
      message([toolUse("u1", "read_state", { scope: "todos" })], "tool_use"),
      message([textBlock("never")], "end_turn"),
    ]);
    const result = await runOrchestrator({
      ...base,
      createMessage: create,
      tools: tools(),
      mayCall: () => ++calls <= 1,
    });
    expect(result).toMatchObject({ outcome: "budget_exhausted", reply: undefined, iterations: 1 });
    expect(create.requests).toHaveLength(1);
  });

  it("joins multiple text blocks of the final message", async () => {
    const create = scripted([message([textBlock("Part 1."), textBlock("Part 2.")], "end_turn")]);
    expect((await runOrchestrator({ ...base, createMessage: create, tools: tools() })).reply).toBe("Part 1.\nPart 2.");
  });
});

describe("costUsd", () => {
  it("prices Sonnet 5.5 including cache reads and writes", () => {
    expect(
      costUsd("claude-sonnet-5-5", { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 }),
    ).toBeCloseTo(2 + 1 + 0.2);
  });

  it("treats unknown models with the most expensive known price", () => {
    expect(costUsd("mystery", { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeGreaterThanOrEqual(4);
  });
});
