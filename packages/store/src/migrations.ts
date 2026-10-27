// Append new migrations at the end. Never edit an applied one.
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE audit_log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    actor TEXT NOT NULL,
    event TEXT NOT NULL,
    subject TEXT,
    data_json TEXT,
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL
  );
  CREATE INDEX audit_log_subject ON audit_log(subject);
  CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
  CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;

  CREATE TABLE todos (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('open', 'snoozed', 'done', 'dropped')),
    due_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX todos_state ON todos(state, due_at);

  CREATE TABLE reminders (
    id TEXT PRIMARY KEY,
    todo_id TEXT NOT NULL REFERENCES todos(id),
    fire_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'sent', 'cancelled', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX reminders_due ON reminders(state, fire_at);

  CREATE TABLE actions (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    state TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    retries INTEGER NOT NULL DEFAULT 0,
    result_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE cursors (
    source TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE flags (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `
  ALTER TABLE actions ADD COLUMN draft_hash TEXT;
  CREATE INDEX actions_type_created ON actions(type, created_at);
  `,
  `
  CREATE TABLE inbox (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    received_at INTEGER NOT NULL,
    payload_json TEXT,
    state TEXT NOT NULL CHECK (state IN ('pending', 'done', 'dead')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    last_error TEXT,
    done_at INTEGER
  );
  CREATE INDEX inbox_due ON inbox(state, next_attempt_at);
  `,
  `
  ALTER TABLE inbox ADD COLUMN dead_notified INTEGER NOT NULL DEFAULT 0;
  `,
  `
  CREATE TABLE observations (
    source TEXT NOT NULL,
    external_id TEXT NOT NULL,
    version TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('open', 'resolved')),
    data_json TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    resolved_at INTEGER,
    PRIMARY KEY (source, external_id)
  );
  `,
];
