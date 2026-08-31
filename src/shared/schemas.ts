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

export const workspaceDirSchema = z.string().min(1);

/**
 * Caps a recorded mic clip's decoded size at 25MB -- generous for a short
 * voice note (issue #245) while bounding the base64 payload's memory/IPC
 * cost. No other upload-size precedent exists in this codebase to match.
 */
const MAX_RECORDING_BYTES = 25 * 1024 * 1024;

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export const saveRecordingSchema = z.object({
  base64Audio: z
    .string()
    .min(1, "Recording data is required")
    .refine(
      (value) => value.length % 4 === 0 && BASE64_PATTERN.test(value),
      "Recording data is not valid base64",
    )
    .refine((value) => {
      const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
      const decodedBytes = (value.length * 3) / 4 - padding;
      return decodedBytes <= MAX_RECORDING_BYTES;
    }, `Recording exceeds the ${MAX_RECORDING_BYTES / (1024 * 1024)}MB limit`),
  mimeType: z.string().startsWith("audio/", "mimeType must be an audio type"),
});
