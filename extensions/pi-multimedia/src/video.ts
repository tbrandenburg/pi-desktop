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
 * Probes a video's average frame rate (fps) using ffprobe's `r_frame_rate`
 * (a rational like "30000/1001" or "10/1"). Throws on failure.
 */
export function probeFrameRateFps(videoPath: string): number {
  const childProcess = loadChildProcess();
  const result = childProcess.spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=r_frame_rate",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      videoPath,
    ],
    { encoding: "utf-8" },
  );
  if (result.status !== 0) {
    throw new FfmpegExtractionError(
      `ffprobe failed to read frame rate for "${videoPath}" (exit ${result.status})`,
      result.stderr,
    );
  }
  const raw = result.stdout.trim();
  const [numeratorText, denominatorText] = raw.split("/");
  const numerator = Number.parseFloat(numeratorText ?? "");
  const denominator = denominatorText === undefined ? 1 : Number.parseFloat(denominatorText);
  const fps = denominator === 0 ? Number.NaN : numerator / denominator;
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new FfmpegExtractionError(`ffprobe returned an invalid frame rate for "${videoPath}": "${raw}"`, result.stderr);
  }
  return fps;
}

/**
 * Computes the maximum `frameCount` that can safely be extracted from a clip
 * of the given duration and source frame rate, without the last inset
 * timestamp landing past the last decodable frame.
 *
 * Frames are requested at inset fractions `(i + 0.5) / frameCount` of the
 * duration (see `extractFramesAsBase64Jpegs`), so the last requested
 * timestamp is `duration * (frameCount - 0.5) / frameCount`. The last frame a
 * container actually has decodable is at approximately `duration - 1/fps`
 * (one source-frame-interval before the reported duration): ffmpeg's `-ss`
 * seek finds no frame and silently exits 0 with an empty output file for any
 * later timestamp (verified against real fixtures below). Solving
 * `duration * (frameCount - 0.5) / frameCount <= duration - 1/fps` for an
 * integer frameCount gives `floor(fps * duration / 2)`.
 *
 * Verified against real synthetic fixtures (10fps testsrc, real ffmpeg
 * subprocess calls, no mocking):
 *   - 2s @ 10fps: formula gives max=10. frameCount=10 (last ts=1.900s)
 *     produced a real frame; frameCount=11 (last ts=1.909s) produced no
 *     output file despite ffmpeg exiting 0.
 *   - 5s @ 10fps: formula gives max=25. frameCount=25 (last ts=4.900s)
 *     produced a real frame; frameCount=26 (last ts=4.904s) produced no
 *     output file despite ffmpeg exiting 0.
 *
 * If `fps` is not finite/positive (e.g. probing failed upstream), no clamp
 * is applied (returns `Number.MAX_SAFE_INTEGER`) rather than blocking a
 * request based on unreliable data.
 */
export function computeMaxSafeFrameCount(durationSeconds: number, fps: number): number {
  if (!Number.isFinite(fps) || fps <= 0 || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.max(1, Math.floor((fps * durationSeconds) / 2));
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
export function buildVideoRequest(
  base64Frames: string[],
  prompt: string,
  model: string = VIDEO_MODEL,
): VideoChatCompletionsRequest {
  const imageBlocks: ImageUrlContentBlock[] = base64Frames.map((frame) => ({
    type: "image_url",
    image_url: { url: `data:image/jpeg;base64,${frame}` },
  }));
  return {
    model,
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
  /** Overrides `VIDEO_MODEL`, e.g. to point at a different provider's vision-capable model. */
  model?: string;
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
  const body = buildVideoRequest(base64Frames, prompt, options.model);

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
 * sends them to the vision API. Never throws: probing failures, the
 * upfront frameCount clamp, the ffmpeg extraction step, and the network call
 * are all caught/handled and translated into a `VideoToolResult`, matching
 * the audio tool's contract.
 *
 * Before calling ffmpeg, this probes the real duration and frame rate and
 * clamps an over-aggressive `frameCount` down to `computeMaxSafeFrameCount`
 * (clamp-and-warn, not a hard rejection) so a request like "50 frames from a
 * 5s clip" degrades gracefully to the actual maximum decodable frame count
 * instead of failing after ffmpeg has already run. The returned text is
 * prefixed with a note when a clamp occurred.
 */
export async function understandVideo(
  videoPath: string,
  prompt: string,
  frameCount: number,
  options: UnderstandVideoOptions,
): Promise<VideoToolResult> {
  let effectiveFrameCount = frameCount;
  let clampNote = "";

  if (Number.isInteger(frameCount) && frameCount >= 1) {
    try {
      const duration = probeDurationSeconds(videoPath);
      const fps = probeFrameRateFps(videoPath);
      const maxSafeFrameCount = computeMaxSafeFrameCount(duration, fps);
      if (frameCount > maxSafeFrameCount) {
        effectiveFrameCount = maxSafeFrameCount;
        clampNote =
          `Note: requested frameCount ${frameCount} exceeds the ${maxSafeFrameCount} frames decodable from this ` +
          `${duration.toFixed(2)}s clip at ~${fps.toFixed(2)}fps (frames near the tail become unseekable beyond ` +
          `that point); reduced to ${maxSafeFrameCount}.\n\n`;
      }
    } catch {
      // Probing failed upfront (e.g. corrupt file); fall through and let
      // extractFramesAsBase64Jpegs's own probing/extraction report the
      // concrete failure below, rather than silently swallowing it here.
    }
  }

  let frames: string[];
  try {
    frames = extractFramesAsBase64Jpegs(videoPath, effectiveFrameCount);
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

  const result = await understandVideoViaApi(frames, prompt, options);
  if (clampNote && !result.isError && result.content[0]) {
    result.content[0].text = clampNote + result.content[0].text;
  }
  return result;
}
