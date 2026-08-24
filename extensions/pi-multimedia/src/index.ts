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
  AUDIO_TRANSCRIBE_ONLY_PROMPT,
  detectAudioFormat,
  transcribeAudioViaApi,
  understandAudioViaApi,
  type AudioToolResult,
  type TranscribeFetchFn,
} from "./audio.js";
import {
  buildExhaustionError,
  debugLoggerFor,
  resolveAudioChain,
  runChain,
  type AudioCandidate,
} from "./audio-resolution.js";
import { readFileAsBase64 } from "./fs-io.js";
import { understandVideo, understandVideoViaApi, VIDEO_MODEL, type VideoToolResult } from "./video.js";

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
/** Overrides `TRANSCRIBE_MODEL` (default `gpt-transcribe`); the sole env-override candidate, tried before the fixed provider chain (issue #260). */
export const TRANSCRIBE_MODEL_ENV = "MULTIMEDIA_TRANSCRIBE_MODEL";
export const VIDEO_API_KEY_ENV = "MULTIMEDIA_VIDEO_API_KEY";
export const VIDEO_BASE_URL_ENV = "MULTIMEDIA_VIDEO_BASE_URL";
/** Overrides `VIDEO_MODEL` (default `gpt-4o`). */
export const VIDEO_MODEL_ENV = "MULTIMEDIA_VIDEO_MODEL";

/**
 * Minimal shape of pi-ai's `Model<Api>` (see `@earendil-works/pi-ai`'s
 * `types.d.ts`), only the fields this module reads. Declared locally rather
 * than imported: this package intentionally has zero
 * pi-ai/pi-coding-agent runtime dependencies (see `MinimalExtensionApi`
 * below for the same rationale applied to the extension activation API).
 */
export interface RegistryModel {
  id: string;
  name: string;
  api: string;
  baseUrl: string;
  /** The provider id this model belongs to (e.g. "openai", "openrouter"). Used by the audio candidate-chain resolution (issue #243). */
  provider?: string;
}

/** Minimal shape of pi-coding-agent's `ResolvedRequestAuth` (`core/model-registry.ts`), only the success-path fields this module reads. */
export interface ResolvedModelAuth {
  ok: boolean;
  apiKey?: string;
  baseUrl?: string;
}

/** Minimal shape of pi-coding-agent's `ModelRegistry` (`core/model-registry.ts`), only the methods this module calls. */
export interface MinimalModelRegistry {
  /** Models with usable (already-configured) auth — the same set the model picker offers. */
  getAvailable(): RegistryModel[];
  /** Resolves the real API key/base URL already configured for this model via Settings/auth.json/OAuth. */
  getApiKeyAndHeaders(model: RegistryModel): Promise<ResolvedModelAuth>;
  /**
   * Whether a given provider id has *any* resolved credential at all,
   * independent of whether that provider lists a matching model in
   * `getAvailable()`. Needed because transcription models (`whisper-1`,
   * `gpt-transcribe`, etc.) are never chat models and so never appear in
   * `getAvailable()` (issue #243).
   */
  getProviderAuthStatus?(provider: string): { configured: boolean } | undefined;
  /** Resolves the raw API key for a provider id directly, without needing a `Model` object. */
  getApiKeyForProvider?(provider: string): Promise<string | undefined>;
  /** Looks up a provider's own config (e.g. its default `baseUrl`). */
  getProvider?(provider: string): { baseUrl?: string } | undefined;
}

/**
 * Minimal shape of pi-coding-agent's `ExtensionContext` (`core/extensions/types.ts`),
 * only the field this module reads. The real `ToolDefinition.execute` is
 * called with `(toolCallId, params, signal, onUpdate, ctx)`; `ctx` is
 * optional here purely so this package's existing unit tests (which call
 * `execute(toolCallId, params)` directly, without a real agent session)
 * keep working unchanged.
 */
export interface MinimalExtensionContext {
  modelRegistry?: MinimalModelRegistry;
}

/**
 * Best-effort search across models pi-desktop already has loaded with
 * usable auth (`ctx.modelRegistry.getAvailable()`) for one matching `hint`
 * by id/name — the same resolved credential set (settings.json + auth.json
 * + OAuth) that already powers the model picker, so a model configured
 * once in Settings "just works" here too, with no separate
 * `MULTIMEDIA_*_API_KEY` needed (issue #235).
 *
 * Filtered to `api === "openai-completions"` first: that is the one pi-ai
 * `Api` id whose wire format (`/v1/chat/completions`-style request, Bearer
 * auth, `choices[0].message.content` response) matches what this package's
 * hand-rolled request builders in `audio.ts`/`video.ts` already speak.
 * Other api ids (`openai-responses`, `anthropic-messages`,
 * `bedrock-converse-stream`, etc.) are different wire formats this code
 * does not send, despite some sharing "openai" in the name — matching by
 * name alone across all apis could pick a model this code can't actually
 * talk to.
 *
 * Within that filtered set, prefers an exact case-insensitive `id`/`name`
 * match, else the first case-insensitive substring match, checked in both
 * directions against the candidate's "core" (its id/name with any
 * `provider/` prefix stripped). Real-world registry ids are often shorter
 * than this tool's hardcoded default hint (e.g. OpenRouter's
 * `openai/gpt-audio` vs. the default hint `gpt-audio-1.5`), so checking
 * only `id.includes(hint)` misses them; checking `hint.includes(core)` too
 * catches version/date suffixes the hint carries that the real id doesn't.
 */
export function findModelByNameHint(models: RegistryModel[], hint: string): RegistryModel | undefined {
  const candidates = models.filter((model) => model.api === "openai-completions");
  const needle = hint.toLowerCase();
  const coreOf = (id: string) => id.slice(id.lastIndexOf("/") + 1);
  const exact = candidates.find((model) => model.id.toLowerCase() === needle || model.name.toLowerCase() === needle);
  if (exact) return exact;
  return candidates.find((model) => {
    const idCore = coreOf(model.id.toLowerCase());
    const nameCore = coreOf(model.name.toLowerCase());
    return idCore.includes(needle) || needle.includes(idCore) || nameCore.includes(needle) || needle.includes(nameCore);
  });
}

/** What a resolved audio/video API call needs, regardless of which source (registry or env vars) it came from. */
export interface ResolvedApiConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

/**
 * Resolves API config by trying `ctx.modelRegistry` first (via
 * `findModelByNameHint`), falling back to the explicit
 * `MULTIMEDIA_*_API_KEY`/`MULTIMEDIA_*_BASE_URL`/`MULTIMEDIA_*_MODEL` env
 * vars when no registry match is found (or no registry is available at
 * all, e.g. this package's own unit tests, or running standalone outside
 * pi-desktop). Never throws: any registry lookup failure is treated the
 * same as "no match found".
 */
async function resolveApiConfig(
  ctx: MinimalExtensionContext,
  hint: string,
  envApiKey: string | undefined,
  envBaseUrl: string | undefined,
  envModel: string | undefined,
): Promise<ResolvedApiConfig> {
  const registry = ctx.modelRegistry;
  if (registry) {
    try {
      const match = findModelByNameHint(registry.getAvailable(), hint);
      if (match) {
        const auth = await registry.getApiKeyAndHeaders(match);
        if (auth.ok && auth.apiKey) {
          return { apiKey: auth.apiKey, baseUrl: auth.baseUrl ?? match.baseUrl, model: match.id };
        }
      }
    } catch {
      // Best-effort convenience only -- fall through to env vars below.
    }
  }
  return { apiKey: envApiKey ?? "", baseUrl: envBaseUrl, model: envModel };
}

const UnderstandAudioParams = Type.Object({
  path: Type.String({ description: "Absolute or workspace-relative path to a local audio file (wav/mp3/m4a/webm)." }),
  prompt: Type.Optional(
    Type.String({
      description:
        "Unused. Kept for backward compatibility only -- `understand_audio` always transcribes and never reads " +
        "this field (issue #260).",
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
    signal?: unknown,
    onUpdate?: unknown,
    ctx?: MinimalExtensionContext,
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
): MinimalToolDefinition<typeof UnderstandAudioParams, { path: string; prompt?: string }, AudioToolResult> {
  const logger = debugLoggerFor(env);

  return {
    name: "understand_audio",
    label: "Understand Audio",
    description:
      "Transcribes the contents of a local audio file (wav/mp3/m4a/webm) into plain text via a dedicated " +
      "speech-to-text model/endpoint, tried across a fixed provider fallback chain. Bypasses ordinary chat " +
      "message content, which has no native audio block type.",
    promptSnippet:
      "Call `understand_audio` whenever the user references a local audio file path (wav/mp3/m4a/webm) and wants to " +
      "know what is said in it, or wants it summarized/transcribed.",
    promptGuidelines: [
      "This tool always transcribes -- it returns plain speech-to-text of the audio's spoken content.",
      "If the audio is music or otherwise non-speech, it may return an empty/near-empty result; that is " +
        "expected, not an error.",
      "A successful (non-error) tool result always reflects a real transcript of the actual audio; relay its " +
        "content to the user as the answer instead of re-describing it as a failure.",
    ],
    parameters: UnderstandAudioParams,
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx = {}) => {
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

      const call = (candidate: AudioCandidate): Promise<AudioToolResult> => {
        if (candidate.kind === "chat") {
          return understandAudioViaApi(base64Audio, format, AUDIO_TRANSCRIBE_ONLY_PROMPT, {
            apiKey: candidate.apiKey ?? "",
            baseUrl: candidate.baseUrl,
            model: candidate.model,
            systemPrompt: AUDIO_TRANSCRIBE_ONLY_PROMPT,
            fetchFn: fetchFn as never,
          });
        }
        return transcribeAudioViaApi(base64Audio, format, {
          apiKey: candidate.apiKey ?? "",
          baseUrl: candidate.baseUrl,
          model: candidate.model,
          fetchFn: fetchFn as unknown as TranscribeFetchFn,
        });
      };

      const chain = await resolveAudioChain(ctx, env, TRANSCRIBE_MODEL_ENV, AUDIO_API_KEY_ENV, AUDIO_BASE_URL_ENV);
      const outcome = await runChain("audio", chain, call, logger);
      if (outcome.kind === "exhausted") {
        return { ...buildExhaustionError(outcome.reasons), details: undefined };
      }
      return { ...outcome.result, details: undefined };
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
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx = {}) => {
      const prompt = params.prompt?.trim() || DEFAULT_VIDEO_PROMPT;
      const frameCount = params.frameCount ?? DEFAULT_FRAME_COUNT;

      const config = await resolveApiConfig(
        ctx,
        env[VIDEO_MODEL_ENV] ?? VIDEO_MODEL,
        env[VIDEO_API_KEY_ENV],
        env[VIDEO_BASE_URL_ENV],
        env[VIDEO_MODEL_ENV],
      );
      const result = await understandVideo(params.path, prompt, frameCount, {
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
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
