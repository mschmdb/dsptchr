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

export const sourcesSchema = z
  .strictObject({
    server_health: z
      .strictObject({
        command: z.string().startsWith("/", "must be an absolute path"),
        args: z.array(z.string()).default(["run", "--dry"]),
        interval_minutes: z.number().int().min(5).max(1440).default(15),
        timeout_seconds: z.number().int().min(10).max(1800).default(300),
      })
      .transform((s) => ({
        command: s.command,
        args: s.args,
        intervalMinutes: s.interval_minutes,
        timeoutSeconds: s.timeout_seconds,
      }))
      .optional(),
  })
  .transform((s) => (s.server_health === undefined ? {} : { serverHealth: s.server_health }));

export type Sources = z.output<typeof sourcesSchema>;
