import { MAX_BUTTON_DATA_BYTES } from "@dsptchr/channels";
import { MAX_SHOPPING_NAME, MAX_SHOPPING_QUANTITY, SHOPPING_KINDS } from "@dsptchr/core";
import { z } from "zod";

const buttonSchema = z.strictObject({
  label: z.string().min(1).max(64),
  data: z
    .string()
    .min(1)
    .refine((d) => Buffer.byteLength(d, "utf8") <= MAX_BUTTON_DATA_BYTES, `at most ${MAX_BUTTON_DATA_BYTES} bytes`),
});

const buttonsSchema = z.array(z.array(buttonSchema).min(1).max(8)).max(8);

export const messageSendSchema = z.strictObject({
  text: z.string().min(1).max(4096),
  conversation: z.string().min(1).optional(),
  buttons: buttonsSchema.optional(),
});

export const messageAckSchema = z.strictObject({
  conversation: z.string().min(1),
  messageRef: z.string().min(1).max(64),
  callbackRef: z.string().min(1).max(128),
  note: z.string().min(1).max(200),
  // Replaces the message's text and buttons instead of only removing the buttons.
  replacement: z.strictObject({ text: z.string().min(1).max(4096), buttons: buttonsSchema.optional() }).optional(),
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

export const shoppingAddSchema = z.strictObject({
  name: z.string().trim().min(1).max(MAX_SHOPPING_NAME),
  quantity: z.string().trim().min(1).max(MAX_SHOPPING_QUANTITY).optional(),
  kind: z.enum(SHOPPING_KINDS).optional(),
});

export const shoppingUpdateSchema = z.union([
  z.strictObject({
    itemId: z.string().min(1).max(64),
    event: z.enum(["check", "uncheck", "need", "stock", "remove"]),
  }),
  // Rename or change the quantity; null clears it.
  z
    .strictObject({
      itemId: z.string().min(1).max(64),
      event: z.literal("edit"),
      name: z.string().trim().min(1).max(MAX_SHOPPING_NAME).optional(),
      quantity: z.string().trim().min(1).max(MAX_SHOPPING_QUANTITY).nullable().optional(),
    })
    .refine((e) => e.name !== undefined || e.quantity !== undefined, { message: "edit needs name or quantity" }),
]);

export const shoppingFinishSchema = z.strictObject({});

export type KnowledgeWrite = z.infer<typeof knowledgeWriteSchema>;
export type MessageSend = z.infer<typeof messageSendSchema>;
export type MessageAck = z.infer<typeof messageAckSchema>;
export type TodoCreate = z.infer<typeof todoCreateSchema>;
export type TodoUpdate = z.infer<typeof todoUpdateSchema>;
export type ShoppingAdd = z.infer<typeof shoppingAddSchema>;
export type ShoppingUpdate = z.infer<typeof shoppingUpdateSchema>;
