import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { Secret } from "../src/instance/secret.ts";
import { macosKeychain, type RunCommand } from "../src/instance/keychain.ts";

describe("Secret", () => {
  const secret = new Secret("telegram_bot_token", "s3cr3t-value");

  it("reveals the value only on explicit request", () => {
    expect(secret.reveal()).toBe("s3cr3t-value");
  });

  it("never shows the value in string, JSON or inspect output", () => {
    expect(String(secret)).not.toContain("s3cr3t");
    expect(JSON.stringify({ secret })).not.toContain("s3cr3t");
    expect(inspect(secret)).not.toContain("s3cr3t");
    expect(`${secret}`).toContain("telegram_bot_token");
  });
});

describe("macosKeychain", () => {
  it("calls security without a shell and returns the trimmed password", async () => {
    const calls: { file: string; args: readonly string[] }[] = [];
    const run: RunCommand = async (file, args) => {
      calls.push({ file, args });
      return { exitCode: 0, stdout: "pw-123\n" };
    };
    const keychain = macosKeychain(run);

    await expect(keychain.read({ service: "dsptchr.test", account: "bot" })).resolves.toBe("pw-123");
    expect(calls).toEqual([
      { file: "/usr/bin/security", args: ["find-generic-password", "-s", "dsptchr.test", "-a", "bot", "-w"] },
    ]);
  });

  it("returns undefined when the item does not exist", async () => {
    const keychain = macosKeychain(async () => ({ exitCode: 44, stdout: "" }));
    await expect(keychain.read({ service: "s", account: "a" })).resolves.toBeUndefined();
  });

  it("throws on other failures without leaking output", async () => {
    const keychain = macosKeychain(async () => ({ exitCode: 51, stdout: "partial-secret" }));
    const error = await keychain.read({ service: "s", account: "a" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("51");
    expect(String(error)).not.toContain("partial-secret");
  });
});
