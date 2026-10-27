import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const hooksPath = resolve(import.meta.dirname, "../../.githooks");
const hasGitleaks = spawnSync("gitleaks", ["version"]).status === 0;

describe.skipIf(!hasGitleaks)("git hooks (end to end)", () => {
  let repo: string;
  let denylist: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "dsptchr-hooks-"));
    denylist = join(repo, "..", `${repo.split("/").pop()}-denylist.txt`);
    writeFileSync(denylist, "host-zz9\n");
    git(["init", "-q"]);
    git(["config", "user.name", "Test"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "core.hooksPath", hooksPath]);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(denylist, { force: true });
  });

  function git(args: string[]): string {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  }

  function commit(file: string, content: string, message: string): number {
    writeFileSync(join(repo, file), content);
    git(["add", file]);
    const result = spawnSync("git", ["commit", "-q", "-m", message], {
      cwd: repo,
      env: { ...process.env, DSPTCHR_DENYLIST: denylist },
    });
    return result.status ?? -1;
  }

  it("accepts a clean commit", () => {
    expect(commit("a.txt", "hello example.com\n", "Add greeting")).toBe(0);
  });

  it("rejects a denylisted term in content", () => {
    expect(commit("a.txt", "ssh HOST-ZZ9\n", "Add note")).toBe(1);
  });

  it("rejects a denylisted term in a file name", () => {
    expect(commit("host-zz9.txt", "clean\n", "Add file")).toBe(1);
  });

  it("rejects a denylisted term in the commit message", () => {
    expect(commit("a.txt", "clean\n", "Deploy to host-zz9")).toBe(1);
  });

  it("rejects a secret found by gitleaks", () => {
    const token = `ghp_${randomBytes(18).toString("hex")}`;
    expect(commit("a.txt", `token = "${token}"\n`, "Add config")).toBe(1);
  });
});
