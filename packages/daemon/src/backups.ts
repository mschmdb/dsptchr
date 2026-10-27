import { chmodSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { wallClockOf } from "@dsptchr/core";
import type { Store } from "@dsptchr/store";

export interface BackupJobDeps {
  store: Store;
  dir: string;
  keep: number;
  now: () => number;
  timeZone: string;
}

const NAME = /^state-\d{4}-\d{2}-\d{2}\.db$/;
const pad = (n: number): string => String(n).padStart(2, "0");

// One snapshot of the state database per local day, owner-only, the newest `keep` retained.
export function createBackupJob({ store, dir, keep, now, timeZone }: BackupJobDeps) {
  return {
    async tick(): Promise<boolean> {
      const w = wallClockOf(now(), timeZone);
      const name = `state-${w.year}-${pad(w.month)}-${pad(w.day)}.db`;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const existing = readdirSync(dir).filter((f) => NAME.test(f));
      if (existing.includes(name)) return false;
      const target = join(dir, name);
      store.backup(target);
      chmodSync(target, 0o600);
      const all = [...existing, name].sort();
      for (const old of all.slice(0, Math.max(0, all.length - keep))) {
        rmSync(join(dir, old), { force: true });
      }
      return true;
    },
  };
}
