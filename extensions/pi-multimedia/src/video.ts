/**
 * Video understanding via local `ffmpeg` frame-extraction followed by a raw
 * HTTP call to a vision-capable chat completions API (OpenAI request shape),
 * bypassing pi-ai's Message schema entirely (it has no VideoContent type as
 * of @earendil-works/pi-ai@0.84.1). Frames are extracted locally with ffmpeg,
 * base64-encoded as JPEGs, and sent as `image_url` data-URI content blocks
 * alongside a text prompt. The tool result is returned as a plain
 * `TextContent` block so it fits the existing `AgentToolResult` contract.
 *
 * ffmpeg invocation is a real local subprocess call (not something to mock
 * away — see AGENTS.md testing rules: "do not mock unless the mock itself is
 * under test"). The network boundary (`fetch`) to the vision API is injected
 * so this module's HTTP-calling code can be unit-tested without a real
 * network call, exactly like audio.ts's pattern.
 */

declare function require(id: string): unknown;

interface MinimalChildProcess {
  spawnSync(
    command: string,
    args: string[],
    options: { encoding: string },
  ): { status: number | null; stdout: string; stderr: string };
}

interface MinimalOs {
  tmpdir(): string;
}

interface MinimalFsForVideo {
  mkdtempSync(prefix: string): string;
  readFileSync(path: string): { toString(encoding: string): string };
  rmSync(path: string, options: { recursive: boolean; force: boolean }): void;
  existsSync(path: string): boolean;
  statSync(path: string): { size: number };
}

interface MinimalPath {
  join(...parts: string[]): string;
}

function loadChildProcess(): MinimalChildProcess {
  return require("child_process") as MinimalChildProcess;
}

function loadOs(): MinimalOs {
  return require("os") as MinimalOs;
}

function loadFs(): MinimalFsForVideo {
  return require("fs") as MinimalFsForVideo;
}

function loadPath(): MinimalPath {
  return require("path") as MinimalPath;
}

export class FfmpegExtractionError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "FfmpegExtractionError";
  }
}

/** Probes a video's duration in seconds using ffprobe. Throws on failure. */
export function probeDurationSeconds(videoPath: string): number {
  const childProcess = loadChildProcess();
  const result = childProcess.spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", videoPath],
    { encoding: "utf-8" },
  );
  if (result.status !== 0) {
    throw new FfmpegExtractionError(
      `ffprobe failed to read duration for "${videoPath}" (exit ${result.status})`,
      result.stderr,
    );
  }
  const duration = Number.parseFloat(result.stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new FfmpegExtractionError(`ffprobe returned an invalid duration for "${videoPath}": "${result.stdout}"`, result.stderr);
  }
  return duration;
}

/**
 * Extracts `frameCount` evenly-spaced JPEG frames from a local video file
 * using a real ffmpeg subprocess call, and returns each frame's base64-encoded
 * JPEG bytes. Frames are written to a temp directory that is cleaned up
 * before returning (success or failure). Throws `FfmpegExtractionError` on
 * any ffmpeg/ffprobe failure or missing output — callers are expected to
 * catch this and translate it into a non-throwing tool result, matching the
 * audio tool's never-throw contract at the tool-execution boundary.
 */
export function extractFramesAsBase64Jpegs(videoPath: string, frameCount: number): string[] {
  if (!Number.isInteger(frameCount) || frameCount < 1) {
    throw new FfmpegExtractionError(`frameCount must be a positive integer, got: ${frameCount}`, "");
  }

  const fs = loadFs();
  const os = loadOs();
  const path = loadPath();
  const childProcess = loadChildProcess();

  const duration = probeDurationSeconds(videoPath);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-multimedia-frames-"));
  try {
    // Evenly space timestamps within the clip, avoiding the very first/last
    // frame (which are sometimes black/degenerate) by insetting slightly.
    const timestamps: number[] = [];
    for (let i = 0; i < frameCount; i++) {
      const fraction = frameCount === 1 ? 0.5 : (i + 0.5) / frameCount;
      timestamps.push(duration * fraction);
    }

    const framePaths: string[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const outputPath = path.join(tmpDir, `frame-${i}.jpg`);
      const result = childProcess.spawnSync(
        "ffmpeg",
        ["-y", "-ss", timestamps[i].toFixed(3), "-i", videoPath, "-frames:v", "1", "-q:v", "2", outputPath],
        { encoding: "utf-8" },
      );
      if (result.status !== 0) {
        throw new FfmpegExtractionError(
          `ffmpeg failed to extract frame ${i} at t=${timestamps[i].toFixed(3)}s from "${videoPath}" (exit ${result.status})`,
          result.stderr,
        );
      }
      if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
        throw new FfmpegExtractionError(
          `ffmpeg reported success but produced no output frame ${i} for "${videoPath}"`,
          result.stderr,
        );
      }
      framePaths.push(outputPath);
    }

    return framePaths.map((framePath) => fs.readFileSync(framePath).toString("base64"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export interface TextContentBlock {
  type: "text";
  text: string;
}

export interface ImageUrlContentBlock {
  type: "image_url";
  image_url: { url: string };
}

export interface VideoChatCompletionsRequest {
  model: string;
  messages: [
    {
      role: "user";
      content: [TextContentBlock, ...ImageUrlContentBlock[]];
    },
  ];
}

export const VIDEO_MODEL = "gpt-4o";

/** Builds the OpenAI-style chat completions request body for video-frame understanding. */
export function buildVideoRequest(base64Frames: string[], prompt: string): VideoChatCompletionsRequest {
  const imageBlocks: ImageUrlContentBlock[] = base64Frames.map((frame) => ({
    type: "image_url",
    image_url: { url: `data:image/jpeg;base64,${frame}` },
  }));
  return {
    model: VIDEO_MODEL,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: prompt }, ...imageBlocks],
      },
    ],
  };
}

/** Minimal shape this module reads from the API's chat completions response. */
export interface VideoChatCompletionsResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
}

/** Extracts the best-effort text answer out of a chat completions response. */
export function extractVideoResponseText(response: VideoChatCompletionsResponse): string {
  const text = response.choices?.[0]?.message?.content?.trim();
  if (text) return text;
  throw new Error("Video model response contained no text content.");
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
 * Builds an informative error message for a non-ok HTTP response, mirroring
 * audio.ts's rate-limit handling (see that module's comment for the real
 * evidence this is based on: a real burst of 25 concurrent OpenAI calls
 * returned 200 with `x-ratelimit-reset-requests` present; a genuine 429 was
 * not reproduced within the safe attempt budget).
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

export interface UnderstandVideoOptions {
  apiKey: string;
  baseUrl?: string;
  fetchFn: FetchFn;
}

/** Simple text-only tool result content, matching AgentToolResult<unknown>["content"]. */
export interface VideoToolResult {
  content: TextContentBlock[];
  isError: boolean;
}

/**
 * Calls the vision-capable chat completions API with already base64-encoded
 * JPEG frames and returns a tool-result-shaped object. Never throws:
 * network/API failures are encoded as `isError: true` results.
 */
export async function understandVideoViaApi(
  base64Frames: string[],
  prompt: string,
  options: UnderstandVideoOptions,
): Promise<VideoToolResult> {
  const url = `${options.baseUrl ?? "https://api.openai.com/v1"}/chat/completions`;
  const body = buildVideoRequest(base64Frames, prompt);

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
          text: `Failed to reach the video understanding API: ${error instanceof Error ? error.message : String(error)}`,
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
          text: buildErrorMessage("Video understanding API", response.status, response.statusText, response.headers),
        },
      ],
    };
  }

  try {
    const json = (await response.json()) as VideoChatCompletionsResponse;
    const text = extractVideoResponseText(json);
    return { isError: false, content: [{ type: "text", text }] };
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Failed to parse video understanding API response: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
}

/**
 * End-to-end helper: extracts frames from a local video file with ffmpeg and
 * sends them to the vision API. Never throws: both the ffmpeg extraction
 * step and the network call are caught and translated into `isError: true`
 * tool results, matching the audio tool's contract.
 */
export async function understandVideo(
  videoPath: string,
  prompt: string,
  frameCount: number,
  options: UnderstandVideoOptions,
): Promise<VideoToolResult> {
  let frames: string[];
  try {
    frames = extractFramesAsBase64Jpegs(videoPath, frameCount);
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Failed to extract frames from "${videoPath}": ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }

  return understandVideoViaApi(frames, prompt, options);
}
