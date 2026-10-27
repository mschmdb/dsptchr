import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { runTriage, type CreateMessage, type TriageTools } from "../src/index.ts";

type Block = Anthropic.Beta.BetaContentBlock;
const usage = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const toolMsg = (calls: { name: string; input: unknown }[]) =>
  ({
    content: calls.map((c, i) => ({ type: "tool_use", id: `u${i}`, name: c.name, input: c.input }) as unknown as Block),
    stop_reason: "tool_use",
    usage,
  }) as unknown as Anthropic.Beta.BetaMessage;
const textMsg = (text: string) =>
  ({ content: [{ type: "text", text }], stop_reason: "end_turn", usage }) as unknown as Anthropic.Beta.BetaMessage;

function scripted(responses: Anthropic.Beta.BetaMessage[]) {
  const requests: Anthropic.Beta.MessageCreateParamsNonStreaming[] = [];
  const fn = (async (params: Anthropic.Beta.MessageCreateParamsNonStreaming) => {
    requests.push(structuredClone(params));
    return responses.shift() ?? textMsg("done");
  }) as CreateMessage;
  return { fn, requests };
}

const tools: TriageTools = {
  read_state: async () => JSON.stringify({ todos: [] }),
  search_calendar: async () => JSON.stringify({ events: [] }),
  create_todo: async (input) => `Created todo "${input.text}".`,
};

const base = {
  model: "claude-sonnet-5-5",
  effort: "medium" as const,
  context: "Current time: Tue 27.10.2026 11:00",
  items: [
    { ref: "q1", source: "mail", urgent: true, features: { category: "important" } },
    { ref: "q2", source: "github", urgent: false, features: { kind: "pr", author: "bot" } },
  ],
  feedback: [],
  rules: [],
  tools,
};

describe("runTriage", () => {
  it("returns the decision of the decide tool", async () => {
    const { fn, requests } = scripted([
      toolMsg([{ name: "decide", input: { notify: ["q1"], briefing: ["q2"], drop: [], message: "One thing needs you." } }]),
      textMsg("ok"),
    ]);
    const result = await runTriage({ ...base, createMessage: fn });
    expect(result.decision).toEqual({ notify: ["q1"], briefing: ["q2"], drop: [], message: "One thing needs you." });
    const prompt = requests[0]?.messages[0]?.content as string;
    expect(prompt).toContain('"ref":"q1"');
    expect(requests[0]?.tools?.map((t) => (t as { name: string }).name)).toEqual(["read_state", "search_calendar", "create_todo", "decide"]);
  });

  it("ignores unknown refs and puts unmentioned items into the briefing", async () => {
    const { fn } = scripted([toolMsg([{ name: "decide", input: { notify: ["q1", "zz"], briefing: [], drop: [], message: null } }])]);
    const result = await runTriage({ ...base, createMessage: fn });
    expect(result.decision).toEqual({ notify: ["q1"], briefing: ["q2"], drop: [], message: null });
  });

  it("has no decision when the model never decides", async () => {
    const { fn } = scripted([textMsg("I think everything is fine.")]);
    expect((await runTriage({ ...base, createMessage: fn })).decision).toBeUndefined();
  });

  it("lets the model use read tools and create todos before deciding", async () => {
    const created: unknown[] = [];
    const { fn } = scripted([
      toolMsg([{ name: "create_todo", input: { text: "Pay the invoice", due_at: null } }]),
      toolMsg([{ name: "decide", input: { notify: [], briefing: ["q1", "q2"], drop: [], message: null } }]),
    ]);
    await runTriage({
      ...base,
      createMessage: fn,
      tools: { ...tools, create_todo: async (input) => (created.push(input), "Created") },
    });
    expect(created).toEqual([{ text: "Pay the invoice", due_at: null }]);
  });
});
