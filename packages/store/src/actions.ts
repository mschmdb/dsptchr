import { nextActionState, type ActionEvent, type ActionState } from "@dsptchr/core";
import type { AuditLog } from "./audit.ts";
import type { Db, Row } from "./db.ts";

export interface StoredAction {
  id: string;
  type: string;
  payload: unknown;
  state: ActionState;
  idempotencyKey: string;
  retries: number;
  result: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface ProposeAction {
  type: string;
  payload: unknown;
  idempotencyKey: string;
  actor: string;
}

// Payloads may carry message text, so the audit log records only type and state.
export function actionRepo(db: Db, audit: AuditLog, now: () => number, newId: () => string) {
  const get = (id: string): StoredAction | undefined => {
    const row = db.get("SELECT * FROM actions WHERE id = :id", { id });
    return row === undefined ? undefined : toAction(row);
  };
  const byKey = (key: string): StoredAction | undefined => {
    const row = db.get("SELECT * FROM actions WHERE idempotency_key = :key", { key });
    return row === undefined ? undefined : toAction(row);
  };

  return {
    get,

    propose(input: ProposeAction): { action: StoredAction; created: boolean } {
      return db.transaction(() => {
        const existing = byKey(input.idempotencyKey);
        if (existing !== undefined) {
          return { action: existing, created: false };
        }
        const id = newId();
        const at = now();
        db.run(
          `INSERT INTO actions (id, type, payload_json, state, idempotency_key, created_at, updated_at)
           VALUES (:id, :type, :payload, 'proposed', :key, :at, :at)`,
          { id, type: input.type, payload: JSON.stringify(input.payload), key: input.idempotencyKey, at },
        );
        audit.append({ actor: input.actor, event: "action.proposed", subject: id, data: { type: input.type } });
        return { action: get(id) as StoredAction, created: true };
      });
    },

    transition(id: string, event: ActionEvent, options: { actor: string; result?: unknown }): StoredAction {
      return db.transaction(() => {
        const action = get(id);
        if (action === undefined) {
          throw new Error(`action ${id} not found`);
        }
        const state = nextActionState(action.state, event);
        db.run(
          `UPDATE actions SET state = :state, updated_at = :at,
             retries = retries + :retry,
             result_json = COALESCE(:result, result_json)
           WHERE id = :id`,
          {
            id,
            state,
            at: now(),
            retry: event === "retry" ? 1 : 0,
            result: options.result === undefined ? undefined : JSON.stringify(options.result),
          },
        );
        audit.append({
          actor: options.actor,
          event: `action.${event}`,
          subject: id,
          data: { type: action.type, from: action.state, to: state },
        });
        return get(id) as StoredAction;
      });
    },
  };
}

export type ActionRepo = ReturnType<typeof actionRepo>;

function toAction(row: Row): StoredAction {
  const result = row["result_json"] as string | null;
  return {
    id: String(row["id"]),
    type: String(row["type"]),
    payload: JSON.parse(String(row["payload_json"])) as unknown,
    state: row["state"] as ActionState,
    idempotencyKey: String(row["idempotency_key"]),
    retries: Number(row["retries"]),
    result: result === null ? undefined : (JSON.parse(result) as unknown),
    createdAt: Number(row["created_at"]),
    updatedAt: Number(row["updated_at"]),
  };
}
