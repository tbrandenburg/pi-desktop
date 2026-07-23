import { z } from "zod";

export const providerSettingsSchema = z.object({
  apiKey: z.string().min(1).optional(),
  baseUrl: z.string().url("Base URL must be a valid URL"),
  model: z.string().min(1, "Model ID is required"),
});

export const startChatRequestSchema = z.object({
  conversationId: z.string().min(1),
  model: z.string().min(1),
  messages: z.array(
    z.object({
      role: z.enum(["user", "assistant", "system"]),
      content: z.string(),
    }),
  ),
});

export const sessionRecordSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  model: z.string(),
  updatedAt: z.number(),
  messages: z.array(
    z.object({
      role: z.enum(["user", "assistant", "system"]),
      content: z.string(),
    }),
  ),
});
