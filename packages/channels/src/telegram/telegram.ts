import { z } from "zod";
import { MAX_BUTTON_DATA_BYTES, type Channel, type InboundEvent, type OutboundMessage } from "../channel.ts";
import { apiResponseSchema, sentMessageSchema, updateSchema, type Update } from "./api.ts";

export interface TelegramOptions {
  token: { reveal(): string };
  operatorUserId: number;
  groupId: number;
  cursor: { get(): string | undefined; set(value: string): void };
  onRejected?: (info: { updateId: number; reason: "sender" | "chat" | "unsupported" }) => void;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  pollTimeoutSeconds?: number;
}

export class TelegramError extends Error {
  override name = "TelegramError";
  readonly retryAfterSeconds: number | undefined;

  constructor(message: string, retryAfterSeconds?: number) {
    super(message);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const API_BASE = "https://api.telegram.org";
const MAX_TEXT = 4096;

export function telegramChannel(options: TelegramOptions): Channel {
  const fetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const pollTimeout = options.pollTimeoutSeconds ?? 30;
  const allowedChats = new Set([options.groupId, options.operatorUserId]);
  let pendingOffset: number | undefined;

  async function call(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${API_BASE}/bot${options.token.reveal()}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if ((error as Error).name === "AbortError") throw error;
      // The original error may contain the URL with the token; drop it.
      throw new TelegramError(`${method}: network request failed`);
    }
    const parsed = apiResponseSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) {
      throw new TelegramError(`${method}: malformed response (HTTP ${response.status})`);
    }
    if (!parsed.data.ok) {
      const { error_code, description, parameters } = parsed.data;
      throw new TelegramError(`${method}: ${error_code ?? response.status} ${description ?? ""}`.trim(), parameters?.retry_after);
    }
    return parsed.data.result;
  }

  function parseConversation(conversation: string | undefined): { chatId: number; threadId?: number } {
    if (conversation === undefined) return { chatId: options.groupId };
    const [chat, thread] = conversation.split(":");
    const chatId = Number(chat);
    if (!allowedChats.has(chatId)) {
      throw new TelegramError("conversation not allowed");
    }
    return thread === undefined ? { chatId } : { chatId, threadId: Number(thread) };
  }

  function toEvent(update: Update): InboundEvent | undefined {
    const reject = (reason: "sender" | "chat" | "unsupported"): undefined => {
      options.onRejected?.({ updateId: update.update_id, reason });
      return undefined;
    };
    const receivedAt = now();

    if (update.message?.text !== undefined) {
      const { message } = update;
      if (message.from?.id !== options.operatorUserId) return reject("sender");
      if (!allowedChats.has(message.chat.id)) return reject("chat");
      return { kind: "text", text: message.text ?? "", conversation: conversationOf(message.chat.id, message.message_thread_id), receivedAt };
    }
    if (update.callback_query?.data !== undefined && update.callback_query.message !== undefined) {
      const query = update.callback_query;
      const message = update.callback_query.message;
      if (query.from.id !== options.operatorUserId) return reject("sender");
      if (!allowedChats.has(message.chat.id)) return reject("chat");
      return {
        kind: "button",
        data: query.data ?? "",
        conversation: conversationOf(message.chat.id, message.message_thread_id),
        messageRef: String(message.message_id),
        callbackRef: query.id,
        receivedAt,
      };
    }
    return reject("unsupported");
  }

  return {
    async receive(signal) {
      if (pendingOffset !== undefined) {
        options.cursor.set(String(pendingOffset));
        pendingOffset = undefined;
      }
      const stored = options.cursor.get();
      const result = await call(
        "getUpdates",
        {
          ...(stored === undefined ? {} : { offset: Number(stored) }),
          timeout: pollTimeout,
          allowed_updates: ["message", "callback_query"],
        },
        signal,
      );
      const updates = z.array(updateSchema).safeParse(result);
      if (!updates.success) {
        throw new TelegramError("getUpdates: malformed updates");
      }
      if (updates.data.length > 0) {
        pendingOffset = Math.max(...updates.data.map((u) => u.update_id)) + 1;
      }
      return updates.data.map(toEvent).filter((event): event is InboundEvent => event !== undefined);
    },

    async send(message: OutboundMessage) {
      const { chatId, threadId } = parseConversation(message.conversation);
      for (const row of message.buttons ?? []) {
        for (const button of row) {
          if (Buffer.byteLength(button.data, "utf8") > MAX_BUTTON_DATA_BYTES) {
            throw new TelegramError(`button data exceeds ${MAX_BUTTON_DATA_BYTES} bytes`);
          }
        }
      }
      const result = await call("sendMessage", {
        chat_id: chatId,
        ...(threadId === undefined ? {} : { message_thread_id: threadId }),
        text: message.text.slice(0, MAX_TEXT),
        ...(message.buttons === undefined
          ? {}
          : {
              reply_markup: {
                inline_keyboard: message.buttons.map((row) => row.map((b) => ({ text: b.label, callback_data: b.data }))),
              },
            }),
      });
      const sent = sentMessageSchema.safeParse(result);
      if (!sent.success) {
        throw new TelegramError("sendMessage: malformed result");
      }
      return { conversation: conversationOf(chatId, threadId), messageRef: String(sent.data.message_id) };
    },

    async acknowledge(event, note) {
      await call("answerCallbackQuery", { callback_query_id: event.callbackRef, text: note });
      const { chatId } = parseConversation(event.conversation);
      await call("editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: Number(event.messageRef),
        reply_markup: { inline_keyboard: [] },
      });
    },
  };
}

function conversationOf(chatId: number, threadId: number | undefined): string {
  return threadId === undefined ? String(chatId) : `${chatId}:${threadId}`;
}
