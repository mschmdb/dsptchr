import { createHash } from "node:crypto";
import type { Proposal } from "./evaluate.ts";

// Approvals bind to this hash; any change to type or payload invalidates them.
export function draftHash(proposal: Proposal): string {
  return createHash("sha256").update(canonicalJson({ type: proposal.type, payload: proposal.payload })).digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeys(v)]));
  }
  return value;
}
