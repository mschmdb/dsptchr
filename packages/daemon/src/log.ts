import type { DaemonLog } from "./run.ts";

// JSON lines on stderr; launchd writes them to the configured log file.
export function stderrLog(instance: string): DaemonLog {
  const write = (level: string, message: string): void => {
    process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), level, instance, message })}\n`);
  };
  return { info: (m) => write("info", m), error: (m) => write("error", m) };
}
