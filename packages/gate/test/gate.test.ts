import { describe, expect, it } from "vitest";
import { draftHash, evaluate, parsePolicy, PolicyError, type GateContext } from "../src/index.ts";

const POLICY = parsePolicy(`
actions:
  telegram.send:
    level: auto
    rate_limit: { max: 2, per_minutes: 60 }
  todo.create:
    level: auto
  mail.reply:
    level: ask
  repo.delete:
    level: never
`);

function context(overrides: Partial<GateContext> = {}): GateContext {
  return { policy: POLICY, paused: false, now: 1_000_000, countApprovedSince: () => 0, ...overrides };
}

describe("parsePolicy", () => {
  it("parses levels and rate limits", () => {
    expect(POLICY.actions["telegram.send"]).toEqual({ level: "auto", rateLimit: { max: 2, perMinutes: 60 } });
    expect(POLICY.actions["todo.create"]).toEqual({ level: "auto" });
  });

  it.each([
    ["unknown level", "actions:\n  x.a:\n    level: sometimes\n"],
    ["unknown key", "actions:\n  x.a:\n    level: auto\n    lvl: auto\n"],
    ["zero rate", "actions:\n  x.a:\n    level: auto\n    rate_limit: { max: 0, per_minutes: 1 }\n"],
    ["invalid yaml", "actions: [\n"],
    ["missing actions", "{}\n"],
  ])("rejects %s", (_name, text) => {
    expect(() => parsePolicy(text)).toThrow(PolicyError);
  });
});

describe("evaluate", () => {
  it("approves auto actions", () => {
    expect(evaluate({ type: "todo.create", payload: {} }, context())).toEqual({ decision: "approve", reason: "policy: auto" });
  });

  it("routes ask actions to the operator", () => {
    expect(evaluate({ type: "mail.reply", payload: {} }, context()).decision).toBe("ask_operator");
  });

  it("denies never actions", () => {
    expect(evaluate({ type: "repo.delete", payload: {} }, context())).toEqual({ decision: "deny", reason: "policy: never" });
  });

  it("denies action types missing from the policy", () => {
    expect(evaluate({ type: "shell.run", payload: {} }, context())).toEqual({
      decision: "deny",
      reason: "policy: unknown action type",
    });
  });

  it("denies everything while the kill switch is active", () => {
    expect(evaluate({ type: "todo.create", payload: {} }, context({ paused: true }))).toEqual({
      decision: "deny",
      reason: "kill switch active",
    });
  });

  it("denies when the rate limit is reached and counts the right window", () => {
    const seen: [string, number][] = [];
    const ctx = context({
      countApprovedSince: (type, since) => {
        seen.push([type, since]);
        return 2;
      },
    });
    expect(evaluate({ type: "telegram.send", payload: {} }, ctx)).toEqual({ decision: "deny", reason: "rate limit: 2 per 60 min" });
    expect(seen).toEqual([["telegram.send", 1_000_000 - 60 * 60_000]]);
  });

  it("approves below the rate limit", () => {
    expect(evaluate({ type: "telegram.send", payload: {} }, context({ countApprovedSince: () => 1 })).decision).toBe("approve");
  });

  it("applies rate limits to ask actions too", () => {
    const policy = parsePolicy("actions:\n  x.a:\n    level: ask\n    rate_limit: { max: 1, per_minutes: 5 }\n");
    expect(evaluate({ type: "x.a", payload: {} }, context({ policy, countApprovedSince: () => 1 })).decision).toBe("deny");
  });

  it("does not consult prototype keys as action types", () => {
    expect(evaluate({ type: "constructor", payload: {} }, context()).decision).toBe("deny");
    expect(evaluate({ type: "__proto__", payload: {} }, context()).decision).toBe("deny");
  });
});

describe("draftHash", () => {
  it("is stable across key order", () => {
    expect(draftHash({ type: "t", payload: { a: 1, b: { c: 2, d: [1, 2] } } })).toBe(
      draftHash({ payload: { b: { d: [1, 2], c: 2 }, a: 1 }, type: "t" } as never),
    );
  });

  it("changes when the payload or type changes", () => {
    const base = draftHash({ type: "t", payload: { text: "hi" } });
    expect(draftHash({ type: "t", payload: { text: "hi!" } })).not.toBe(base);
    expect(draftHash({ type: "u", payload: { text: "hi" } })).not.toBe(base);
  });

  it("distinguishes array order", () => {
    expect(draftHash({ type: "t", payload: [1, 2] })).not.toBe(draftHash({ type: "t", payload: [2, 1] }));
  });

  it("ignores undefined fields like JSON does", () => {
    expect(draftHash({ type: "t", payload: { a: 1, b: undefined } })).toBe(draftHash({ type: "t", payload: { a: 1 } }));
  });
});

describe("parsePolicy action names", () => {
  it.each(["shell", "Telegram.send", "telegram.", "../x.y", "_x.y"])("rejects %j", (name) => {
    expect(() => parsePolicy(`actions:\n  "${name}":\n    level: auto\n`)).toThrow(PolicyError);
  });
});

describe("parsePolicy prototype keys", () => {
  it("never turns __proto__ into an action or a prototype", () => {
    const policy = parsePolicy(`actions:\n  "__proto__":\n    level: auto\n  todo.create:\n    level: auto\n`);
    expect(Object.keys(policy.actions)).toEqual(["todo.create"]);
    expect(evaluate({ type: "__proto__", payload: {} }, context({ policy })).decision).toBe("deny");
    expect(evaluate({ type: "level", payload: {} }, context({ policy })).decision).toBe("deny");
  });
});
