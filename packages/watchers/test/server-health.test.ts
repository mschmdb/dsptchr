import { describe, expect, it } from "vitest";
import { runServerHealth, WatcherError, type RunCommand } from "../src/server-health/server-health.ts";

const REPORT = {
  ts: "2026-10-27T10:00:00+01:00",
  skipped_groups: ["group-b"],
  notify: true,
  new: ["host-a:disk"],
  findings: [
    { key: "host-a:disk", severity: "crit", host: "host-a", text: "Disk 95% voll, 2 GB frei" },
    { key: "host-a:ctr:web:state", severity: "warn", host: "host-a", text: "Container web gestoppt (exited)" },
    { key: "host-a:reboot", severity: "info", host: "host-a", text: "Reboot für Updates nötig" },
  ],
  hosts: { "host-a": "load 0.3, mem 40%", "host-c": "ok" },
};

function fakeRun(result: { exitCode: number; stdout: string; stderr?: string } | Error): RunCommand & { calls: unknown[] } {
  const calls: unknown[] = [];
  const run = (async (file: string, args: readonly string[], options: { timeoutMs: number }) => {
    calls.push({ file, args, options });
    if (result instanceof Error) throw result;
    return { stderr: "", ...result };
  }) as RunCommand & { calls: unknown[] };
  run.calls = calls;
  return run;
}

const config = { command: "/opt/health/check", args: ["run", "--dry"], timeoutMs: 300_000 };

describe("runServerHealth", () => {
  it("runs the configured command without a shell and parses the report", async () => {
    const run = fakeRun({ exitCode: 0, stdout: JSON.stringify(REPORT) });
    const report = await runServerHealth(config, run);

    expect(run.calls).toEqual([{ file: "/opt/health/check", args: ["run", "--dry"], options: { timeoutMs: 300_000 } }]);
    expect(report.findings).toHaveLength(3);
    expect(report.evaluatedHosts).toEqual(["host-a", "host-c"]);
  });

  it("ignores unknown top-level fields and keeps the finding fields it needs", async () => {
    const report = await runServerHealth(config, fakeRun({ exitCode: 0, stdout: JSON.stringify(REPORT) }));
    expect(report.findings[0]).toEqual({ key: "host-a:disk", severity: "crit", host: "host-a", text: "Disk 95% voll, 2 GB frei" });
  });

  it("fails on a non-zero exit without echoing output", async () => {
    const error = await runServerHealth(config, fakeRun({ exitCode: 2, stdout: "", stderr: "ssh: secret-host refused" })).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(WatcherError);
    expect(String(error)).toContain("exit code 2");
    expect(String(error)).not.toContain("secret-host");
  });

  it.each([
    ["not JSON", "not json"],
    ["missing findings", JSON.stringify({ ts: "x", hosts: {} })],
    ["unknown severity", JSON.stringify({ ...REPORT, findings: [{ key: "k", severity: "fatal", host: "h", text: "t" }] })],
    ["oversized key", JSON.stringify({ ...REPORT, findings: [{ key: "k".repeat(300), severity: "warn", host: "h", text: "t" }] })],
  ])("rejects malformed output: %s", async (_name, stdout) => {
    await expect(runServerHealth(config, fakeRun({ exitCode: 0, stdout }))).rejects.toThrow(WatcherError);
  });

  it("wraps spawn failures", async () => {
    await expect(runServerHealth(config, fakeRun(new Error("ENOENT")))).rejects.toThrow(WatcherError);
  });
});
