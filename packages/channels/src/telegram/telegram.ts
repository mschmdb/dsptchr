import { z } from "zod";
import { MAX_BUTTON_DATA_BYTES, type Button, type Channel, type InboundEvent, type OutboundMessage } from "../channel.ts";
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
  // Upper bound for one request; long polls get the poll timeout on top.
  requestTimeoutMs?: number;
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
  const requestTimeout = options.requestTimeoutMs ?? 15_000;
  const allowedChats = new Set([options.groupId, options.operatorUserId]);
  let pendingOffset: number | undefined;

  async function call(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    extraTimeoutMs = 0,
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(requestTimeout + extraTimeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    let response: Response;
    try {
      response = await fetch(`${API_BASE}/bot${options.token.reveal()}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch (error) {
      if (signal?.aborted === true) throw error;
      if (timeout.aborted) throw new TelegramError(`${method}: request timed out`);
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
      return {
        kind: "text",
        id: `telegram:${update.update_id}`,
        text: message.text ?? "",
        conversation: conversationOf(message.chat.id, message.message_thread_id),
        receivedAt,
      };
    }
    if (update.callback_query?.data !== undefined && update.callback_query.message !== undefined) {
      const query = update.callback_query;
      const message = update.callback_query.message;
      if (query.from.id !== options.operatorUserId) return reject("sender");
      if (!allowedChats.has(message.chat.id)) return reject("chat");
      return {
        kind: "button",
        id: `telegram:${update.update_id}`,
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
        pollTimeout * 1000,
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
      checkButtons(message.buttons);
      const result = await call("sendMessage", {
        chat_id: chatId,
        ...(threadId === undefined ? {} : { message_thread_id: threadId }),
        text: message.text.slice(0, MAX_TEXT),
        // Link previews would show third-party page content (titles, images) in the chat.
        link_preview_options: { is_disabled: true },
        ...(message.buttons === undefined ? {} : { reply_markup: keyboard(message.buttons) }),
      });
      const sent = sentMessageSchema.safeParse(result);
      if (!sent.success) {
        throw new TelegramError("sendMessage: malformed result");
      }
      return { conversation: conversationOf(chatId, threadId), messageRef: String(sent.data.message_id) };
    },

    async acknowledge(target, note, replacement) {
      const { chatId } = parseConversation(target.conversation);
      checkButtons(replacement?.buttons);
      await call("answerCallbackQuery", { callback_query_id: target.callbackRef, text: note.slice(0, 200) });
      if (replacement === undefined) {
        await call("editMessageReplyMarkup", {
          chat_id: chatId,
          message_id: Number(target.messageRef),
          reply_markup: { inline_keyboard: [] },
        });
        return;
      }
      try {
        await call("editMessageText", {
          chat_id: chatId,
          message_id: Number(target.messageRef),
          text: replacement.text.slice(0, MAX_TEXT),
          link_preview_options: { is_disabled: true },
          reply_markup: keyboard(replacement.buttons ?? []),
        });
      } catch (error) {
        // A repeated tap re-renders the same content; Telegram reports that as an error.
        if (!(error instanceof TelegramError && error.message.includes("message is not modified"))) throw error;
      }
    },
  };
}

function checkButtons(buttons: Button[][] | undefined): void {
  for (const row of buttons ?? []) {
    for (const button of row) {
      if (Buffer.byteLength(button.data, "utf8") > MAX_BUTTON_DATA_BYTES) {
        throw new TelegramError(`button data exceeds ${MAX_BUTTON_DATA_BYTES} bytes`);
      }
    }
  }
}

function keyboard(buttons: Button[][]): { inline_keyboard: { text: string; callback_data: string }[][] } {
  return { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.label, callback_data: b.data }))) };
}

function conversationOf(chatId: number, threadId: number | undefined): string {
  return threadId === undefined ? String(chatId) : `${chatId}:${threadId}`;
}
