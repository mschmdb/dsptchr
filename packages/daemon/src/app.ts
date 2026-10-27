import { readFile } from "node:fs/promises";
import { loadKnowledgeAdapter } from "@dsptchr/knowledge";
import { homedir } from "node:os";
import { join } from "node:path";
import { costUsd, readMail, type CreateMessage } from "@dsptchr/agents";
import { addDays, wallClockOf, wallClockToUtc } from "@dsptchr/core";
import type { CalendarEvent } from "@dsptchr/watchers";
import { telegramChannel, type Channel } from "@dsptchr/channels";
import { createExecutor } from "@dsptchr/executor";
import { parsePolicy } from "@dsptchr/gate";
import { openStore, type Store } from "@dsptchr/store";
import { createBriefings } from "./briefings.ts";
import { createDispatcher } from "./dispatch.ts";
import { createICloudSource, createPlausibleSource, createProtonSource, fetchGithubLogin, fetchRepoSnapshot, runProton, runServerHealth } from "@dsptchr/watchers";
import { guarded } from "./alerts.ts";
import { ANALYTICS_SOURCE, createAnalyticsMonitor } from "./analytics.ts";
import { createBackupJob } from "./backups.ts";
import { BIRTHDAY_SOURCE, createBirthdayMonitor } from "./birthdays.ts";
import { CALENDAR_SOURCE, createCalendarMonitor } from "./calendar.ts";
import { createMailMonitor, MAIL_SOURCE } from "./mail.ts";
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
// Reader role: tool-less classification of untrusted mail (AR-2).
const READER_MODEL = "claude-haiku-5-5";
// Calendar window kept in the store for briefings and searches.
const CALENDAR_PAST_DAYS = 90;
const CALENDAR_FUTURE_DAYS = 60;
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
  const knowledgeConfig = instance.sources.knowledge;
  const knowledge =
    knowledgeConfig === undefined
      ? undefined
      : await loadKnowledgeAdapter(knowledgeConfig.adapter, { root: knowledgeConfig.root, scope: knowledgeConfig.scope });
  const executor = createExecutor({ store, channel, ...(knowledge === undefined ? {} : { knowledge }) });
  const dispatcher = createDispatcher({ store, executor, policy, now });
  const protonConfig = instance.sources.proton;
  const proton =
    protonConfig === undefined
      ? undefined
      : createProtonSource({
          call: (command) =>
            runProton(command, { binary: protonConfig.binary, profile: protonConfig.profile, home: homedir() }),
        });
  const icloudConfig = instance.sources.icloud;
  const icloud =
    icloudConfig === undefined
      ? undefined
      : createICloudSource({
          username: icloudConfig.username,
          password: await instance.secret(icloudConfig.password),
          timeZone: instance.config.timezone,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        });

  // Proton and iCloud events merge into one calendar view.
  const dayStart = (date: string, offset: number): number => {
    const [year = 0, month = 0, day = 0] = date.split("-").map(Number);
    return wallClockToUtc(addDays({ year, month, day, hour: 0, minute: 0 }, offset), instance.config.timezone);
  };
  const calendarSources: ((range: { after: string; before: string }) => Promise<CalendarEvent[]>)[] = [
    ...(proton === undefined ? [] : [(range: { after: string; before: string }) => proton.events(range)]),
    ...(icloud === undefined || icloudConfig === undefined || icloudConfig.calendars.length === 0
      ? []
      : [
          (range: { after: string; before: string }) =>
            icloud.events(icloudConfig.calendars, { start: dayStart(range.after, 0), end: dayStart(range.before, 1) }),
        ]),
  ];
  const calendar =
    calendarSources.length === 0
      ? undefined
      : createCalendarMonitor({
          store,
          fetchEvents: async (range) => (await Promise.all(calendarSources.map((fetchEvents) => fetchEvents(range)))).flat(),
          ownAddresses: [...(protonConfig?.ownAddresses ?? []), ...(icloudConfig === undefined ? [] : [icloudConfig.username])],
          intervalMs: Math.min(protonConfig?.calendarIntervalMinutes ?? 1440, icloudConfig?.intervalMinutes ?? 1440) * 60_000,
          now,
          timeZone: instance.config.timezone,
          pastDays: CALENDAR_PAST_DAYS,
          futureDays: CALENDAR_FUTURE_DAYS,
        });
  const birthdays =
    icloud === undefined || icloudConfig?.birthdays !== true
      ? undefined
      : createBirthdayMonitor({
          store,
          fetchBirthdays: () => icloud.birthdays(),
          intervalMs: 12 * 3_600_000,
          now,
          timeZone: instance.config.timezone,
        });

  const plausibleConfig = instance.sources.plausible;
  const analytics =
    plausibleConfig === undefined
      ? undefined
      : await (async () => {
          const plausible = createPlausibleSource({
            baseUrl: plausibleConfig.url,
            apiKey: await instance.secret(plausibleConfig.apiKey),
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          });
          return createAnalyticsMonitor({
            store,
            sites: plausibleConfig.sites,
            fetchStats: (site, today) => plausible.siteStats(site, today),
            now,
            timeZone: instance.config.timezone,
          });
        })();

  const orchestratorConfig = instance.config.orchestrator;
  const createMessage =
    orchestratorConfig === undefined
      ? undefined
      : (options.createMessage ?? anthropicCreateMessage((await instance.secret(orchestratorConfig.apiKey)).reveal()));
  const startOfToday = (): number =>
    wallClockToUtc({ ...wallClockOf(now(), instance.config.timezone), hour: 0, minute: 0 }, instance.config.timezone);
  const withinModelBudget = (): boolean =>
    orchestratorConfig !== undefined && store.runs.costSince(startOfToday()) < orchestratorConfig.dailyBudgetUsd;

  const mail =
    protonConfig === undefined || proton === undefined
      ? undefined
      : createMailMonitor({
          store,
          dispatcher,
          listMail: (window) => proton.newMail(window),
          readMail: (id) => proton.readMail(id),
          classify: async (message) => {
            if (createMessage === undefined) throw new Error("no model configured");
            const { reading, usage } = await readMail({
              createMessage,
              model: READER_MODEL,
              mail: {
                fromAddress: message.fromAddress,
                subject: message.subject,
                body: message.body,
                receivedAt: new Date(message.time).toISOString(),
              },
            });
            store.runs.record({
              role: "reader",
              model: READER_MODEL,
              inputTokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
              outputTokens: usage.outputTokens,
              costUsd: costUsd(READER_MODEL, usage),
              outcome: reading.category,
            });
            return reading;
          },
          mayClassify: withinModelBudget,
          ownAddresses: protonConfig.ownAddresses,
          ...(protonConfig.todoAddress === undefined ? {} : { todoAddress: protonConfig.todoAddress }),
          intervalMs: protonConfig.mailIntervalMinutes * 60_000,
          now,
          timeZone: instance.config.timezone,
        });

  const orchestrator =
    orchestratorConfig === undefined || createMessage === undefined
      ? undefined
      : createOrchestrator({
          store,
          dispatcher,
          timeZone: instance.config.timezone,
          now,
          createMessage,
          model: orchestratorConfig.model,
          effort: orchestratorConfig.effort,
          dailyBudgetUsd: orchestratorConfig.dailyBudgetUsd,
          role: instance.role,
          ...(calendar === undefined ? {} : { calendar }),
          ...(birthdays === undefined ? {} : { birthdays }),
          ...(knowledge === undefined ? {} : { knowledge }),
          ...(analytics === undefined ? {} : { analytics }),
          ...(mail === undefined ? {} : { mail, isMailTodo: (id: string) => mail.isMailTodo(id) }),
        });
  const operator = createOperatorHandler({
    store,
    dispatcher,
    timeZone: instance.config.timezone,
    now,
    ...(orchestrator === undefined ? {} : { orchestrator }),
    sources: {
      ...(calendar === undefined ? {} : { calendar }),
      ...(mail === undefined ? {} : { mail }),
      ...(birthdays === undefined ? {} : { birthdays }),
    },
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
        ...(calendar?.today() ?? []),
        ...(birthdays?.briefing() ?? []),
        ...(mail?.briefing() ?? []),
        ...(findings === 0 ? [] : [`Server health: ${findings} open ${findings === 1 ? "finding" : "findings"} (/health).`]),
        ...(github?.summary() ?? []),
        ...(analytics?.briefing() ?? []),
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

  const timeZone = instance.config.timezone;
  const alerting = (source: string, label: string) => ({ store, dispatcher, source, label, now, timeZone, threshold: 3 });
  const calendarWatcher = calendar === undefined ? undefined : guarded(calendar, alerting(`${CALENDAR_SOURCE}:watcher`, "Calendar watcher"));
  const mailWatcher = mail === undefined ? undefined : guarded(mail, alerting(`${MAIL_SOURCE}:watcher`, "Mail watcher"));
  const birthdayWatcher =
    birthdays === undefined ? undefined : guarded(birthdays, alerting(`${BIRTHDAY_SOURCE}:watcher`, "Birthday watcher"));
  const analyticsWatcher =
    analytics === undefined ? undefined : guarded(analytics, alerting(`${ANALYTICS_SOURCE}:watcher`, "Plausible watcher"));
  const backups = createBackupJob({ store, dir: join(instance.dir, "backups"), keep: 14, now, timeZone });

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
      startWatcher(CALENDAR_SOURCE, calendarWatcher);
      startWatcher(BIRTHDAY_SOURCE, birthdayWatcher);
      startWatcher("backups", backups);
      startWatcher(ANALYTICS_SOURCE, analyticsWatcher);
      startWatcher(MAIL_SOURCE, mailWatcher);
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
