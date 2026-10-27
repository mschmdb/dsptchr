import type { AuditLog } from "./audit.ts";
import type { Db } from "./db.ts";

export function cursorRepo(db: Db, now: () => number) {
  return {
    get(source: string): string | undefined {
      const row = db.get("SELECT value FROM cursors WHERE source = :source", { source });
      return row === undefined ? undefined : String(row["value"]);
    },
    set(source: string, value: string): void {
      db.run(
        `INSERT INTO cursors (source, value, updated_at) VALUES (:source, :value, :at)
         ON CONFLICT(source) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        { source, value, at: now() },
      );
    },
  };
}

const PAUSED = "paused";

export function flagRepo(db: Db, audit: AuditLog) {
  return {
    isPaused(): boolean {
      return db.get("SELECT value FROM flags WHERE key = :key", { key: PAUSED })?.["value"] === "1";
    },
    setPaused(paused: boolean, actor: string): void {
      db.transaction(() => {
        db.run(
          `INSERT INTO flags (key, value) VALUES (:key, :value)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          { key: PAUSED, value: paused ? "1" : "0" },
        );
        audit.append({ actor, event: paused ? "kill_switch.paused" : "kill_switch.resumed" });
      });
    },
  };
}
