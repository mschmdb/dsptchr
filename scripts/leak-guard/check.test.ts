import { describe, expect, it } from "vitest";
import { runCheck, type CheckDeps } from "./check.ts";

const diffWith = (line: string): string =>
  ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -0,0 +1 @@", `+${line}`].join("\n");

function deps(overrides: Partial<CheckDeps> = {}): CheckDeps {
  return {
    readDenylist: () => "host-a\n",
    readMessage: () => "Add feature",
    stagedDiff: () => diffWith("const x = 1;"),
    stagedPaths: () => ["a.ts"],
    ...overrides,
  };
}

describe("runCheck staged", () => {
  it("passes clean staged content", () => {
    expect(runCheck(["staged"], deps())).toEqual({ exitCode: 0, output: "" });
  });

  it("rejects staged content with a denylisted term", () => {
    const result = runCheck(["staged"], deps({ stagedDiff: () => diffWith("ssh Host-A") }));
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("a.ts:2");
    expect(result.output).not.toContain("host-a");
  });

  it("rejects staged paths with a denylisted term, e.g. pure renames", () => {
    const result = runCheck(["staged"], deps({ stagedDiff: () => "", stagedPaths: () => ["docs/host-a.md"] }));
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("staged path:1");
    expect(result.output).not.toContain("host-a");
  });

  it("passes with a warning when the denylist is missing", () => {
    const result = runCheck(["staged"], deps({ readDenylist: () => undefined }));
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/warning/i);
  });

  it("passes with a warning when the denylist has no terms", () => {
    const result = runCheck(["staged"], deps({ readDenylist: () => "# only comments\n" }));
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/warning/i);
  });
});

describe("runCheck message", () => {
  it("passes a clean commit message", () => {
    expect(runCheck(["message", "MSG"], deps()).exitCode).toBe(0);
  });

  it("rejects a commit message with a denylisted term", () => {
    const result = runCheck(["message", "MSG"], deps({ readMessage: () => "Fix\n\nDeploy to HOST-A" }));
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("commit message:3");
  });

  it("ignores git comment lines in the message", () => {
    const result = runCheck(["message", "MSG"], deps({ readMessage: () => "Fix\n# host-a in comment" }));
    expect(result.exitCode).toBe(0);
  });

  it("fails without a message file argument", () => {
    expect(runCheck(["message"], deps()).exitCode).toBe(2);
  });
});

describe("runCheck usage", () => {
  it("fails on an unknown mode", () => {
    expect(runCheck(["nope"], deps()).exitCode).toBe(2);
  });
});
