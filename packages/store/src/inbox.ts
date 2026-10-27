import type { AuditLog } from "./audit.ts";
import type { Db, Row } from "./db.ts";

export type InboxState = "pending" | "done" | "dead";

export interface InboxEntry {
  id: string;
  receivedAt: number;
  payload: unknown;
  state: InboxState;
  attempts: number;
  lastError: string | undefined;
}

// Durable queue for inbound events. A channel confirms its events only after they are
// accepted here, so a crash or handler failure never loses operator input.
// The payload holds operator content; the audit log records only IDs and error names.
export function inboxRepo(db: Db, audit: AuditLog, now: () => number) {
  const get = (id: string): InboxEntry | undefined => {
    const row = db.get("SELECT * FROM inbox WHERE id = :id", { id });
    return row === undefined ? undefined : toEntry(row);
  };

  return {
    get,

    // Returns the number of new entries. Known IDs are ignored, including done ones.
    accept(entries: readonly { id: string; receivedAt: number; payload: unknown }[]): number {
      return db.transaction(() => {
        let added = 0;
        for (const entry of entries) {
          const { changes } = db.run(
            `INSERT INTO inbox (id, received_at, payload_json, state, next_attempt_at)
             VALUES (:id, :receivedAt, :payload, 'pending', :at)
             ON CONFLICT(id) DO NOTHING`,
            { id: entry.id, receivedAt: entry.receivedAt, payload: JSON.stringify(entry.payload), at: now() },
          );
          if (changes > 0) {
            added++;
            audit.append({ actor: "inbox", event: "inbox.accepted", subject: entry.id });
          }
        }
        return added;
      });
    },

    due(limit = 50): InboxEntry[] {
      return db
        .all(
          `SELECT * FROM inbox WHERE state = 'pending' AND next_attempt_at <= :now
           ORDER BY received_at, seq LIMIT :limit`,
          { now: now(), limit },
        )
        .map(toEntry);
    },

    markDone(id: string): void {
      db.run("UPDATE inbox SET state = 'done', done_at = :at WHERE id = :id AND state = 'pending'", { id, at: now() });
    },

    markFailed(id: string, options: { maxAttempts: number; retryAt: number; error: string }): InboxState {
      return db.transaction(() => {
        db.run(
          `UPDATE inbox
           SET attempts = attempts + 1,
               state = CASE WHEN attempts + 1 >= :max THEN 'dead' ELSE 'pending' END,
               next_attempt_at = :retryAt,
               last_error = :error
           WHERE id = :id AND state = 'pending'`,
          { id, max: options.maxAttempts, retryAt: options.retryAt, error: options.error },
        );
        const entry = get(id);
        const state = entry?.state ?? "dead";
        audit.append({
          actor: "inbox",
          event: state === "dead" ? "inbox.dead" : "inbox.retry",
          subject: id,
          data: { attempts: entry?.attempts ?? null, error: options.error },
        });
        return state;
      });
    },

    // Drops payloads of entries done before `before`; the ID stays for dedupe.
    purgeDone(before: number): number {
      return db.run(
        "UPDATE inbox SET payload_json = NULL WHERE state = 'done' AND done_at < :before AND payload_json IS NOT NULL",
        { before },
      ).changes;
    },
  };
}

export type InboxRepo = ReturnType<typeof inboxRepo>;

function toEntry(row: Row): InboxEntry {
  const payload = row["payload_json"] as string | null;
  return {
    id: String(row["id"]),
    receivedAt: Number(row["received_at"]),
    payload: payload === null ? undefined : (JSON.parse(payload) as unknown),
    state: row["state"] as InboxState,
    attempts: Number(row["attempts"]),
    lastError: (row["last_error"] as string | null) ?? undefined,
  };
}
