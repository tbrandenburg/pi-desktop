/**
 * pi-multimedia — PoC first-party pi extension registering an
 * `understand_audio` tool.
 *
 * pi-ai's Message schema (as of @earendil-works/pi-ai@0.84.1) has no
 * AudioContent/VideoContent block type, so audio understanding can't be
 * expressed as ordinary LLM message content. This tool instead makes a raw
 * HTTP call to an audio-capable chat completions API directly from tool
 * `execute()` and returns the answer as a plain `TextContent` block, which
 * fits the existing `AgentToolResult<TDetails>` contract unchanged.
 *
 * Video would extend the same pattern; see README.md for the two concrete
 * options (frame-extraction-as-images vs. a native-video-model call).
 */
import { Type } from "typebox";
import { detectAudioFormat, understandAudioViaApi, type AudioToolResult } from "./audio.js";
import { readFileAsBase64 } from "./fs-io.js";

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

const UnderstandAudioParams = Type.Object({
  path: Type.String({ description: "Absolute or workspace-relative path to a local audio file (wav/mp3/m4a)." }),
  prompt: Type.Optional(
    Type.String({ description: "What to ask about the audio. Defaults to a transcribe+describe prompt." }),
  ),
});

const DEFAULT_PROMPT = "Transcribe and describe this audio.";

interface MinimalToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: typeof UnderstandAudioParams;
  execute: (
    toolCallId: string,
    params: { path: string; prompt?: string },
  ) => Promise<{ content: AudioToolResult["content"]; details: unknown; isError?: boolean }>;
}

interface MinimalExtensionApi {
  registerCommand(
    name: string,
    command: { description: string; handler: (args: string, ctx: unknown) => void | Promise<void> },
  ): void;
  registerTool(tool: MinimalToolDefinition): void;
}

/** Builds the `understand_audio` tool definition, given a real or injected fetch. */
export function buildUnderstandAudioTool(
  env: Record<string, string | undefined>,
  fetchFn: typeof fetch = fetch,
): MinimalToolDefinition {
  return {
    name: "understand_audio",
    label: "Understand Audio",
    description:
      "Understands the contents of a local audio file (wav/mp3/m4a) by sending it to an audio-capable model " +
      "and returns a text transcription/description. Bypasses ordinary chat message content, which has no " +
      "native audio block type.",
    parameters: UnderstandAudioParams,
    execute: async (_toolCallId, params) => {
      const prompt = params.prompt?.trim() || DEFAULT_PROMPT;
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

      const result = await understandAudioViaApi(base64Audio, format, prompt, {
        apiKey: env[AUDIO_API_KEY_ENV] ?? "",
        baseUrl: env[AUDIO_BASE_URL_ENV],
        fetchFn: fetchFn as never,
      });
      return { ...result, details: undefined };
    },
  };
}

export default function piMultimedia(pi: MinimalExtensionApi): void {
  pi.registerTool(buildUnderstandAudioTool(process.env));

  pi.registerCommand("multimedia-status", {
    description: "Reports that pi-desktop's bundled pi-multimedia extension is loaded.",
    handler: () => {
      // Intentionally a no-op: presence of this command in the command list
      // is the whole signal, mirroring pi-llm7's llm7-status (#192).
    },
  });
}

export { detectAudioFormat, understandAudioViaApi };
