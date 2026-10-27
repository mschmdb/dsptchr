import { randomUUID } from "node:crypto";
import { actionRepo } from "./actions.ts";
import { auditLog } from "./audit.ts";
import { openDb } from "./db.ts";
import { inboxRepo } from "./inbox.ts";
import { cursorRepo, flagRepo } from "./kv.ts";
import { reminderRepo } from "./reminders.ts";
import { todoRepo } from "./todos.ts";

export { AuditTamperError, type AuditEntry, type AuditInput, type AuditLog } from "./audit.ts";
export type { Reminder, ReminderState, ReminderRepo } from "./reminders.ts";
export type { StoredAction, ActionRepo } from "./actions.ts";
export type { TodoRepo } from "./todos.ts";
export type { InboxEntry, InboxRepo, InboxState } from "./inbox.ts";

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
    transaction: <T>(fn: () => T): T => db.transaction(fn),
    // Test hook for asserting database-level guarantees. Not for application code.
    unsafeExec: (sql: string): void => db.exec(sql),
    close: (): void => db.close(),
  };
}

export type Store = ReturnType<typeof openStore>;
