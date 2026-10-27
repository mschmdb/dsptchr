import type { Db, Row } from "./db.ts";
import type { Features } from "./feedback.ts";

export type TriageState = "pending" | "notified" | "briefing" | "briefed" | "dropped";

export interface TriageItem {
  id: string;
  source: string;
  externalId: string;
  // Sanitized operator-facing text; never shown to the model.
  text: string;
  urgent: boolean;
  features: Features;
  label: string;
  state: TriageState;
  createdAt: number;
}

export interface TriageInput {
  source: string;
  externalId: string;
  text: string;
  urgent: boolean;
  features: Features;
  label: string;
}

// Durable queue between watchers and the operator. Watchers record what they saw when they
// enqueue; the triage run decides what the operator sees now, in the briefing, or never.
export function triageRepo(db: Db, now: () => number, newId: () => string) {
  const get = (id: string): TriageItem | undefined => {
    const row = db.get("SELECT * FROM triage_queue WHERE id = :id", { id });
    return row === undefined ? undefined : toItem(row);
  };
  const byState = (state: TriageState): TriageItem[] =>
    db.all("SELECT * FROM triage_queue WHERE state = :state ORDER BY created_at, rowid", { state }).map(toItem);

  return {
    get,

    enqueue(input: TriageInput): TriageItem {
      return db.transaction(() => {
        const existing = db.get("SELECT * FROM triage_queue WHERE source = :source AND external_id = :externalId", {
          source: input.source,
          externalId: input.externalId,
        });
        if (existing !== undefined) return toItem(existing);
        const id = newId();
        db.run(
          `INSERT INTO triage_queue (id, source, external_id, text, urgent, features_json, label, state, created_at)
           VALUES (:id, :source, :externalId, :text, :urgent, :features, :label, 'pending', :at)`,
          {
            id,
            source: input.source,
            externalId: input.externalId,
            text: input.text,
            urgent: input.urgent ? 1 : 0,
            features: JSON.stringify(input.features),
            label: input.label,
            at: now(),
          },
        );
        return get(id) as TriageItem;
      });
    },

    pending: (): TriageItem[] => byState("pending"),
    forBriefing: (): TriageItem[] => byState("briefing"),
    hasUrgent: (): boolean => db.get("SELECT 1 AS x FROM triage_queue WHERE state = 'pending' AND urgent = 1 LIMIT 1") !== undefined,

    settle(ids: readonly string[], state: Exclude<TriageState, "pending">): void {
      db.transaction(() => {
        for (const id of ids) {
          db.run(
            `UPDATE triage_queue SET state = :state, settled_at = :at
             WHERE id = :id AND state IN ('pending', 'briefing')`,
            { id, state, at: now() },
          );
        }
      });
    },
  };
}

export type TriageRepo = ReturnType<typeof triageRepo>;

function toItem(row: Row): TriageItem {
  return {
    id: String(row["id"]),
    source: String(row["source"]),
    externalId: String(row["external_id"]),
    text: String(row["text"]),
    urgent: Number(row["urgent"]) === 1,
    features: JSON.parse(String(row["features_json"])) as Features,
    label: String(row["label"]),
    state: row["state"] as TriageState,
    createdAt: Number(row["created_at"]),
  };
}
