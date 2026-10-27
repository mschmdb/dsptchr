import { describe, expect, it } from "vitest";
import { buildProtonArgs, runProton, PROTON_ENV, type ProtonCommand } from "../src/proton/cli.ts";
import { WatcherError } from "../src/index.ts";

describe("buildProtonArgs", () => {
  it.each<[ProtonCommand, string[]]>([
    [
      { kind: "mail.list", folder: "inbox", newerThan: "2h", limit: 50 },
      ["mail", "messages", "list", "--folder", "inbox", "--newer-than", "2h", "--limit", "50"],
    ],
    [
      { kind: "mail.list", folder: "all", to: "user+todo@example.com", limit: 20 },
      ["mail", "messages", "list", "--folder", "all", "--to", "user+todo@example.com", "--limit", "20"],
    ],
    [
      { kind: "mail.list", folder: "inbox", newerThan: "2h", limit: 50, page: 2 },
      ["mail", "messages", "list", "--folder", "inbox", "--newer-than", "2h", "--limit", "50", "--page", "2"],
    ],
    [{ kind: "mail.get", id: "aBc-_123==" }, ["mail", "messages", "get", "aBc-_123==", "--render", "text", "--strip-quotes"]],
    [
      { kind: "calendar.list", after: "2026-10-27", before: "2026-10-28" },
      ["calendar", "events", "list", "--after", "2026-10-27", "--before", "2026-10-28", "--limit", "100"],
    ],
  ])("builds allowlisted arguments for %j", (command, args) => {
    expect(buildProtonArgs(command, "dsptchr")).toEqual(["--profile", "dsptchr", "--output", "json", "--no-input", ...args]);
  });

  it.each<ProtonCommand>([
    { kind: "mail.get", id: "--yes" },
    { kind: "mail.get", id: "abc; rm -rf /" },
    { kind: "mail.list", folder: "inbox", newerThan: "2h; ls", limit: 5 },
    { kind: "mail.list", folder: "inbox", to: "--folder=trash", limit: 5 },
    { kind: "mail.list", folder: "inbox", limit: 0 },
    { kind: "mail.list", folder: "inbox", limit: 1000 },
    { kind: "mail.list", folder: "inbox", limit: 5, page: -1 },
    { kind: "calendar.list", after: "tomorrow", before: "2026-10-28" },
    { kind: "pass.list" } as unknown as ProtonCommand,
    { kind: "mail.list", folder: "trash", limit: 5 } as unknown as ProtonCommand,
  ])("rejects %j", (command) => {
    expect(() => buildProtonArgs(command, "dsptchr")).toThrow(WatcherError);
  });

  it("rejects profile names that could be flags", () => {
    expect(() => buildProtonArgs({ kind: "mail.get", id: "a" }, "--x")).toThrow(WatcherError);
  });
});

describe("runProton", () => {
  it("runs the pinned binary with a read-only environment and parses JSON", async () => {
    const calls: { file: string; args: readonly string[]; env: Record<string, string> }[] = [];
    const result = await runProton({ kind: "mail.get", id: "a" }, {
      binary: "/opt/proton",
      profile: "dsptchr",
      home: "/home/test",
      run: async (file, args, env) => {
        calls.push({ file, args, env });
        return { exitCode: 0, stdout: '{"id":"a"}' };
      },
    });
    expect(result).toEqual({ id: "a" });
    expect(calls[0]?.file).toBe("/opt/proton");
    expect(calls[0]?.env).toEqual({ ...PROTON_ENV, HOME: "/home/test" });
    expect(PROTON_ENV).toMatchObject({ PROTON_CONFIRM: "mutations=deny", PROTON_NO_UPDATE_CHECK: "1", PROTON_NO_INPUT: "1" });
  });

  it.each([
    [2, /login/],
    [5, /network or rate limit/],
    [6, /denied/],
    [1, /exit code 1/],
  ])("maps exit code %i without echoing output", async (exitCode, message) => {
    const error = await runProton({ kind: "mail.get", id: "a" }, {
      binary: "/opt/proton",
      profile: "p",
      home: "/h",
      run: async () => ({ exitCode, stdout: "secret subject line" }),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WatcherError);
    expect(String(error)).toMatch(message);
    expect(String(error)).not.toContain("secret subject");
  });

  it("rejects non-JSON output", async () => {
    await expect(
      runProton({ kind: "mail.get", id: "a" }, { binary: "/b", profile: "p", home: "/h", run: async () => ({ exitCode: 0, stdout: "x" }) }),
    ).rejects.toThrow(/not JSON/);
  });
});
