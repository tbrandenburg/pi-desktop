/**
 * Audio understanding via a raw HTTP call to an audio-capable chat completions
 * API (OpenAI's `gpt-audio-1.5` request shape), bypassing pi-ai's Message
 * schema entirely (it has no AudioContent/VideoContent type as of
 * @earendil-works/pi-ai@0.84.1). The tool result is returned as a plain
 * `TextContent` block so it fits the existing `AgentToolResult` contract.
 *
 * The network boundary (`fetch`) is injected so this module can be fully
 * unit-tested without any real network call.
 */

/** Audio formats accepted by the target audio-capable chat completions API. */
export type AudioFormat = "wav" | "mp3";

/** Maps a lowercased file extension (no dot) to the API's accepted format string. */
const EXTENSION_TO_FORMAT: Record<string, AudioFormat> = {
  wav: "wav",
  mp3: "mp3",
  // m4a has no native "input_audio" format on this API; re-labeled as mp3
  // container-wise this is lossy metadata-only guidance for a PoC, not a
  // transcode. A production implementation would transcode m4a -> wav/mp3
  // before sending (see README "Known limitations").
  m4a: "mp3",
};

export class UnsupportedAudioFormatError extends Error {
  constructor(extension: string) {
    super(`Unsupported audio file extension: ".${extension}". Supported: wav, mp3, m4a.`);
    this.name = "UnsupportedAudioFormatError";
  }
}

/** Resolves the API's accepted format string from a file path's extension. */
export function detectAudioFormat(filePath: string): AudioFormat {
  const match = /\.([a-zA-Z0-9]+)$/.exec(filePath);
  const extension = match?.[1]?.toLowerCase();
  const format = extension ? EXTENSION_TO_FORMAT[extension] : undefined;
  if (!format) {
    throw new UnsupportedAudioFormatError(extension ?? "");
  }
  return format;
}

export interface InputAudioContentBlock {
  type: "input_audio";
  input_audio: { data: string; format: AudioFormat };
}

export interface TextContentBlock {
  type: "text";
  text: string;
}

export interface AudioChatCompletionsRequest {
  model: string;
  // NOTE: verified live against the real API (2026-08-22): requesting
  // ["text", "audio"] output modalities without also supplying a required
  // `audio: { voice, format }` output config causes a guaranteed 400
  // `missing_audio` error. Since this tool only wants a text answer, the
  // correct output modality is text-only; input audio is still accepted via
  // the `input_audio` content block below regardless of output modalities.
  modalities: ["text"];
  messages: [
    {
      role: "user";
      content: [TextContentBlock, InputAudioContentBlock];
    },
  ];
}

export const AUDIO_MODEL = "gpt-audio-1.5";

/** Builds the OpenAI-style chat completions request body for audio understanding. */
export function buildAudioRequest(base64Audio: string, format: AudioFormat, prompt: string): AudioChatCompletionsRequest {
  return {
    model: AUDIO_MODEL,
    modalities: ["text"],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "input_audio", input_audio: { data: base64Audio, format } },
        ],
      },
    ],
  };
}

/** Minimal shape this module reads from the API's chat completions response. */
export interface AudioChatCompletionsResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      audio?: { transcript?: string | null };
    };
  }>;
}

/** Extracts the best-effort text answer out of a chat completions response. */
export function extractResponseText(response: AudioChatCompletionsResponse): string {
  const message = response.choices?.[0]?.message;
  const text = message?.content?.trim();
  if (text) return text;
  const transcript = message?.audio?.transcript?.trim();
  if (transcript) return transcript;
  throw new Error("Audio model response contained no text or transcript content.");
}

/** Injectable network boundary: identical shape to the global `fetch`. */
export type FetchFn = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<{ ok: boolean; status: number; statusText: string; json(): Promise<unknown> }>;

export interface UnderstandAudioOptions {
  apiKey: string;
  baseUrl?: string;
  fetchFn: FetchFn;
}

/** Simple text-only tool result content, matching AgentToolResult<unknown>["content"]. */
export interface AudioToolResult {
  content: TextContentBlock[];
  isError: boolean;
}

/**
 * Calls the audio-capable chat completions API with an already base64-encoded
 * audio payload and returns a tool-result-shaped object. Never throws:
 * network/API failures are encoded as `isError: true` results.
 */
export async function understandAudioViaApi(
  base64Audio: string,
  format: AudioFormat,
  prompt: string,
  options: UnderstandAudioOptions,
): Promise<AudioToolResult> {
  const url = `${options.baseUrl ?? "https://api.openai.com/v1"}/chat/completions`;
  const body = buildAudioRequest(base64Audio, format, prompt);

  let response: Awaited<ReturnType<FetchFn>>;
  try {
    response = await options.fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Failed to reach the audio understanding API: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }

  if (!response.ok) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Audio understanding API returned an error: ${response.status} ${response.statusText}`,
        },
      ],
    };
  }

  try {
    const json = (await response.json()) as AudioChatCompletionsResponse;
    const text = extractResponseText(json);
    return { isError: false, content: [{ type: "text", text }] };
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Failed to parse audio understanding API response: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
}
