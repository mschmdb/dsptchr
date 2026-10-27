import type { AckTarget, Channel, InboundEvent, OutboundMessage } from "@dsptchr/channels";
import { createExecutor } from "@dsptchr/executor";
import { parsePolicy } from "@dsptchr/gate";
import { openStore, type Store } from "@dsptchr/store";
import { createDispatcher, type Dispatcher } from "../../src/dispatch.ts";

export const TZ = "Europe/Berlin";
// Tuesday 2026-10-27 11:00 in Berlin.
export const T0 = Date.parse("2026-10-27T10:00:00Z");

export const POLICY = parsePolicy(`
actions:
  message.send:
    level: auto
    rate_limit: { max: 30, per_minutes: 60 }
  message.ack:
    level: auto
  todo.create:
    level: auto
  todo.update:
    level: auto
`);

export interface Harness {
  store: Store;
  clock: { now: number };
  sent: OutboundMessage[];
  acks: { target: AckTarget; note: string }[];
  channel: Channel;
  dispatcher: Dispatcher;
  failSends: { value: boolean };
}

export function harness(policy = POLICY): Harness {
  const clock = { now: T0 };
  const store = openStore({ path: ":memory:", now: () => clock.now });
  const sent: OutboundMessage[] = [];
  const acks: { target: AckTarget; note: string }[] = [];
  const failSends = { value: false };
  const channel: Channel = {
    receive: async () => [],
    send: async (message) => {
      if (failSends.value) throw new Error("network down");
      sent.push(message);
      return { conversation: message.conversation ?? "home", messageRef: String(sent.length) };
    },
    acknowledge: async (target, note) => {
      if (failSends.value) throw new Error("network down");
      acks.push({ target, note });
    },
  };
  const executor = createExecutor({ store, channel });
  const dispatcher = createDispatcher({ store, executor, policy, now: () => clock.now });
  return { store, clock, sent, acks, channel, dispatcher, failSends };
}

let counter = 0;

export function text(value: string, conversation = "-1002"): InboundEvent {
  counter++;
  return { kind: "text", id: `test:${counter}`, text: value, conversation, receivedAt: T0 };
}

export function button(data: string, conversation = "-1002"): InboundEvent {
  counter++;
  return {
    kind: "button",
    id: `test:${counter}`,
    data,
    conversation,
    messageRef: "1",
    callbackRef: `cb-${counter}`,
    receivedAt: T0,
  };
}
