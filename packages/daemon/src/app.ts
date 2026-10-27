import { readFile } from "node:fs/promises";
import { telegramChannel, type Channel } from "@dsptchr/channels";
import { createExecutor } from "@dsptchr/executor";
import { parsePolicy } from "@dsptchr/gate";
import { openStore, type Store } from "@dsptchr/store";
import { createBriefings } from "./briefings.ts";
import { createDispatcher } from "./dispatch.ts";
import { runServerHealth } from "@dsptchr/watchers";
import { createHealthMonitor } from "./health.ts";
import { createHeartbeat } from "./heartbeat.ts";
import { createInbox, type Inbox } from "./inbox.ts";
import { InstanceError, type Instance } from "./instance/loader.ts";
import { createOperatorHandler } from "./operator.ts";
import { createReminderScheduler } from "./reminders.ts";

export interface AppOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  pollTimeoutSeconds?: number;
  onHeartbeatError?: (error: string) => void;
  onWatcherError?: (error: string) => void;
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
  const heartbeatConfig = instance.config.heartbeat;
  const heartbeat =
    heartbeatConfig === undefined
      ? undefined
      : createHeartbeat({
          url: await instance.secret(heartbeatConfig.pushUrl),
          intervalMs: heartbeatConfig.intervalMinutes * 60_000,
          now,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        });

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
  const briefings = createBriefings({
    store,
    dispatcher,
    timeZone: instance.config.timezone,
    times: instance.config.briefings,
    now,
  });
  const healthConfig = instance.sources.serverHealth;
  const health =
    healthConfig === undefined
      ? undefined
      : createHealthMonitor({
          store,
          dispatcher,
          check: () =>
            runServerHealth({
              command: healthConfig.command,
              args: healthConfig.args,
              hosts: healthConfig.hosts,
              timeoutMs: healthConfig.timeoutSeconds * 1000,
            }),
          intervalMs: healthConfig.intervalMinutes * 60_000,
          now,
          timeZone: instance.config.timezone,
        });
  // The check may take minutes (SSH to every host); it runs beside the scheduler, never twice at once.
  let healthRun: Promise<unknown> | undefined;
  const startHealth = (): void => {
    if (health === undefined || healthRun !== undefined) return;
    healthRun = health
      .tick()
      .catch((error: unknown) => options.onWatcherError?.(error instanceof Error ? error.name : "unknown error"))
      .finally(() => {
        healthRun = undefined;
      });
  };

  const inbox = createInbox({
    store,
    handle: (event) => operator.handle(event),
    now,
    onDead: async (entryId) => {
      const action = await dispatcher.dispatch({
        type: "message.send",
        payload: { text: `A message could not be processed and was set aside. Audit log subject: ${entryId}` },
        // One attempt per hour: a denial (e.g. rate limit) is final for its key.
        idempotencyKey: `inbox:${entryId}:dead:${Math.floor(now() / 3_600_000)}`,
        actor: "daemon",
      });
      return action.state === "executed";
    },
  });

  return {
    store,
    channel,
    inbox,
    tick: async () => {
      store.inbox.purgeDone(now() - INBOX_RETENTION_MS);
      startHealth();
      const sent = (await scheduler.tick()) + (await briefings.tick());
      // Only a completed tick counts as alive; a throwing tick skips the beat.
      const beat = await heartbeat?.beat(store.flags.isPaused() ? "paused" : "ok");
      if (beat !== undefined && !beat.sent && beat.error !== undefined) {
        options.onHeartbeatError?.(beat.error);
      }
      return sent;
    },
    close: () => store.close(),
  };
}
