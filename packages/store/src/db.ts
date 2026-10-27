import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "./migrations.ts";

export type Row = Record<string, unknown>;

export interface Db {
  run(sql: string, params?: Record<string, unknown>): { changes: number };
  get(sql: string, params?: Record<string, unknown>): Row | undefined;
  all(sql: string, params?: Record<string, unknown>): Row[];
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
  close(): void;
}

type Param = null | number | bigint | string | Uint8Array;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  if (path !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
  }
  let depth = 0;

  const toParams = (params: Record<string, unknown> = {}): Record<string, Param> => {
    const out: Record<string, Param> = {};
    for (const [key, value] of Object.entries(params)) {
      out[key] = value === undefined ? null : (value as Param);
    }
    return out;
  };

  const api: Db = {
    run: (sql, params) => {
      const result = db.prepare(sql).run(toParams(params));
      return { changes: Number(result.changes) };
    },
    get: (sql, params) => db.prepare(sql).get(toParams(params)) as Row | undefined,
    all: (sql, params) => db.prepare(sql).all(toParams(params)) as Row[],
    exec: (sql) => db.exec(sql),
    transaction: (fn) => {
      if (depth > 0) {
        depth++;
        try {
          return fn();
        } finally {
          depth--;
        }
      }
      db.exec("BEGIN IMMEDIATE");
      depth = 1;
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      } finally {
        depth = 0;
      }
    },
    close: () => db.close(),
  };

  migrate(api);
  return api;
}

function migrate(db: Db): void {
  const current = Number(db.get("PRAGMA user_version")?.["user_version"] ?? 0);
  if (current > MIGRATIONS.length) {
    throw new Error(`database schema version ${current} is newer than this code (${MIGRATIONS.length})`);
  }
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version] ?? "");
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
  }
}
