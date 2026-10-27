import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { addedLinesFromDiff, findHits, formatHits, parseDenylist, type Hit } from "./denylist.ts";

export interface CheckDeps {
  readDenylist: () => string | undefined;
  readMessage: (path: string) => string;
  stagedDiff: () => string;
  stagedPaths: () => string[];
}

export interface CheckResult {
  exitCode: number;
  output: string;
}

const USAGE = "usage: check.ts staged | message <commit-msg-file>";

export function runCheck(args: readonly string[], deps: CheckDeps): CheckResult {
  const [mode, messagePath] = args;
  if (mode !== "staged" && mode !== "message") {
    return { exitCode: 2, output: USAGE };
  }
  if (mode === "message" && messagePath === undefined) {
    return { exitCode: 2, output: USAGE };
  }

  const raw = deps.readDenylist();
  const terms = raw === undefined ? [] : parseDenylist(raw);
  if (terms.length === 0) {
    return { exitCode: 0, output: "leak-guard warning: denylist missing or empty, check skipped" };
  }

  // Paths are scanned separately because pure renames carry no content diff.
  // A path hit reports only its position: the path itself may be the leak.
  const hits: Hit[] =
    mode === "staged"
      ? [
          ...findHits(deps.stagedPaths().join("\n"), terms, "staged path"),
          ...addedLinesFromDiff(deps.stagedDiff()).flatMap((input) => findHits(input.text, terms, input.source)),
        ]
      : findHits(withoutGitComments(deps.readMessage(messagePath ?? "")), terms, "commit message");

  if (hits.length === 0) {
    return { exitCode: 0, output: "" };
  }
  return { exitCode: 1, output: `leak-guard: private terms found\n${formatHits(hits)}` };
}

// Keeps line numbers stable so reported positions match the editor.
function withoutGitComments(message: string): string {
  return message
    .split("\n")
    .map((line) => (line.startsWith("#") ? "" : line))
    .join("\n");
}

export function defaultDenylistPath(): string {
  return process.env["DSPTCHR_DENYLIST"] ?? join(homedir(), ".config", "dsptchr", "denylist.txt");
}

const realDeps: CheckDeps = {
  readDenylist: () => {
    const path = defaultDenylistPath();
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  },
  readMessage: (path) => readFileSync(path, "utf8"),
  stagedDiff: () =>
    execFileSync("git", ["diff", "--cached", "--no-color", "--no-ext-diff", "-U0", "--diff-filter=ACMR"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }),
  stagedPaths: () =>
    execFileSync("git", ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    })
      .split("\0")
      .filter((path) => path !== ""),
};

if (import.meta.main) {
  const result = runCheck(process.argv.slice(2), realDeps);
  if (result.output !== "") {
    (result.exitCode === 0 ? process.stdout : process.stderr).write(`${result.output}\n`);
  }
  process.exitCode = result.exitCode;
}
