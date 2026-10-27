import { execFile } from "node:child_process";
import { z } from "zod";

export interface ServerHealthConfig {
  command: string;
  args: readonly string[];
  timeoutMs: number;
  // The script may cover hosts of several instances (e.g. private and work). Only these
  // hosts belong to this instance; everything else is dropped before it is stored or sent.
  hosts: readonly string[];
}

export type RunCommand = (
  file: string,
  args: readonly string[],
  options: { timeoutMs: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export class WatcherError extends Error {
  override name = "WatcherError";
}

const findingSchema = z.object({
  key: z.string().min(1).max(200),
  severity: z.enum(["crit", "warn", "info"]),
  host: z.string().min(1).max(100),
  text: z.string().max(2000),
});

const reportSchema = z.object({
  findings: z.array(findingSchema).max(500),
  hosts: z.record(z.string(), z.unknown()),
});

export type HealthFinding = z.infer<typeof findingSchema>;

export interface HealthReport {
  findings: HealthFinding[];
  // Hosts the script actually checked; findings of other hosts must not be resolved.
  evaluatedHosts: string[];
}

// Wraps the operator's existing health-check script (D-15). The script stays unchanged;
// this code only runs it and validates its JSON. Its stderr may name hosts, so errors
// carry only the exit code.
export async function runServerHealth(config: ServerHealthConfig, run: RunCommand = runCommand): Promise<HealthReport> {
  let result: Awaited<ReturnType<RunCommand>>;
  try {
    result = await run(config.command, config.args, { timeoutMs: config.timeoutMs });
  } catch {
    throw new WatcherError("server health: check did not start or timed out");
  }
  if (result.exitCode !== 0) {
    throw new WatcherError(`server health: check failed with exit code ${result.exitCode}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(result.stdout);
  } catch {
    throw new WatcherError("server health: output is not JSON");
  }
  const parsed = reportSchema.safeParse(raw);
  if (!parsed.success) {
    throw new WatcherError(`server health: unexpected report format (${parsed.error.issues[0]?.path.join(".") ?? "root"})`);
  }
  const allowed = new Set(config.hosts);
  return {
    findings: parsed.data.findings
      .filter((f) => allowed.has(f.host))
      .map((f) => ({ key: f.key, severity: f.severity, host: f.host, text: f.text })),
    evaluatedHosts: Object.keys(parsed.data.hosts).filter((host) => allowed.has(host)),
  };
}

const runCommand: RunCommand = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { encoding: "utf8", timeout: options.timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({ exitCode: error === null ? 0 : Number(error.code), stdout, stderr });
      },
    );
  });
