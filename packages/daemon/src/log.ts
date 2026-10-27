import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { DaemonLog } from "./run.ts";

// Own log file with size-based rotation; launchd's stderr file then only catches crashes.
export function fileLog(path: string, instance: string, options: { maxBytes: number; keep: number }): DaemonLog {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const rotate = (): void => {
    for (let i = options.keep - 1; i >= 1; i--) {
      if (existsSync(`${path}.${i}`)) renameSync(`${path}.${i}`, `${path}.${i + 1}`);
    }
    renameSync(path, `${path}.1`);
  };
  const write = (level: string, message: string): void => {
    const line = `${JSON.stringify({ at: new Date().toISOString(), level, instance, message })}\n`;
    if (existsSync(path) && statSync(path).size + line.length > options.maxBytes) rotate();
    appendFileSync(path, line, { mode: 0o600 });
  };
  return { info: (m) => write("info", m), error: (m) => write("error", m) };
}
