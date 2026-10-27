import { z } from "zod";

const userSchema = z.object({ id: z.number() });
const chatSchema = z.object({ id: z.number() });

export const updateSchema = z.object({
  update_id: z.number().int(),
  message: z
    .object({
      message_id: z.number(),
      from: userSchema.optional(),
      chat: chatSchema,
      text: z.string().optional(),
      message_thread_id: z.number().optional(),
    })
    .optional(),
  callback_query: z
    .object({
      id: z.string(),
      from: userSchema,
      data: z.string().optional(),
      message: z
        .object({ message_id: z.number(), chat: chatSchema, message_thread_id: z.number().optional() })
        .optional(),
    })
    .optional(),
});

export type Update = z.infer<typeof updateSchema>;

export const sentMessageSchema = z.object({
  message_id: z.number(),
});

export const apiResponseSchema = z.union([
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({
    ok: z.literal(false),
    error_code: z.number().optional(),
    description: z.string().optional(),
    parameters: z.object({ retry_after: z.number().optional() }).optional(),
  }),
]);
