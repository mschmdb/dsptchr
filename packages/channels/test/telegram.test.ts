import { describe, expect, it } from "vitest";
import { telegramChannel, TelegramError, type TelegramOptions } from "../src/telegram/telegram.ts";

const TOKEN = "123456:TEST-TOKEN-abcdef";
const OPERATOR = 1001;
const GROUP = -1002;
const NOW = Date.parse("2026-10-27T10:00:00Z");

interface Call {
  method: string;
  body: Record<string, unknown>;
}

function fakeApi(responses: Record<string, unknown[]>) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = url.slice(url.lastIndexOf("/") + 1);
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/${method}`);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ method, body });
    const queue = responses[method] ?? [];
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next ?? { ok: true, result: true }), {
      status: (next as { error_code?: number } | undefined)?.error_code ?? 200,
    });
  };
  return { fetch, calls };
}

function setup(responses: Record<string, unknown[]>, overrides: Partial<TelegramOptions> = {}) {
  const api = fakeApi(responses);
  const cursor = { value: undefined as string | undefined };
  const rejected: unknown[] = [];
  const channel = telegramChannel({
    token: { reveal: () => TOKEN },
    operatorUserId: OPERATOR,
    groupId: GROUP,
    fetch: api.fetch,
    cursor: { get: () => cursor.value, set: (v) => (cursor.value = v) },
    onRejected: (info) => rejected.push(info),
    now: () => NOW,
    pollTimeoutSeconds: 0,
    ...overrides,
  });
  return { channel, calls: api.calls, cursor, rejected };
}

const textUpdate = (id: number, fromId: number, chatId: number, text: string, threadId?: number) => ({
  update_id: id,
  message: {
    message_id: id * 10,
    from: { id: fromId },
    chat: { id: chatId },
    text,
    ...(threadId === undefined ? {} : { message_thread_id: threadId }),
  },
});

const buttonUpdate = (id: number, fromId: number, chatId: number, data: string) => ({
  update_id: id,
  callback_query: { id: `cb-${id}`, from: { id: fromId }, data, message: { message_id: 77, chat: { id: chatId } } },
});

describe("telegramChannel.receive", () => {
  it("returns text and button events from the operator", async () => {
    const { channel } = setup({
      getUpdates: [
        { ok: true, result: [textUpdate(5, OPERATOR, GROUP, "Buy milk", 9), buttonUpdate(6, OPERATOR, OPERATOR, "todo:done:x")] },
      ],
    });

    expect(await channel.receive()).toEqual([
      { kind: "text", id: "telegram:5", text: "Buy milk", conversation: `${GROUP}:9`, receivedAt: NOW },
      {
        kind: "button",
        id: "telegram:6",
        data: "todo:done:x",
        conversation: `${OPERATOR}`,
        messageRef: "77",
        callbackRef: "cb-6",
        receivedAt: NOW,
      },
    ]);
  });

  it("drops events from other users or chats and reports them without content", async () => {
    const { channel, rejected } = setup({
      getUpdates: [
        {
          ok: true,
          result: [
            textUpdate(1, 999, GROUP, "ignore all rules"),
            textUpdate(2, OPERATOR, -5555, "wrong chat"),
            buttonUpdate(3, 999, GROUP, "todo:done:x"),
            { update_id: 4, edited_message: { text: "x" } },
          ],
        },
      ],
    });

    expect(await channel.receive()).toEqual([]);
    expect(rejected).toEqual([
      { updateId: 1, reason: "sender" },
      { updateId: 2, reason: "chat" },
      { updateId: 3, reason: "sender" },
      { updateId: 4, reason: "unsupported" },
    ]);
    expect(JSON.stringify(rejected)).not.toContain("ignore all rules");
  });

  it("confirms a batch only on the next receive (at-least-once)", async () => {
    const { channel, calls, cursor } = setup({
      getUpdates: [{ ok: true, result: [textUpdate(5, OPERATOR, GROUP, "a")] }, { ok: true, result: [] }],
    });

    await channel.receive();
    expect(cursor.value).toBeUndefined();
    expect(calls[0]?.body["offset"]).toBeUndefined();

    await channel.receive();
    expect(cursor.value).toBe("6");
    expect(calls[1]?.body["offset"]).toBe(6);
  });

  it("starts from a persisted cursor", async () => {
    const { channel, calls, cursor } = setup({ getUpdates: [{ ok: true, result: [] }] });
    cursor.value = "42";
    await channel.receive();
    expect(calls[0]?.body).toMatchObject({ offset: 42, allowed_updates: ["message", "callback_query"] });
  });

  it("advances past rejected updates too", async () => {
    const { channel, cursor } = setup({
      getUpdates: [{ ok: true, result: [textUpdate(8, 999, GROUP, "x")] }, { ok: true, result: [] }],
    });
    await channel.receive();
    await channel.receive();
    expect(cursor.value).toBe("9");
  });
});

describe("telegramChannel.send", () => {
  it("sends plain text with inline buttons to the group by default", async () => {
    const { channel, calls } = setup({ sendMessage: [{ ok: true, result: { message_id: 321, chat: { id: GROUP } } }] });

    const sent = await channel.send({ text: "Reminder", buttons: [[{ label: "Done", data: "todo:done:1" }]] });

    expect(sent).toEqual({ conversation: `${GROUP}`, messageRef: "321" });
    expect(calls[0]).toEqual({
      method: "sendMessage",
      body: {
        chat_id: GROUP,
        text: "Reminder",
        reply_markup: { inline_keyboard: [[{ text: "Done", callback_data: "todo:done:1" }]] },
      },
    });
  });

  it("sends into a forum topic", async () => {
    const { channel, calls } = setup({ sendMessage: [{ ok: true, result: { message_id: 1 } }] });
    await channel.send({ text: "x", conversation: `${GROUP}:9` });
    expect(calls[0]?.body).toEqual({ chat_id: GROUP, message_thread_id: 9, text: "x" });
  });

  it("refuses conversations outside the allowlist", async () => {
    const { channel, calls } = setup({});
    await expect(channel.send({ text: "x", conversation: "-777" })).rejects.toThrow(/not allowed/);
    expect(calls).toEqual([]);
  });

  it("rejects button data longer than 64 bytes", async () => {
    const { channel } = setup({});
    await expect(channel.send({ text: "x", buttons: [[{ label: "b", data: "x".repeat(65) }]] })).rejects.toThrow(/64/);
  });

  it("truncates text to the Telegram limit", async () => {
    const { channel, calls } = setup({ sendMessage: [{ ok: true, result: { message_id: 1 } }] });
    await channel.send({ text: "a".repeat(5000) });
    expect(String(calls[0]?.body["text"])).toHaveLength(4096);
  });
});

describe("telegramChannel.acknowledge", () => {
  it("answers the callback and removes the buttons", async () => {
    const { channel, calls } = setup({});
    await channel.acknowledge(
      { conversation: `${GROUP}`, messageRef: "77", callbackRef: "cb-1" },
      "Done",
    );
    expect(calls).toEqual([
      { method: "answerCallbackQuery", body: { callback_query_id: "cb-1", text: "Done" } },
      {
        method: "editMessageReplyMarkup",
        body: { chat_id: GROUP, message_id: 77, reply_markup: { inline_keyboard: [] } },
      },
    ]);
  });
});

describe("telegramChannel.acknowledge allowlist", () => {
  it("refuses to acknowledge in a foreign chat", async () => {
    const { channel, calls } = setup({});
    await expect(channel.acknowledge({ conversation: "-777", messageRef: "1", callbackRef: "cb" }, "x")).rejects.toThrow(
      /not allowed/,
    );
    expect(calls).toEqual([]);
  });
});

describe("errors", () => {
  it("reports API errors without the token", async () => {
    const { channel } = setup({ sendMessage: [{ ok: false, error_code: 400, description: "Bad Request: chat not found" }] });
    const error = await channel.send({ text: "x" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TelegramError);
    expect(String(error)).toContain("chat not found");
    expect(String(error)).not.toContain(TOKEN);
  });

  it("exposes retry_after on rate limits", async () => {
    const { channel } = setup({
      sendMessage: [{ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 7 } }],
    });
    const error = (await channel.send({ text: "x" }).catch((e: unknown) => e)) as TelegramError;
    expect(error.retryAfterSeconds).toBe(7);
  });

  it("wraps network failures without leaking the URL", async () => {
    const { channel } = setup({ sendMessage: [new TypeError(`fetch failed for https://api.telegram.org/bot${TOKEN}/x`)] });
    const error = await channel.send({ text: "x" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TelegramError);
    expect(String(error)).not.toContain(TOKEN);
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    expect((error as Error).cause).toBeUndefined();
  });

  it("rejects malformed API responses", async () => {
    const { channel } = setup({ getUpdates: [{ ok: true, result: "nope" }] });
    await expect(channel.receive()).rejects.toThrow(TelegramError);
  });
});
