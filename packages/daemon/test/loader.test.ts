import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadInstance, InstanceError } from "../src/instance/loader.ts";
import type { Keychain, KeychainRef } from "../src/instance/keychain.ts";

function fakeKeychain(items: Record<string, string>): Keychain {
  return {
    read: async (ref: KeychainRef) => items[`${ref.service}/${ref.account}`],
  };
}

const INSTANCE_YAML = `
timezone: Europe/Berlin
channels:
  telegram:
    operator_user_id: 1001
    group_id: -1002
    bot_token: telegram_bot_token
`;

const SECRETS_YAML = `
telegram_bot_token:
  keychain:
    service: dsptchr.test
    account: telegram-bot
`;

describe("loadInstance", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dsptchr-home-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function writeInstance(name: string, files: Record<string, string>): string {
    const dir = join(home, name);
    mkdirSync(dir, { recursive: true });
    for (const [file, content] of Object.entries(files)) {
      writeFileSync(join(dir, file), content);
    }
    return dir;
  }

  it("loads config, role and paths of an instance", async () => {
    const dir = writeInstance("private", {
      "instance.yaml": INSTANCE_YAML,
      "secrets.yaml": SECRETS_YAML,
      "role.md": "You are terse.\n",
    });

    const instance = await loadInstance("private", { home, keychain: fakeKeychain({}) });

    expect(instance.name).toBe("private");
    expect(instance.dir).toBe(dir);
    expect(instance.role).toBe("You are terse.\n");
    expect(instance.config.timezone).toBe("Europe/Berlin");
    expect(instance.config.channels.telegram?.operatorUserId).toBe(1001);
    expect(instance.config.channels.telegram?.groupId).toBe(-1002);
    expect(instance.paths.stateDb).toBe(join(dir, "state.db"));
    expect(instance.paths.policy).toBe(join(dir, "policy.yaml"));
  });

  it("resolves secrets from the keychain on demand", async () => {
    writeInstance("private", { "instance.yaml": INSTANCE_YAML, "secrets.yaml": SECRETS_YAML });
    const keychain = fakeKeychain({ "dsptchr.test/telegram-bot": "bot-token-1" });

    const instance = await loadInstance("private", { home, keychain });
    const secret = await instance.secret("telegram_bot_token");

    expect(secret.reveal()).toBe("bot-token-1");
  });

  it("fails clearly when a secret reference is unknown", async () => {
    writeInstance("private", { "instance.yaml": INSTANCE_YAML, "secrets.yaml": SECRETS_YAML });
    const instance = await loadInstance("private", { home, keychain: fakeKeychain({}) });

    await expect(instance.secret("nope")).rejects.toThrow(/unknown secret "nope"/);
  });

  it("fails clearly when the keychain item is missing", async () => {
    writeInstance("private", { "instance.yaml": INSTANCE_YAML, "secrets.yaml": SECRETS_YAML });
    const instance = await loadInstance("private", { home, keychain: fakeKeychain({}) });

    await expect(instance.secret("telegram_bot_token")).rejects.toThrow(/not found in keychain/);
  });

  it("treats role.md and secrets.yaml as optional", async () => {
    writeInstance("private", { "instance.yaml": "timezone: UTC\n" });
    const instance = await loadInstance("private", { home, keychain: fakeKeychain({}) });

    expect(instance.role).toBe("");
    expect(instance.config.channels).toEqual({});
    await expect(instance.secret("x")).rejects.toThrow(InstanceError);
  });

  it("rejects instance names that could escape the base directory", async () => {
    for (const name of ["../etc", "a/b", "", ".hidden", "UPPER", "x".repeat(40)]) {
      await expect(loadInstance(name, { home, keychain: fakeKeychain({}) })).rejects.toThrow(/invalid instance name/);
    }
  });

  it("fails when the instance directory does not exist", async () => {
    await expect(loadInstance("missing", { home, keychain: fakeKeychain({}) })).rejects.toThrow(/not found/);
  });

  it("fails when instance.yaml is missing", async () => {
    writeInstance("private", { "role.md": "x" });
    await expect(loadInstance("private", { home, keychain: fakeKeychain({}) })).rejects.toThrow(/instance.yaml/);
  });

  it("fails on malformed YAML", async () => {
    writeInstance("private", { "instance.yaml": "timezone: [unclosed\n" });
    await expect(loadInstance("private", { home, keychain: fakeKeychain({}) })).rejects.toThrow(InstanceError);
  });

  it("fails on schema violations with the offending field", async () => {
    writeInstance("private", {
      "instance.yaml": "timezone: UTC\nchannels:\n  telegram:\n    operator_user_id: abc\n    group_id: 1\n    bot_token: t\n",
    });
    await expect(loadInstance("private", { home, keychain: fakeKeychain({}) })).rejects.toThrow(/operator_user_id/);
  });

  it("reads briefing times", async () => {
    writeInstance("private", { "instance.yaml": "timezone: UTC\nbriefings:\n  morning: \"07:30\"\n  evening: \"17:30\"\n" });
    const instance = await loadInstance("private", { home, keychain: fakeKeychain({}) });
    expect(instance.config.briefings).toEqual({ morning: { hour: 7, minute: 30 }, evening: { hour: 17, minute: 30 } });
  });

  it("reads the heartbeat config", async () => {
    writeInstance("private", { "instance.yaml": "timezone: UTC\nheartbeat:\n  push_url: heartbeat_url\n  interval_minutes: 5\n" });
    const instance = await loadInstance("private", { home, keychain: fakeKeychain({}) });
    expect(instance.config.heartbeat).toEqual({ pushUrl: "heartbeat_url", intervalMinutes: 5 });
  });

  it("defaults the heartbeat interval", async () => {
    writeInstance("private", { "instance.yaml": "timezone: UTC\nheartbeat:\n  push_url: heartbeat_url\n" });
    const instance = await loadInstance("private", { home, keychain: fakeKeychain({}) });
    expect(instance.config.heartbeat).toEqual({ pushUrl: "heartbeat_url", intervalMinutes: 5 });
  });

  it("defaults to no briefings", async () => {
    writeInstance("private", { "instance.yaml": "timezone: UTC\n" });
    const instance = await loadInstance("private", { home, keychain: fakeKeychain({}) });
    expect(instance.config.briefings).toEqual({});
  });

  it.each(["7:3", "24:00", "07:60", "noon"])("rejects briefing time %j", async (time) => {
    writeInstance("private", { "instance.yaml": `timezone: UTC\nbriefings:\n  morning: "${time}"\n` });
    await expect(loadInstance("private", { home, keychain: fakeKeychain({}) })).rejects.toThrow(/briefings.morning/);
  });

  it("rejects an unknown timezone", async () => {
    writeInstance("private", { "instance.yaml": "timezone: Mars/Olympus\n" });
    await expect(loadInstance("private", { home, keychain: fakeKeychain({}) })).rejects.toThrow(/timezone/);
  });

  it("rejects secret values written directly into secrets.yaml", async () => {
    writeInstance("private", { "instance.yaml": INSTANCE_YAML, "secrets.yaml": "telegram_bot_token: raw-value\n" });
    await expect(loadInstance("private", { home, keychain: fakeKeychain({}) })).rejects.toThrow(/secrets.yaml/);
  });

  it("rejects unknown keys to catch typos", async () => {
    writeInstance("private", { "instance.yaml": "timezone: UTC\ntimezon: UTC\n" });
    await expect(loadInstance("private", { home, keychain: fakeKeychain({}) })).rejects.toThrow(/timezon/);
  });

  it("reports unreadable files as instance errors", async () => {
    const dir = writeInstance("private", { "instance.yaml": "timezone: UTC\n" });
    chmodSync(join(dir, "instance.yaml"), 0o000);
    try {
      await expect(loadInstance("private", { home, keychain: fakeKeychain({}) })).rejects.toThrow(InstanceError);
    } finally {
      chmodSync(join(dir, "instance.yaml"), 0o600);
    }
  });
});
