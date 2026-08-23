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
  // container-wise this is lossy metadata-only guidance, not a real
  // transcode. A future implementation would transcode m4a -> wav/mp3
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
export function buildAudioRequest(
  base64Audio: string,
  format: AudioFormat,
  prompt: string,
  model: string = AUDIO_MODEL,
): AudioChatCompletionsRequest {
  return {
    model,
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

/** Minimal response-headers reader, satisfied by the real `fetch` Response's `headers`. */
export interface MinimalResponseHeaders {
  get(name: string): string | null;
}

/** Injectable network boundary: identical shape to the global `fetch`. */
export type FetchFn = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<{ ok: boolean; status: number; statusText: string; headers?: MinimalResponseHeaders; json(): Promise<unknown> }>;

/**
 * Injectable network boundary for the multipart transcription endpoint.
 * Only `headers` (Authorization; never Content-Type — the FormData boundary
 * must be set by the runtime's own multipart serializer) and a `FormData`
 * body are needed, matching the real global `fetch` signature's shape for
 * this call.
 */
export type TranscribeFetchFn = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: MinimalFormData;
}) => Promise<{ ok: boolean; status: number; statusText: string; headers?: MinimalResponseHeaders; json(): Promise<unknown> }>;

/** The minimal `FormData`-like surface this module needs (real global `FormData` satisfies it). */
export interface MinimalFormData {
  append(name: string, value: MinimalBlob | string, fileName?: string): void;
}

/** The minimal `Blob`-like surface this module needs (real global `Blob` satisfies it). */
export interface MinimalBlob {
  readonly size: number;
}

/** Factory boundary for constructing `FormData`/`Blob`, injected for testability. */
export interface MultipartFactory {
  createFormData(): MinimalFormData;
  createBlob(bytes: Uint8Array, contentType: string): MinimalBlob;
}

/** Maps an accepted audio format to its multipart `Content-Type`. */
const FORMAT_TO_CONTENT_TYPE: Record<AudioFormat, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
};

/**
 * Builds an informative error message for a non-ok HTTP response. On a real
 * 429, OpenAI documents a `Retry-After` header (seconds until the rate limit
 * window resets) and, on every response including 200s, `x-ratelimit-reset-requests`
 * (verified live 2026-08-22 against a real burst of 25 concurrent
 * `gpt-transcribe` calls — all returned 200 with this header present, e.g.
 * "120ms"/"680ms"; a genuine 429 was not reproduced within the safe attempt
 * budget, so `Retry-After`'s exact real format on a 429 is inferred from
 * OpenAI's public rate-limit docs, not directly observed). Falls back to the
 * `x-ratelimit-reset-requests` header, then to a generic message, so a 429
 * without any retry header still gets a clear rate-limit-specific message
 * instead of the bare "429 Too Many Requests" bucket.
 */
function buildErrorMessage(
  apiLabel: string,
  status: number,
  statusText: string,
  headers?: MinimalResponseHeaders,
): string {
  if (status !== 429) {
    return `${apiLabel} returned an error: ${status} ${statusText}`;
  }
  const retryAfter = headers?.get("retry-after");
  if (retryAfter) {
    return `Rate limited by OpenAI (${apiLabel}): retry after ${retryAfter} second(s).`;
  }
  const resetRequests = headers?.get("x-ratelimit-reset-requests");
  if (resetRequests) {
    return `Rate limited by OpenAI (${apiLabel}): request quota resets in ${resetRequests}.`;
  }
  return `Rate limited by OpenAI (${apiLabel}): too many requests (429). No Retry-After or x-ratelimit-reset-requests header was present; retry after a short delay.`;
}

export const TRANSCRIBE_MODEL = "gpt-transcribe";

/** Decodes a base64 string into raw bytes (works in both Node and browser-like `atob` environments). */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

declare function atob(data: string): string;

/**
 * Builds the multipart/form-data body for `POST /v1/audio/transcriptions`:
 * a `file` field (binary audio, real filename+content-type, NOT base64 —
 * multipart avoids the ~33% base64 size inflation of the chat-completions
 * JSON approach) and a `model` field.
 */
export function buildTranscriptionFormData(
  base64Audio: string,
  format: AudioFormat,
  factory: MultipartFactory,
  model: string = TRANSCRIBE_MODEL,
): MinimalFormData {
  const bytes = base64ToBytes(base64Audio);
  const blob = factory.createBlob(bytes, FORMAT_TO_CONTENT_TYPE[format]);
  const form = factory.createFormData();
  form.append("file", blob, `audio.${format}`);
  form.append("model", model);
  return form;
}

/** Real global `FormData`/`Blob` factory, used outside of tests. Node 22+ and browsers both expose these globally. */
export const realMultipartFactory: MultipartFactory = {
  createFormData: () => new (globalThis as unknown as { FormData: new () => MinimalFormData }).FormData(),
  createBlob: (bytes, contentType) =>
    new (globalThis as unknown as { Blob: new (parts: unknown[], options?: { type?: string }) => MinimalBlob }).Blob(
      [bytes],
      { type: contentType },
    ),
};

/** Minimal shape this module reads from the transcription endpoint's response. */
export interface TranscriptionResponse {
  text?: string;
  language?: string;
  languages?: string[];
}

/** Extracts the transcript text out of a transcription response. Empty/whitespace-only text is valid (e.g. music/non-speech audio). */
export function extractTranscriptionText(response: TranscriptionResponse): string {
  return (response.text ?? "").trim();
}

export interface TranscribeAudioOptions {
  apiKey: string;
  baseUrl?: string;
  fetchFn: TranscribeFetchFn;
  multipartFactory?: MultipartFactory;
  /** Overrides `TRANSCRIBE_MODEL`, e.g. to point at a different provider's transcription model. */
  model?: string;
}

/**
 * Calls the dedicated `gpt-transcribe` transcription endpoint
 * (`POST /v1/audio/transcriptions`, multipart/form-data, NOT the
 * chat-completions JSON+base64 shape) and returns a tool-result-shaped
 * object. Never throws: network/API failures are encoded as `isError: true`
 * results. Music/non-speech audio may yield an empty transcript rather than
 * an error — that is reported as a non-error empty-text result, since the
 * API call itself succeeded.
 */
export async function transcribeAudioViaApi(
  base64Audio: string,
  format: AudioFormat,
  options: TranscribeAudioOptions,
): Promise<AudioToolResult> {
  const url = `${options.baseUrl ?? "https://api.openai.com/v1"}/audio/transcriptions`;
  const form = buildTranscriptionFormData(
    base64Audio,
    format,
    options.multipartFactory ?? realMultipartFactory,
    options.model,
  );

  let response: Awaited<ReturnType<TranscribeFetchFn>>;
  try {
    response = await options.fetchFn(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${options.apiKey}` },
      body: form,
    });
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Failed to reach the transcription API: ${error instanceof Error ? error.message : String(error)}`,
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
          text: buildErrorMessage("Transcription API", response.status, response.statusText, response.headers),
        },
      ],
    };
  }

  try {
    const json = (await response.json()) as TranscriptionResponse;
    const text = extractTranscriptionText(json);
    return {
      isError: false,
      content: [{ type: "text", text: text || "(no speech detected in audio — the clip may be music, silence, or non-verbal sound)" }],
    };
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Failed to parse transcription API response: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
}

export interface UnderstandAudioOptions {
  apiKey: string;
  baseUrl?: string;
  fetchFn: FetchFn;
  /** Overrides `AUDIO_MODEL`, e.g. to point at a different provider's audio-capable model. */
  model?: string;
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
  const body = buildAudioRequest(base64Audio, format, prompt, options.model);

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
          text: buildErrorMessage("Audio understanding API", response.status, response.statusText, response.headers),
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
