import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type App } from "../src/app.ts";
import { loadInstance } from "../src/instance/loader.ts";

// Milestone: todo via Telegram -> stored with due date -> reminder with buttons
// at the due time -> done on button press -> every step in the audit log.

const TOKEN = "999:FAKE-TOKEN";
const OPERATOR = 1001;
const GROUP = -1002;
const T0 = Date.parse("2026-10-27T10:00:00Z");

type Json = Record<string, unknown>;

function fakeTelegram() {
  const inbox: Json[][] = [];
  const sent: Json[] = [];
  const calls: string[] = [];
  let messageId = 100;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = url.slice(url.lastIndexOf("/") + 1);
    calls.push(method);
    const body = JSON.parse(String(init?.body)) as Json;
    let result: unknown = true;
    if (method === "getUpdates") result = inbox.shift() ?? [];
    if (method === "sendMessage") {
      sent.push(body);
      result = { message_id: ++messageId, chat: { id: body["chat_id"] } };
    }
    return new Response(JSON.stringify({ ok: true, result }));
  };
  return { fetch, inbox, sent, calls };
}

describe("phase 1 milestone", () => {
  let home: string;
  let app: App;
  const clock = { now: T0 };
  let telegram: ReturnType<typeof fakeTelegram>;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "dsptchr-e2e-"));
    const dir = join(home, "test");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "instance.yaml"),
      `timezone: Europe/Berlin\nchannels:\n  telegram:\n    operator_user_id: ${OPERATOR}\n    group_id: ${GROUP}\n    bot_token: bot\n`,
    );
    writeFileSync(join(dir, "secrets.yaml"), "bot:\n  keychain:\n    service: dsptchr.test\n    account: bot\n");
    writeFileSync(
      join(dir, "policy.yaml"),
      "actions:\n  message.send:\n    level: auto\n  message.ack:\n    level: auto\n  todo.create:\n    level: auto\n  todo.update:\n    level: auto\n",
    );
    const instance = await loadInstance("test", { home, keychain: { read: async () => TOKEN } });
    telegram = fakeTelegram();
    clock.now = T0;
    app = await createApp(instance, { fetch: telegram.fetch, now: () => clock.now, pollTimeoutSeconds: 0 });
  });

  afterEach(() => {
    app.close();
    rmSync(home, { recursive: true, force: true });
  });

  async function pump(): Promise<void> {
    app.inbox.accept(await app.channel.receive());
    await app.inbox.drain();
  }

  it("captures a todo, reminds with buttons and completes it", async () => {
    telegram.inbox.push([
      { update_id: 1, message: { message_id: 1, from: { id: OPERATOR }, chat: { id: GROUP }, text: "Water plants @ in 1h" } },
      { update_id: 2, message: { message_id: 2, from: { id: 4242 }, chat: { id: GROUP }, text: "stop" } },
    ]);
    await pump();

    const [todo] = app.store.todos.listActive();
    expect(todo).toMatchObject({ text: "Water plants", dueAt: T0 + 3_600_000 });
    expect(app.store.flags.isPaused()).toBe(false);
    expect(telegram.sent.at(-1)).toMatchObject({ chat_id: GROUP, text: expect.stringContaining("Saved: Water plants") });

    expect(await app.tick()).toBe(0);
    clock.now = T0 + 3_600_000;
    expect(await app.tick()).toBe(1);
    const reminder = telegram.sent.at(-1);
    expect(reminder).toMatchObject({ chat_id: GROUP, text: "Reminder: Water plants" });
    const keyboard = (reminder?.["reply_markup"] as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard;
    const doneData = keyboard[0]?.[0]?.callback_data;
    expect(doneData).toBe(`todo:done:${todo?.id}`);

    telegram.inbox.push([
      {
        update_id: 3,
        callback_query: { id: "cb", from: { id: OPERATOR }, data: doneData, message: { message_id: 101, chat: { id: GROUP } } },
      },
    ]);
    await pump();

    expect(app.store.todos.get(todo?.id ?? "")?.state).toBe("done");
    expect(telegram.calls.slice(-2)).toEqual(["answerCallbackQuery", "editMessageReplyMarkup"]);

    const events = app.store.audit.list().map((e) => e.event);
    expect(events).toEqual(
      expect.arrayContaining(["channel.rejected", "todo.created", "action.succeed", "todo.complete"]),
    );
    expect(app.store.audit.verify()).toBe(events.length);
    expect(JSON.stringify(app.store.audit.list())).not.toContain(TOKEN);
  });

  it("refuses to start with ask policies until operator approvals exist", async () => {
    writeFileSync(join(home, "test", "policy.yaml"), "actions:\n  message.send:\n    level: ask\n");
    const instance = await loadInstance("test", { home, keychain: { read: async () => TOKEN } });
    await expect(createApp(instance, { fetch: telegram.fetch })).rejects.toThrow(/ask/);
  });

  it("processes an accepted event after a restart", async () => {
    telegram.inbox.push([
      { update_id: 20, message: { message_id: 1, from: { id: OPERATOR }, chat: { id: GROUP }, text: "Buy milk" } },
    ]);
    app.inbox.accept(await app.channel.receive());
    app.close();

    const instance = await loadInstance("test", { home, keychain: { read: async () => TOKEN } });
    app = await createApp(instance, { fetch: telegram.fetch, now: () => clock.now, pollTimeoutSeconds: 0 });
    expect(app.store.todos.listActive()).toEqual([]);
    await app.inbox.drain();
    expect(app.store.todos.listActive().map((t) => t.text)).toEqual(["Buy milk"]);
  });

  it("persists the Telegram offset so restarts do not replay handled updates", async () => {
    telegram.inbox.push([
      { update_id: 10, message: { message_id: 1, from: { id: OPERATOR }, chat: { id: GROUP }, text: "Buy milk" } },
    ]);
    await pump();
    await pump();
    expect(app.store.cursors.get("telegram")).toBe("11");
  });
});
