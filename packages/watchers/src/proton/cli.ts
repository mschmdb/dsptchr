import { execFile } from "node:child_process";
import { WatcherError } from "../server-health/server-health.ts";

// proton-cli holds a session for the whole account (mail, drive, pass, settings). Only this
// wrapper calls it, and only with these read commands (docs/security.md).
export type ProtonCommand =
  | { kind: "mail.list"; folder: "inbox" | "all" | "archive"; newerThan?: string; to?: string; limit: number }
  | { kind: "mail.get"; id: string }
  | { kind: "calendar.list"; after: string; before: string };

export type ProtonRun = (
  file: string,
  args: readonly string[],
  env: Record<string, string>,
) => Promise<{ exitCode: number; stdout: string }>;

// Documented read-only mode plus no prompts, no update check and no local log of mail data.
export const PROTON_ENV: Readonly<Record<string, string>> = {
  PROTON_CONFIRM: "mutations=deny",
  PROTON_NO_UPDATE_CHECK: "1",
  PROTON_NO_INPUT: "1",
  PROTON_NO_LOG: "1",
};

const ID = /^[A-Za-z0-9_=-]{1,200}$/;
const PROFILE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DURATION = /^\d{1,4}[mhd]$/;
const ADDRESS = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const FOLDERS = new Set(["inbox", "all", "archive"]);

function invalid(what: string): never {
  throw new WatcherError(`proton: invalid ${what}`);
}

export function buildProtonArgs(command: ProtonCommand, profile: string): string[] {
  if (!PROFILE.test(profile)) invalid("profile");
  const head = ["--profile", profile, "--output", "json", "--no-input"];
  switch (command.kind) {
    case "mail.list": {
      if (!FOLDERS.has(command.folder)) invalid("folder");
      if (!Number.isInteger(command.limit) || command.limit < 1 || command.limit > 100) invalid("limit");
      const args = ["mail", "messages", "list", "--folder", command.folder];
      if (command.newerThan !== undefined) {
        if (!DURATION.test(command.newerThan)) invalid("duration");
        args.push("--newer-than", command.newerThan);
      }
      if (command.to !== undefined) {
        if (!ADDRESS.test(command.to)) invalid("address");
        args.push("--to", command.to);
      }
      return [...head, ...args, "--limit", String(command.limit)];
    }
    case "mail.get":
      if (!ID.test(command.id) || command.id.startsWith("-")) invalid("message id");
      return [...head, "mail", "messages", "get", command.id, "--render", "text", "--strip-quotes"];
    case "calendar.list":
      if (!DAY.test(command.after) || !DAY.test(command.before)) invalid("date");
      return [...head, "calendar", "events", "list", "--after", command.after, "--before", command.before, "--limit", "100"];
    default:
      return invalid("command");
  }
}

export interface ProtonOptions {
  binary: string;
  profile: string;
  home: string;
  run?: ProtonRun;
}

export async function runProton(command: ProtonCommand, options: ProtonOptions): Promise<unknown> {
  const args = buildProtonArgs(command, options.profile);
  // Minimal environment: no inherited secrets, only what the CLI needs to find its session.
  const env = { ...PROTON_ENV, HOME: options.home };
  let result: { exitCode: number; stdout: string };
  try {
    result = await (options.run ?? runFile)(options.binary, args, env);
  } catch {
    throw new WatcherError("proton: could not start the CLI");
  }
  if (result.exitCode !== 0) {
    const reason =
      result.exitCode === 2
        ? "login required or failed"
        : result.exitCode === 5
          ? "network or rate limit"
          : result.exitCode === 6
            ? "mutation denied"
            : `exit code ${result.exitCode}`;
    throw new WatcherError(`proton: ${reason}`);
  }
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    throw new WatcherError("proton: output is not JSON");
  }
}

const runFile: ProtonRun = (file, args, env) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { env, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error !== null && typeof error.code !== "number") {
        reject(error);
        return;
      }
      resolve({ exitCode: error === null ? 0 : Number(error.code), stdout });
    });
  });
