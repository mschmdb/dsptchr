import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const AUTONOMY_LEVELS = ["auto", "ask", "never"] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

const actionPolicySchema = z
  .strictObject({
    level: z.enum(AUTONOMY_LEVELS),
    rate_limit: z
      .strictObject({ max: z.number().int().positive(), per_minutes: z.number().int().positive() })
      .optional(),
  })
  .transform((p) => ({
    level: p.level,
    ...(p.rate_limit === undefined ? {} : { rateLimit: { max: p.rate_limit.max, perMinutes: p.rate_limit.per_minutes } }),
  }));

const policySchema = z.strictObject({
  actions: z.record(z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/), actionPolicySchema),
});

export type Policy = z.output<typeof policySchema>;
export type ActionPolicy = z.output<typeof actionPolicySchema>;

export class PolicyError extends Error {
  override name = "PolicyError";
}

export function parsePolicy(text: string): Policy {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new PolicyError(`policy: invalid YAML (${(error as Error).message})`);
  }
  const result = policySchema.safeParse(raw);
  if (!result.success) {
    throw new PolicyError(`policy: ${result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  }
  return result.data;
}
