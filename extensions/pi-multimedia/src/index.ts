/**
 * pi-multimedia — first-party pi extension, bundled with pi-desktop,
 * registering `understand_audio` and `understand_video` tools.
 *
 * pi-ai's Message schema (as of @earendil-works/pi-ai@0.84.1) has no
 * AudioContent/VideoContent block type, so audio/video understanding can't
 * be expressed as ordinary LLM message content. These tools instead make a
 * raw HTTP call to an audio/vision-capable chat completions API directly
 * from tool `execute()` and return the answer as a plain `TextContent`
 * block, which fits the existing `AgentToolResult<TDetails>` contract
 * unchanged. See README.md and issue #234 for the full design rationale.
 */
import { Type } from "typebox";
import {
  detectAudioFormat,
  transcribeAudioViaApi,
  understandAudioViaApi,
  type AudioToolResult,
  type TranscribeFetchFn,
} from "./audio.js";
import { readFileAsBase64 } from "./fs-io.js";
import { understandVideo, understandVideoViaApi, type VideoToolResult } from "./video.js";

// Minimal ambient declaration: the shared extension tsconfig deliberately has
// no Node type definitions, and this package must not add dependencies.
declare const process: { env: Record<string, string | undefined> };
declare function fetch(url: string, init?: unknown): Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
}>;

export const AUDIO_API_KEY_ENV = "MULTIMEDIA_AUDIO_API_KEY";
export const AUDIO_BASE_URL_ENV = "MULTIMEDIA_AUDIO_BASE_URL";
/** Overrides `AUDIO_MODEL` (understand mode, default `gpt-audio-1.5`). */
export const AUDIO_MODEL_ENV = "MULTIMEDIA_AUDIO_MODEL";
/** Overrides `TRANSCRIBE_MODEL` (transcribe mode, default `gpt-transcribe`). */
export const TRANSCRIBE_MODEL_ENV = "MULTIMEDIA_TRANSCRIBE_MODEL";
export const VIDEO_API_KEY_ENV = "MULTIMEDIA_VIDEO_API_KEY";
export const VIDEO_BASE_URL_ENV = "MULTIMEDIA_VIDEO_BASE_URL";
/** Overrides `VIDEO_MODEL` (default `gpt-4o`). */
export const VIDEO_MODEL_ENV = "MULTIMEDIA_VIDEO_MODEL";

const UnderstandAudioParams = Type.Object({
  path: Type.String({ description: "Absolute or workspace-relative path to a local audio file (wav/mp3/m4a)." }),
  mode: Type.Optional(
    Type.Union([Type.Literal("transcribe"), Type.Literal("understand")], {
      description:
        "'transcribe' (default): cheap speech-to-text via the dedicated gpt-transcribe endpoint — use this for " +
        "'what is said in this file?'. 'understand': reasoning about tone/background/non-speech sound via the " +
        "audio-capable chat model — requires `prompt`; use only when transcription alone isn't enough.",
    }),
  ),
  prompt: Type.Optional(
    Type.String({
      description: "Required when mode is 'understand'. What to ask about the audio (e.g. describe tone/background/music).",
    }),
  ),
});

const UnderstandVideoParams = Type.Object({
  path: Type.String({ description: "Absolute or workspace-relative path to a local video file (e.g. mp4)." }),
  prompt: Type.Optional(
    Type.String({ description: "What to ask about the video. Defaults to a describe prompt." }),
  ),
  frameCount: Type.Optional(
    Type.Integer({ description: "How many evenly-spaced frames to extract via ffmpeg. Defaults to 3.", minimum: 1 }),
  ),
});

const DEFAULT_PROMPT = "Transcribe and describe this audio.";
const DEFAULT_VIDEO_PROMPT = "Describe what happens in this video.";
const DEFAULT_FRAME_COUNT = 3;

interface MinimalToolDefinition<TParameters = unknown, TParams = unknown, TResult extends { content: unknown } = { content: unknown }> {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: TParameters;
  execute: (
    toolCallId: string,
    params: TParams,
  ) => Promise<{ content: TResult["content"]; details: unknown; isError?: boolean }>;
}

interface MinimalExtensionApi {
  registerCommand(
    name: string,
    command: { description: string; handler: (args: string, ctx: unknown) => void | Promise<void> },
  ): void;
  registerTool(tool: MinimalToolDefinition<unknown, never, { content: unknown }>): void;
}

/** Builds the `understand_audio` tool definition, given a real or injected fetch. */
export function buildUnderstandAudioTool(
  env: Record<string, string | undefined>,
  fetchFn: typeof fetch = fetch,
): MinimalToolDefinition<typeof UnderstandAudioParams, { path: string; mode?: "transcribe" | "understand"; prompt?: string }, AudioToolResult> {
  return {
    name: "understand_audio",
    label: "Understand Audio",
    description:
      "Transcribes or understands the contents of a local audio file (wav/mp3/m4a). Default mode ('transcribe') " +
      "returns cheap speech-to-text via the dedicated gpt-transcribe endpoint. Opt-in mode ('understand', requires " +
      "`prompt`) sends the audio to a reasoning-capable audio model for questions beyond words, e.g. tone or " +
      "background sound. Bypasses ordinary chat message content, which has no native audio block type.",
    promptSnippet:
      "Call `understand_audio` whenever the user references a local audio file path (wav/mp3/m4a) and wants to " +
      "know what is said in it, or wants it summarized/transcribed.",
    promptGuidelines: [
      "Use the default `mode: 'transcribe'` for 'what does this say' / 'transcribe this' requests — it is the " +
        "cheap, speech-oriented path.",
      "Only use `mode: 'understand'` (and supply a `prompt`) when the user asks about qualities beyond words, " +
        "e.g. tone, emotion, background noise, or music description — it is a more expensive reasoning call.",
      "If the audio is music or otherwise non-speech, `transcribe` mode may return an empty/near-empty result; " +
        "that is expected, not an error — switch to `understand` mode if a description is actually wanted.",
    ],
    parameters: UnderstandAudioParams,
    execute: async (_toolCallId, params) => {
      const mode = params.mode ?? "transcribe";

      let format: ReturnType<typeof detectAudioFormat>;
      try {
        format = detectAudioFormat(params.path);
      } catch (error) {
        return {
          details: undefined,
          isError: true,
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        };
      }

      let base64Audio: string;
      try {
        base64Audio = readFileAsBase64(params.path);
      } catch (error) {
        return {
          details: undefined,
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to read audio file at "${params.path}": ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }

      if (mode === "understand") {
        const prompt = params.prompt?.trim() || DEFAULT_PROMPT;
        const result = await understandAudioViaApi(base64Audio, format, prompt, {
          apiKey: env[AUDIO_API_KEY_ENV] ?? "",
          baseUrl: env[AUDIO_BASE_URL_ENV],
          model: env[AUDIO_MODEL_ENV],
          fetchFn: fetchFn as never,
        });
        return { ...result, details: undefined };
      }

      const result = await transcribeAudioViaApi(base64Audio, format, {
        apiKey: env[AUDIO_API_KEY_ENV] ?? "",
        baseUrl: env[AUDIO_BASE_URL_ENV],
        model: env[TRANSCRIBE_MODEL_ENV],
        fetchFn: fetchFn as unknown as TranscribeFetchFn,
      });
      return { ...result, details: undefined };
    },
  };
}

/** Builds the `understand_video` tool definition, given a real or injected fetch. */
export function buildUnderstandVideoTool(
  env: Record<string, string | undefined>,
  fetchFn: typeof fetch = fetch,
): MinimalToolDefinition<typeof UnderstandVideoParams, { path: string; prompt?: string; frameCount?: number }, VideoToolResult> {
  return {
    name: "understand_video",
    label: "Understand Video",
    description:
      "Understands the contents of a local video file by extracting evenly-spaced frames with ffmpeg and " +
      "sending them as images to a vision-capable model, returning a text description. Bypasses ordinary chat " +
      "message content, which has no native video block type.",
    promptSnippet:
      "Call `understand_video` whenever the user references a local video file path and wants to know what " +
      "happens in it, or wants it described/summarized.",
    promptGuidelines: [
      "This tool extracts a handful of evenly-spaced still frames (default 3, tune with `frameCount`) — it does " +
        "not read audio from the video; use `understand_audio` separately if speech/sound content also matters.",
      "Prefer a higher `frameCount` for longer or fast-changing videos where a few frames may miss key content.",
    ],
    parameters: UnderstandVideoParams,
    execute: async (_toolCallId, params) => {
      const prompt = params.prompt?.trim() || DEFAULT_VIDEO_PROMPT;
      const frameCount = params.frameCount ?? DEFAULT_FRAME_COUNT;

      const result = await understandVideo(params.path, prompt, frameCount, {
        apiKey: env[VIDEO_API_KEY_ENV] ?? "",
        baseUrl: env[VIDEO_BASE_URL_ENV],
        model: env[VIDEO_MODEL_ENV],
        fetchFn: fetchFn as never,
      });
      return { ...result, details: undefined };
    },
  };
}

export default function piMultimedia(pi: MinimalExtensionApi): void {
  pi.registerTool(buildUnderstandAudioTool(process.env));
  pi.registerTool(buildUnderstandVideoTool(process.env));

  pi.registerCommand("multimedia-status", {
    description: "Reports that pi-desktop's bundled pi-multimedia extension is loaded.",
    handler: () => {
      // Intentionally a no-op: presence of this command in the command list
      // is the whole signal, mirroring pi-llm7's llm7-status (#192).
    },
  });
}

export { detectAudioFormat, transcribeAudioViaApi, understandAudioViaApi };
export { understandVideo, understandVideoViaApi };
