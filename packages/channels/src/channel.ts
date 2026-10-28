import { z } from "zod";

// Messenger-neutral contract. No module outside `channels` knows a messenger (AR-8).

export interface Button {
  label: string;
  // Opaque to the channel; at most 64 bytes.
  data: string;
}

export interface OutboundMessage {
  text: string;
  buttons?: Button[][];
  // Where to send; defaults to the channel's home conversation.
  conversation?: string;
}

export interface SentMessage {
  conversation: string;
  messageRef: string;
}

// `id` is stable across redelivery, so handlers can use it as idempotency key.
export type InboundEvent =
  | { kind: "text"; id: string; text: string; conversation: string; receivedAt: number }
  | {
      kind: "button";
      id: string;
      data: string;
      conversation: string;
      messageRef: string;
      callbackRef: string;
      receivedAt: number;
    };

export interface Replacement {
  text: string;
  buttons?: Button[][] | undefined;
}

export interface AckTarget {
  conversation: string;
  messageRef: string;
  callbackRef: string;
}

export interface Channel {
  // Waits for the next batch of operator events. Events from anyone else are dropped.
  receive(signal?: AbortSignal): Promise<InboundEvent[]>;
  send(message: OutboundMessage): Promise<SentMessage>;
  // Confirms a button press to the operator with a short note. Without a replacement it
  // removes the message's buttons; with one it replaces the message's text and buttons.
  acknowledge(target: AckTarget, note: string, replacement?: Replacement): Promise<void>;
}

export const MAX_BUTTON_DATA_BYTES = 64;

// Validates events read back from persistent storage (the daemon's inbox).
export const inboundEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("text"),
    id: z.string().min(1),
    text: z.string(),
    conversation: z.string().min(1),
    receivedAt: z.number(),
  }),
  z.strictObject({
    kind: z.literal("button"),
    id: z.string().min(1),
    data: z.string(),
    conversation: z.string().min(1),
    messageRef: z.string().min(1),
    callbackRef: z.string().min(1),
    receivedAt: z.number(),
  }),
]) satisfies z.ZodType<InboundEvent>;
