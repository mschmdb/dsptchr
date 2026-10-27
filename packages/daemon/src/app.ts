import { readFile } from "node:fs/promises";
import type { CreateMessage } from "@dsptchr/agents";
import { telegramChannel, type Channel } from "@dsptchr/channels";
import { createExecutor } from "@dsptchr/executor";
import { parsePolicy } from "@dsptchr/gate";
import { openStore, type Store } from "@dsptchr/store";
import { createBriefings } from "./briefings.ts";
import { createDispatcher } from "./dispatch.ts";
import { fetchGithubLogin, fetchRepoSnapshot, runServerHealth } from "@dsptchr/watchers";
import { createGithubMonitor, GITHUB_SOURCE } from "./github.ts";
import { createHealthMonitor, HEALTH_SOURCE } from "./health.ts";
import { createHeartbeat } from "./heartbeat.ts";
import { createInbox, type Inbox } from "./inbox.ts";
import { anthropicCreateMessage, createOrchestrator } from "./orchestrator.ts";
import { InstanceError, type Instance } from "./instance/loader.ts";
import { createOperatorHandler } from "./operator.ts";
import { createReminderScheduler } from "./reminders.ts";

export interface AppOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  pollTimeoutSeconds?: number;
  onHeartbeatError?: (error: string) => void;
  onWatcherError?: (error: string) => void;
  // Test seam; production builds the client from the keychain API key.
  createMessage?: CreateMessage;
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
// Chat memory the orchestrator sees is 6 h; a day is kept for debugging, then deleted.
const CONVERSATION_RETENTION_MS = 86_400_000;

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
  const orchestratorConfig = instance.config.orchestrator;
  const orchestrator =
    orchestratorConfig === undefined
      ? undefined
      : createOrchestrator({
          store,
          dispatcher,
          timeZone: instance.config.timezone,
          now,
          createMessage:
            options.createMessage ?? anthropicCreateMessage((await instance.secret(orchestratorConfig.apiKey)).reveal()),
          model: orchestratorConfig.model,
          effort: orchestratorConfig.effort,
          dailyBudgetUsd: orchestratorConfig.dailyBudgetUsd,
          role: instance.role,
        });
  const operator = createOperatorHandler({
    store,
    dispatcher,
    timeZone: instance.config.timezone,
    now,
    ...(orchestrator === undefined ? {} : { orchestrator }),
  });
  const scheduler = createReminderScheduler({ store, dispatcher, now });
  const briefings = createBriefings({
    store,
    dispatcher,
    timeZone: instance.config.timezone,
    times: instance.config.briefings,
    now,
    extras: () => {
      const findings = store.observations.listOpen(HEALTH_SOURCE).length;
      return [
        ...(findings === 0 ? [] : [`Server health: ${findings} open ${findings === 1 ? "finding" : "findings"} (/health).`]),
        ...(github?.summary() ?? []),
      ];
    },
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
  const githubConfig = instance.sources.github;
  const github =
    githubConfig === undefined
      ? undefined
      : await (async () => {
          const token = await instance.secret(githubConfig.token);
          const fetchOptions = options.fetch === undefined ? {} : { fetch: options.fetch };
          let self: string | undefined;
          return createGithubMonitor({
            store,
            dispatcher,
            repos: githubConfig.repos.map((r) => r.name),
            fetchRepo: async (repo) => {
              self ??= await fetchGithubLogin({ token, ...fetchOptions });
              return fetchRepoSnapshot(repo, { token, self, ...fetchOptions });
            },
            intervalMs: githubConfig.intervalMinutes * 60_000,
            now,
            timeZone: instance.config.timezone,
          });
        })();

  // Watchers may take minutes (SSH, many API calls); each runs beside the scheduler, never twice at once.
  const running = new Map<string, Promise<unknown>>();
  const startWatcher = (name: string, watcher: { tick(): Promise<boolean> } | undefined): void => {
    if (watcher === undefined || running.has(name)) return;
    running.set(
      name,
      watcher
        .tick()
        .catch((error: unknown) => options.onWatcherError?.(`${name}: ${error instanceof Error ? error.name : "unknown error"}`))
        .finally(() => running.delete(name)),
    );
  };

  const inbox = createInbox({
    store,
    // Several model round trips fit; the Anthropic client times out each one after 45 s.
    handlerTimeoutMs: orchestrator === undefined ? 60_000 : 180_000,
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
      store.conversation.purgeBefore(now() - CONVERSATION_RETENTION_MS);
      store.orchestratorEvents.purgeBefore(now() - CONVERSATION_RETENTION_MS);
      startWatcher(HEALTH_SOURCE, health);
      startWatcher(GITHUB_SOURCE, github);
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
