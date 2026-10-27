import { MAX_BUTTON_DATA_BYTES } from "@dsptchr/channels";
import { z } from "zod";

const buttonSchema = z.strictObject({
  label: z.string().min(1).max(64),
  data: z
    .string()
    .min(1)
    .refine((d) => Buffer.byteLength(d, "utf8") <= MAX_BUTTON_DATA_BYTES, `at most ${MAX_BUTTON_DATA_BYTES} bytes`),
});

export const messageSendSchema = z.strictObject({
  text: z.string().min(1).max(4096),
  conversation: z.string().min(1).optional(),
  buttons: z.array(z.array(buttonSchema).min(1).max(8)).max(8).optional(),
});

export const messageAckSchema = z.strictObject({
  conversation: z.string().min(1),
  messageRef: z.string().min(1).max(64),
  callbackRef: z.string().min(1).max(128),
  note: z.string().min(1).max(200),
});

export const todoCreateSchema = z.strictObject({
  text: z.string().trim().min(1).max(1000),
  dueAt: z.number().int().positive().optional(),
});

export const todoUpdateSchema = z
  .strictObject({
    todoId: z.string().min(1).max(64),
    event: z.enum(["complete", "snooze", "drop", "wake"]),
    dueAt: z.number().int().positive().optional(),
  })
  .refine((u) => u.event !== "snooze" || u.dueAt !== undefined, { message: "snooze needs dueAt", path: ["dueAt"] });

export const knowledgeWriteSchema = z.strictObject({
  path: z.string().min(1).max(200),
  content: z.string().min(1).max(20_000),
  expected: z.string().min(1).max(64),
  append: z.boolean(),
});

export type KnowledgeWrite = z.infer<typeof knowledgeWriteSchema>;
export type MessageSend = z.infer<typeof messageSendSchema>;
export type MessageAck = z.infer<typeof messageAckSchema>;
export type TodoCreate = z.infer<typeof todoCreateSchema>;
export type TodoUpdate = z.infer<typeof todoUpdateSchema>;
