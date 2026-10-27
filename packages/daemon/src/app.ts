import { readFile } from "node:fs/promises";
import { telegramChannel, type Channel } from "@dsptchr/channels";
import { createExecutor } from "@dsptchr/executor";
import { parsePolicy } from "@dsptchr/gate";
import { openStore, type Store } from "@dsptchr/store";
import { createDispatcher } from "./dispatch.ts";
import { createInbox, type Inbox } from "./inbox.ts";
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
  inbox: Inbox;
  tick(): Promise<number>;
  close(): void;
}

// Handled operator input stays in the inbox this long, then only its ID remains.
const INBOX_RETENTION_MS = 7 * 86_400_000;

// Wires one instance. Refuses to start without a policy: no policy, no actions.
export async function createApp(instance: Instance, options: AppOptions = {}): Promise<App> {
  const now = options.now ?? Date.now;
  const policyText = await readFile(instance.paths.policy, "utf8").catch(() => {
    throw new InstanceError(`policy.yaml missing in ${instance.dir}`);
  });
  const policy = parsePolicy(policyText);
  const askTypes = Object.entries(policy.actions)
    .filter(([, p]) => p.level === "ask")
    .map(([type]) => type);
  if (askTypes.length > 0) {
    // Operator approvals arrive in Phase 2; until then an ask action would wait forever.
    throw new InstanceError(`policy.yaml: level "ask" is not supported yet (${askTypes.join(", ")})`);
  }
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
  const inbox = createInbox({
    store,
    handle: (event) => operator.handle(event),
    now,
    onDead: async (entryId) => {
      await dispatcher.dispatch({
        type: "message.send",
        payload: { text: `A message could not be processed and was set aside. Audit log subject: ${entryId}` },
        idempotencyKey: `inbox:${entryId}:dead`,
        actor: "daemon",
      });
    },
  });

  return {
    store,
    channel,
    inbox,
    tick: async () => {
      store.inbox.purgeDone(now() - INBOX_RETENTION_MS);
      return scheduler.tick();
    },
    close: () => store.close(),
  };
}
