import { z } from "zod";

const isValidTimezone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const telegramSchema = z
  .strictObject({
    operator_user_id: z.number().int().positive(),
    group_id: z.number().int(),
    bot_token: z.string().min(1),
  })
  .transform((t) => ({ operatorUserId: t.operator_user_id, groupId: t.group_id, botToken: t.bot_token }));

const clockTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM")
  .transform((t) => ({ hour: Number(t.slice(0, 2)), minute: Number(t.slice(3, 5)) }));

export const instanceConfigSchema = z.strictObject({
  timezone: z.string().refine(isValidTimezone, { message: "unknown timezone" }),
  channels: z
    .strictObject({
      telegram: telegramSchema.optional(),
    })
    .default({}),
  orchestrator: z
    .strictObject({
      api_key: z.string().min(1),
      model: z.string().regex(/^claude-[a-z0-9-]+$/).default("claude-sonnet-5-5"),
      effort: z.enum(["low", "medium", "high"]).default("medium"),
      daily_budget_usd: z.number().min(0).max(100).default(1),
      triage: z
        .strictObject({
          from: clockTime.default({ hour: 8, minute: 0 }),
          to: clockTime.default({ hour: 21, minute: 0 }),
          interval_minutes: z.number().int().min(10).max(720).default(60),
        })
        .default({ from: { hour: 8, minute: 0 }, to: { hour: 21, minute: 0 }, interval_minutes: 60 }),
    })
    .transform((o) => ({
      apiKey: o.api_key,
      model: o.model,
      effort: o.effort,
      dailyBudgetUsd: o.daily_budget_usd,
      triage: { from: o.triage.from, to: o.triage.to, intervalMinutes: o.triage.interval_minutes },
    }))
    .optional(),
  heartbeat: z
    .strictObject({
      push_url: z.string().min(1),
      interval_minutes: z.number().int().min(1).max(60).default(5),
    })
    .transform((h) => ({ pushUrl: h.push_url, intervalMinutes: h.interval_minutes }))
    .optional(),
  briefings: z
    .strictObject({
      morning: clockTime.optional(),
      evening: clockTime.optional(),
    })
    .default({}),
});

export type InstanceConfig = z.output<typeof instanceConfigSchema>;

export const secretsSchema = z.record(
  z.string(),
  z.strictObject({
    keychain: z.strictObject({ service: z.string().min(1), account: z.string().min(1) }),
  }),
);

export type SecretRefs = z.output<typeof secretsSchema>;

const githubRepoName = z.string().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/, "expected owner/name");

export const sourcesSchema = z
  .strictObject({
    server_health: z
      .strictObject({
        command: z.string().startsWith("/", "must be an absolute path"),
        args: z.array(z.string()).default(["run", "--dry"]),
        hosts: z.array(z.string().min(1)).min(1),
        interval_minutes: z.number().int().min(5).max(1440).default(15),
        timeout_seconds: z.number().int().min(10).max(1800).default(300),
      })
      .transform((s) => ({
        command: s.command,
        args: s.args,
        hosts: s.hosts,
        intervalMinutes: s.interval_minutes,
        timeoutSeconds: s.timeout_seconds,
      }))
      .optional(),
    github: z
      .strictObject({
        token: z.string().min(1),
        repos: z
          .array(
            z.union([
              githubRepoName.transform((name) => ({ name, level: "observe" as const })),
              z.strictObject({ name: githubRepoName, level: z.enum(["observe", "maintain"]).default("observe") }),
            ]),
          )
          .min(1),
        interval_minutes: z.number().int().min(5).max(1440).default(15),
      })
      .transform((g) => ({ token: g.token, repos: g.repos, intervalMinutes: g.interval_minutes }))
      .optional(),
    proton: z
      .strictObject({
        binary: z.string().startsWith("/", "must be an absolute path"),
        profile: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
        own_addresses: z.array(z.email()).min(1),
        todo_address: z.email().optional(),
        calendar_interval_minutes: z.number().int().min(10).max(1440).default(30),
        mail_interval_minutes: z.number().int().min(10).max(1440).default(15),
      })
      .transform((p) => ({
        binary: p.binary,
        profile: p.profile,
        ownAddresses: p.own_addresses,
        ...(p.todo_address === undefined ? {} : { todoAddress: p.todo_address }),
        calendarIntervalMinutes: p.calendar_interval_minutes,
        mailIntervalMinutes: p.mail_interval_minutes,
      }))
      .optional(),
    plausible: z
      .strictObject({
        url: z.url({ protocol: /^https$/ }),
        api_key: z.string().min(1),
        sites: z.array(z.string().regex(/^[a-z0-9.-]{1,253}$/i)).min(1),
      })
      .transform((p) => ({ url: p.url, apiKey: p.api_key, sites: p.sites }))
      .optional(),
    knowledge: z
      .strictObject({
        adapter: z.string().startsWith("/", "must be an absolute path"),
        root: z.string().startsWith("/", "must be an absolute path"),
        scope: z.string().regex(/^[a-z0-9_-]{1,32}$/),
      })
      .optional(),
    icloud: z
      .strictObject({
        username: z.email(),
        password: z.string().min(1),
        calendars: z.array(z.string().min(1)).default([]),
        birthdays: z.boolean().default(true),
        interval_minutes: z.number().int().min(10).max(1440).default(30),
      })
      .transform((i) => ({
        username: i.username,
        password: i.password,
        calendars: i.calendars,
        birthdays: i.birthdays,
        intervalMinutes: i.interval_minutes,
      }))
      .optional(),
  })
  .transform((s) => ({
    ...(s.plausible === undefined ? {} : { plausible: s.plausible }),
    ...(s.knowledge === undefined ? {} : { knowledge: s.knowledge }),
    ...(s.icloud === undefined ? {} : { icloud: s.icloud }),
    ...(s.proton === undefined ? {} : { proton: s.proton }),
    ...(s.server_health === undefined ? {} : { serverHealth: s.server_health }),
    ...(s.github === undefined ? {} : { github: s.github }),
  }));

export type Sources = z.output<typeof sourcesSchema>;
