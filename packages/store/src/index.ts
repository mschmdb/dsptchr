import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { actionRepo } from "./actions.ts";
import { auditLog } from "./audit.ts";
import { openDb } from "./db.ts";
import { conversationRepo, orchestratorEventRepo, runRepo } from "./conversation.ts";
import { feedbackRepo, ruleRepo } from "./feedback.ts";
import { inboxRepo } from "./inbox.ts";
import { observationRepo } from "./observations.ts";
import { cursorRepo, flagRepo } from "./kv.ts";
import { reminderRepo } from "./reminders.ts";
import { todoRepo } from "./todos.ts";

export { AuditTamperError, type AuditEntry, type AuditInput, type AuditLog } from "./audit.ts";
export type { Reminder, ReminderState, ReminderRepo } from "./reminders.ts";
export type { StoredAction, ActionRepo } from "./actions.ts";
export type { TodoRepo } from "./todos.ts";
export type { Features, NotifiedItem, Rule, Verdict } from "./feedback.ts";
export type { InboxEntry, InboxRepo, InboxState } from "./inbox.ts";
export type { OrchestratorEvent, RunRecord, Turn } from "./conversation.ts";
export type { Observation, ObservationRepo, ObserveResult } from "./observations.ts";

export interface StoreOptions {
  path: string;
  now?: () => number;
  newId?: () => string;
}

export function openStore(options: StoreOptions) {
  const now = options.now ?? Date.now;
  const newId = options.newId ?? randomUUID;
  const db = openDb(options.path);
  const audit = auditLog(db, now);

  return {
    audit,
    todos: todoRepo(db, audit, now, newId),
    reminders: reminderRepo(db, now, newId),
    actions: actionRepo(db, audit, now, newId),
    cursors: cursorRepo(db, now),
    flags: flagRepo(db, audit),
    inbox: inboxRepo(db, audit, now),
    observations: observationRepo(db, audit, now),
    conversation: conversationRepo(db, now),
    runs: runRepo(db, audit, now),
    orchestratorEvents: orchestratorEventRepo(db, now),
    feedback: feedbackRepo(db, audit, now),
    rules: ruleRepo(db, audit, now, newId),
    transaction: <T>(fn: () => T): T => db.transaction(fn),
    // Consistent snapshot of the whole database; refuses to overwrite an existing file.
    backup: (target: string): void => {
      if (existsSync(target)) throw new Error("backup target already exists");
      db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    },
    // Test hook for asserting database-level guarantees. Not for application code.
    unsafeExec: (sql: string): void => db.exec(sql),
    close: (): void => db.close(),
  };
}

export type Store = ReturnType<typeof openStore>;
