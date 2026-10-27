import { readFile } from "node:fs/promises";
import { telegramChannel, type Channel, type InboundEvent } from "@dsptchr/channels";
import { createExecutor } from "@dsptchr/executor";
import { parsePolicy } from "@dsptchr/gate";
import { openStore, type Store } from "@dsptchr/store";
import { createDispatcher } from "./dispatch.ts";
import { InstanceError, type Instance } from "./instance/loader.ts";
import { createOperatorHandler } from "./operator.ts";
import { createReminderScheduler } from "./reminders.ts";

export interface AppOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  pollTimeoutSeconds?: number;
}

export interface App {
  store: Store;
  channel: Channel;
  handle(event: InboundEvent): Promise<void>;
  tick(): Promise<number>;
  close(): void;
}

// Wires one instance. Refuses to start without a policy: no policy, no actions.
export async function createApp(instance: Instance, options: AppOptions = {}): Promise<App> {
  const now = options.now ?? Date.now;
  const policyText = await readFile(instance.paths.policy, "utf8").catch(() => {
    throw new InstanceError(`policy.yaml missing in ${instance.dir}`);
  });
  const policy = parsePolicy(policyText);
  const telegram = instance.config.channels.telegram;
  if (telegram === undefined) {
    throw new InstanceError("instance.yaml: channels.telegram is required");
  }
  const token = await instance.secret(telegram.botToken);

  const store = openStore({ path: instance.paths.stateDb, now });
  const channel = telegramChannel({
    token,
    operatorUserId: telegram.operatorUserId,
    groupId: telegram.groupId,
    cursor: {
      get: () => store.cursors.get("telegram"),
      set: (value) => store.cursors.set("telegram", value),
    },
    onRejected: ({ updateId, reason }) =>
      store.audit.append({ actor: "channel", event: "channel.rejected", data: { channel: "telegram", updateId, reason } }),
    now,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.pollTimeoutSeconds === undefined ? {} : { pollTimeoutSeconds: options.pollTimeoutSeconds }),
  });
  const executor = createExecutor({ store, channel });
  const dispatcher = createDispatcher({ store, executor, policy, now });
  const operator = createOperatorHandler({ store, dispatcher, timeZone: instance.config.timezone, now });
  const scheduler = createReminderScheduler({ store, dispatcher, now });

  return {
    store,
    channel,
    handle: (event) => operator.handle(event),
    tick: () => scheduler.tick(),
    close: () => store.close(),
  };
}
