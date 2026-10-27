import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBackupJob } from "../src/backups.ts";
import { guarded } from "../src/alerts.ts";
import { fileLog } from "../src/log.ts";
import { harness, TZ } from "./support/harness.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dsptchr-ops-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("backup job", () => {
  it("writes one owner-only backup per local day and keeps the newest ones", async () => {
    const h = harness();
    const job = createBackupJob({ store: h.store, dir, keep: 3, now: () => h.clock.now, timeZone: TZ });
    for (let day = 0; day < 5; day++) {
      await job.tick();
      await job.tick();
      h.clock.now += 86_400_000;
    }
    const files = readdirSync(dir).sort();
    expect(files).toEqual(["state-2026-10-29.db", "state-2026-10-30.db", "state-2026-10-31.db"]);
    expect(statSync(join(dir, files[0] ?? "")).mode & 0o777).toBe(0o600);
  });

  it("ignores unrelated files in the backup directory", async () => {
    const h = harness();
    writeFileSync(join(dir, "notes.txt"), "keep");
    const job = createBackupJob({ store: h.store, dir, keep: 1, now: () => h.clock.now, timeZone: TZ });
    await job.tick();
    expect(readdirSync(dir).sort()).toEqual(["notes.txt", "state-2026-10-27.db"]);
  });
});

describe("guarded watcher", () => {
  it("alerts after three failed runs and recovers on success", async () => {
    const h = harness();
    let fail = true;
    const watcher = guarded(
      { tick: async () => {
        if (fail) throw new Error("session expired");
        return true;
      } },
      { store: h.store, dispatcher: h.dispatcher, source: "mail", label: "Mail watcher", now: () => h.clock.now, timeZone: TZ, threshold: 3 },
    );
    for (let i = 0; i < 4; i++) await watcher.tick();
    expect(h.sent.map((m) => m.text)).toEqual(["Mail watcher failed 3 times in a row (Error). Last success: never."]);
    fail = false;
    await watcher.tick();
    fail = true;
    for (let i = 0; i < 3; i++) await watcher.tick();
    expect(h.sent).toHaveLength(2);
  });

  it("does not count runs that were not due", async () => {
    const h = harness();
    const watcher = guarded(
      { tick: async () => false },
      { store: h.store, dispatcher: h.dispatcher, source: "x", label: "X", now: () => h.clock.now, timeZone: TZ, threshold: 1 },
    );
    expect(await watcher.tick()).toBe(false);
    expect(h.sent).toEqual([]);
  });
});

describe("file log", () => {
  it("writes JSON lines and rotates by size, keeping a fixed number of files", () => {
    const path = join(dir, "daemon.log");
    const log = fileLog(path, "private", { maxBytes: 200, keep: 2 });
    for (let i = 0; i < 20; i++) log.info(`message ${i} ${"x".repeat(20)}`);
    const files = readdirSync(dir).sort();
    expect(files).toEqual(["daemon.log", "daemon.log.1", "daemon.log.2"]);
    const last = readFileSync(path, "utf8").trim().split("\n").at(-1) ?? "";
    expect(JSON.parse(last)).toMatchObject({ level: "info", instance: "private", message: expect.stringContaining("message 19") });
  });
});
