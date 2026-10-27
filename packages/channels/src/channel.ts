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

export interface Channel {
  // Waits for the next batch of operator events. Events from anyone else are dropped.
  receive(signal?: AbortSignal): Promise<InboundEvent[]>;
  send(message: OutboundMessage): Promise<SentMessage>;
  // Confirms a button press to the operator and replaces the message's buttons with a note.
  acknowledge(event: Extract<InboundEvent, { kind: "button" }>, note: string): Promise<void>;
}

export const MAX_BUTTON_DATA_BYTES = 64;
