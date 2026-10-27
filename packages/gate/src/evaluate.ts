import type { ActionPolicy, Policy } from "./policy.ts";

export type GateDecision = "approve" | "ask_operator" | "deny";

export interface Proposal {
  type: string;
  payload: unknown;
}

export interface GateContext {
  policy: Policy;
  paused: boolean;
  now: number;
  countApprovedSince(type: string, since: number): number;
}

export interface GateResult {
  decision: GateDecision;
  reason: string;
}

// Deterministic. Order matters: kill switch, then policy level, then rate limit.
export function evaluate(proposal: Proposal, context: GateContext): GateResult {
  if (context.paused) {
    return { decision: "deny", reason: "kill switch active" };
  }
  const policy = lookup(context.policy, proposal.type);
  if (policy === undefined) {
    return { decision: "deny", reason: "policy: unknown action type" };
  }
  if (policy.level === "never") {
    return { decision: "deny", reason: "policy: never" };
  }
  if (policy.rateLimit !== undefined) {
    const since = context.now - policy.rateLimit.perMinutes * 60_000;
    if (context.countApprovedSince(proposal.type, since) >= policy.rateLimit.max) {
      return { decision: "deny", reason: `rate limit: ${policy.rateLimit.max} per ${policy.rateLimit.perMinutes} min` };
    }
  }
  return policy.level === "auto"
    ? { decision: "approve", reason: "policy: auto" }
    : { decision: "ask_operator", reason: "policy: ask" };
}

function lookup(policy: Policy, type: string): ActionPolicy | undefined {
  return Object.hasOwn(policy.actions, type) ? policy.actions[type] : undefined;
}
