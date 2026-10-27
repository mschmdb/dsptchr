import type { AuditLog } from "./audit.ts";
import type { Db, Row } from "./db.ts";

export interface Observation {
  source: string;
  externalId: string;
  version: string;
  state: "open" | "resolved";
  data: unknown;
  firstSeenAt: number;
  lastSeenAt: number;
  resolvedAt: number | undefined;
}

export type ObserveResult =
  | { status: "new" | "unchanged"; item: Observation }
  | { status: "changed"; item: Observation; previousVersion: string };

// What a watcher last saw per source and external ID. Deduplication is code (AR-5):
// an observation is "new" the first time or after it was resolved, "changed" when its
// version differs. Data may hold untrusted source text and never enters the audit log.
export function observationRepo(db: Db, audit: AuditLog, now: () => number) {
  const get = (source: string, externalId: string): Observation | undefined => {
    const row = db.get("SELECT * FROM observations WHERE source = :source AND external_id = :externalId", {
      source,
      externalId,
    });
    return row === undefined ? undefined : toObservation(row);
  };
  const subject = (source: string, externalId: string): string => `${source}:${externalId}`;

  return {
    get,

    observe(input: { source: string; externalId: string; version: string; data: unknown }): ObserveResult {
      return db.transaction(() => {
        const existing = get(input.source, input.externalId);
        const at = now();
        const data = JSON.stringify(input.data);
        const params = { source: input.source, externalId: input.externalId, version: input.version, data, at };

        if (existing === undefined || existing.state === "resolved") {
          db.run(
            `INSERT INTO observations (source, external_id, version, state, data_json, first_seen_at, last_seen_at)
             VALUES (:source, :externalId, :version, 'open', :data, :at, :at)
             ON CONFLICT(source, external_id) DO UPDATE SET
               version = excluded.version, state = 'open', data_json = excluded.data_json,
               first_seen_at = excluded.first_seen_at, last_seen_at = excluded.last_seen_at, resolved_at = NULL`,
            params,
          );
          audit.append({
            actor: "watcher",
            event: "observation.new",
            subject: subject(input.source, input.externalId),
            data: { version: input.version },
          });
          return { status: "new", item: get(input.source, input.externalId) as Observation };
        }

        db.run(
          `UPDATE observations SET version = :version, data_json = :data, last_seen_at = :at
           WHERE source = :source AND external_id = :externalId`,
          params,
        );
        const item = get(input.source, input.externalId) as Observation;
        if (existing.version === input.version) {
          return { status: "unchanged", item };
        }
        audit.append({
          actor: "watcher",
          event: "observation.changed",
          subject: subject(input.source, input.externalId),
          data: { from: existing.version, to: input.version },
        });
        return { status: "changed", item, previousVersion: existing.version };
      });
    },

    listOpen(source: string): Observation[] {
      return db
        .all("SELECT * FROM observations WHERE source = :source AND state = 'open' ORDER BY first_seen_at, external_id", {
          source,
        })
        .map(toObservation);
    },

    resolve(source: string, externalId: string): void {
      db.transaction(() => {
        const { changes } = db.run(
          `UPDATE observations SET state = 'resolved', resolved_at = :at
           WHERE source = :source AND external_id = :externalId AND state = 'open'`,
          { source, externalId, at: now() },
        );
        if (changes > 0) {
          audit.append({ actor: "watcher", event: "observation.resolved", subject: subject(source, externalId) });
        }
      });
    },
  };
}

export type ObservationRepo = ReturnType<typeof observationRepo>;

function toObservation(row: Row): Observation {
  return {
    source: String(row["source"]),
    externalId: String(row["external_id"]),
    version: String(row["version"]),
    state: row["state"] as Observation["state"],
    data: JSON.parse(String(row["data_json"])) as unknown,
    firstSeenAt: Number(row["first_seen_at"]),
    lastSeenAt: Number(row["last_seen_at"]),
    resolvedAt: row["resolved_at"] === null ? undefined : Number(row["resolved_at"]),
  };
}
