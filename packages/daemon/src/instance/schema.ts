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
