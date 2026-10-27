import type { AuditLog } from "./audit.ts";
import type { Db, Row } from "./db.ts";

export interface Turn {
  at: number;
  role: "operator" | "assistant";
  text: string;
}

// Short-term chat memory for the orchestrator. Operator text and the orchestrator's own
// replies only; no untrusted source content.
export function conversationRepo(db: Db, now: () => number) {
  return {
    append(turn: { role: Turn["role"]; text: string }): void {
      db.run("INSERT INTO conversation (at, role, text) VALUES (:at, :role, :text)", { at: now(), ...turn });
    },

    recent(limit: number, options: { since?: number } = {}): Turn[] {
      return db
        .all("SELECT * FROM conversation WHERE at >= :since ORDER BY seq DESC LIMIT :limit", {
          since: options.since ?? 0,
          limit,
        })
        .map(toTurn)
        .reverse();
    },

    purgeBefore(before: number): number {
      return db.run("DELETE FROM conversation WHERE at < :before", { before }).changes;
    },
  };
}

export interface RunRecord {
  role: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  outcome: string;
}

export function runRepo(db: Db, audit: AuditLog, now: () => number) {
  return {
    record(run: RunRecord): void {
      db.transaction(() => {
        db.run(
          `INSERT INTO runs (at, role, model, input_tokens, output_tokens, cost_usd, outcome)
           VALUES (:at, :role, :model, :inputTokens, :outputTokens, :costUsd, :outcome)`,
          { at: now(), ...run },
        );
        audit.append({
          actor: run.role,
          event: "run.recorded",
          data: { model: run.model, costUsd: run.costUsd, outcome: run.outcome },
        });
      });
    },

    costSince(since: number): number {
      return Number(db.get("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM runs WHERE at >= :since", { since })?.["c"] ?? 0);
    },
  };
}

function toTurn(row: Row): Turn {
  return { at: Number(row["at"]), role: row["role"] as Turn["role"], text: String(row["text"]) };
}
