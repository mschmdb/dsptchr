import { createHash } from "node:crypto";
import type { Db, Row } from "./db.ts";

export interface AuditInput {
  actor: string;
  event: string;
  subject?: string;
  data?: Record<string, unknown>;
}

export interface AuditEntry {
  seq: number;
  at: number;
  actor: string;
  event: string;
  subject: string | undefined;
  data: Record<string, unknown> | undefined;
  hash: string;
}

export class AuditTamperError extends Error {
  override name = "AuditTamperError";
}

const GENESIS = "0".repeat(64);

function entryHash(prevHash: string, seq: number, at: number, input: { actor: string; event: string; subject: string | null; dataJson: string | null }): string {
  return createHash("sha256")
    .update(JSON.stringify([prevHash, seq, at, input.actor, input.event, input.subject, input.dataJson]))
    .digest("hex");
}

export function auditLog(db: Db, now: () => number) {
  return {
    append(input: AuditInput): AuditEntry {
      return db.transaction(() => {
        const last = db.get("SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1");
        const prevHash = (last?.["hash"] as string | undefined) ?? GENESIS;
        const seq = Number(last?.["seq"] ?? 0) + 1;
        const at = now();
        const subject = input.subject ?? null;
        const dataJson = input.data === undefined ? null : JSON.stringify(input.data);
        const hash = entryHash(prevHash, seq, at, { actor: input.actor, event: input.event, subject, dataJson });
        db.run(
          `INSERT INTO audit_log (seq, at, actor, event, subject, data_json, prev_hash, hash)
           VALUES (:seq, :at, :actor, :event, :subject, :dataJson, :prevHash, :hash)`,
          { seq, at, actor: input.actor, event: input.event, subject, dataJson, prevHash, hash },
        );
        return { seq, at, actor: input.actor, event: input.event, subject: input.subject, data: input.data, hash };
      });
    },

    list(filter: { subject?: string } = {}): AuditEntry[] {
      const rows =
        filter.subject === undefined
          ? db.all("SELECT * FROM audit_log ORDER BY seq")
          : db.all("SELECT * FROM audit_log WHERE subject = :subject ORDER BY seq", { subject: filter.subject });
      return rows.map(toEntry);
    },

    // Returns the number of verified entries.
    verify(): number {
      let prevHash = GENESIS;
      const rows = db.all("SELECT * FROM audit_log ORDER BY seq");
      for (const row of rows) {
        const seq = Number(row["seq"]);
        const expected = entryHash(prevHash, seq, Number(row["at"]), {
          actor: String(row["actor"]),
          event: String(row["event"]),
          subject: (row["subject"] as string | null) ?? null,
          dataJson: (row["data_json"] as string | null) ?? null,
        });
        if (row["prev_hash"] !== prevHash || row["hash"] !== expected) {
          throw new AuditTamperError(`audit log entry ${seq} does not match its hash chain`);
        }
        prevHash = expected;
      }
      return rows.length;
    },
  };
}

export type AuditLog = ReturnType<typeof auditLog>;

function toEntry(row: Row): AuditEntry {
  const dataJson = row["data_json"] as string | null;
  return {
    seq: Number(row["seq"]),
    at: Number(row["at"]),
    actor: String(row["actor"]),
    event: String(row["event"]),
    subject: (row["subject"] as string | null) ?? undefined,
    data: dataJson === null ? undefined : (JSON.parse(dataJson) as Record<string, unknown>),
    hash: String(row["hash"]),
  };
}
