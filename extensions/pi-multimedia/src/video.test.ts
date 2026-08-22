import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildVideoRequest,
  extractFramesAsBase64Jpegs,
  extractVideoResponseText,
  FfmpegExtractionError,
  understandVideo,
  understandVideoViaApi,
  VIDEO_MODEL,
  type FetchFn,
} from "./video.js";

/**
 * Real, tiny (~2s, 320x240) synthetic test video generated on the fly by
 * ffmpeg's own `testsrc` lavfi source (see AGENTS.md testing rules: prefer a
 * real local ffmpeg invocation over mocking it away). Generated fresh in a
 * temp directory per test run and removed afterwards, so no fixture asset is
 * ever left behind on disk between runs.
 */
let fixtureDir: string;
let FIXTURE_VIDEO_PATH: string;

beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "pi-multimedia-video-fixture-"));
  FIXTURE_VIDEO_PATH = join(fixtureDir, "fixture.mp4");
  execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=10", FIXTURE_VIDEO_PATH], {
    stdio: "pipe",
  });
});

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe("extractFramesAsBase64Jpegs (real ffmpeg subprocess, no network)", () => {
  it("extracts the requested number of real, non-empty base64 JPEG frames from a real video", () => {
    const frames = extractFramesAsBase64Jpegs(FIXTURE_VIDEO_PATH, 3);

    expect(frames).toHaveLength(3);
    for (const frame of frames) {
      expect(frame.length).toBeGreaterThan(0);
      const bytes = Buffer.from(frame, "base64");
      // Real JPEG magic bytes: FF D8 FF
      expect(bytes[0]).toBe(0xff);
      expect(bytes[1]).toBe(0xd8);
      expect(bytes[2]).toBe(0xff);
    }
  });

  it("throws FfmpegExtractionError for a non-existent video file instead of hanging", () => {
    expect(() => extractFramesAsBase64Jpegs("/tmp/opencode/does-not-exist-12345.mp4", 3)).toThrow(FfmpegExtractionError);
  });

  it("throws FfmpegExtractionError for a non-positive-integer frameCount", () => {
    expect(() => extractFramesAsBase64Jpegs(FIXTURE_VIDEO_PATH, 0)).toThrow(FfmpegExtractionError);
    expect(() => extractFramesAsBase64Jpegs(FIXTURE_VIDEO_PATH, -1)).toThrow(FfmpegExtractionError);
  });

  it("still extracts frames when frameCount exceeds one-per-second (evenly re-spaces within the real duration)", () => {
    // The 2s fixture has no "1-second interval" limit: frames are evenly
    // spaced fractions of the real probed duration, so requesting 10 frames
    // from a 2s clip still succeeds (multiple frames land close together
    // rather than failing).
    const frames = extractFramesAsBase64Jpegs(FIXTURE_VIDEO_PATH, 10);
    expect(frames).toHaveLength(10);
    expect(frames.every((frame) => frame.length > 0)).toBe(true);
  });
});

describe("buildVideoRequest", () => {
  it("builds the exact chat-completions request shape with one image_url block per frame", () => {
    const request = buildVideoRequest(["ZmFrZQ==", "ZnJhbWU="], "Describe this video.");

    expect(request.model).toBe(VIDEO_MODEL);
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0].content).toHaveLength(3); // 1 text + 2 images
  });

  it("nests the text prompt first and each frame as a data-URI image_url block", () => {
    const request = buildVideoRequest(["AAA="], "What happens?");

    expect(request.messages[0].content).toEqual([
      { type: "text", text: "What happens?" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAA=" } },
    ]);
  });
});

describe("extractVideoResponseText", () => {
  it("returns the trimmed message content when present", () => {
    expect(extractVideoResponseText({ choices: [{ message: { content: " a description " } }] })).toBe("a description");
  });

  it("throws when no content is present", () => {
    expect(() => extractVideoResponseText({ choices: [{ message: {} }] })).toThrow();
    expect(() => extractVideoResponseText({})).toThrow();
  });
});

describe("understandVideoViaApi (mocked HTTP, no real network)", () => {
  it("returns a non-error TextContent result from a successful mocked response", async () => {
    const calls: unknown[] = [];
    const fetchFn: FetchFn = async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ choices: [{ message: { content: "A moving test pattern." } }] }),
      };
    };

    const result = await understandVideoViaApi(["ZmFrZQ=="], "Describe this.", { apiKey: "test-key", fetchFn });

    expect(result).toEqual({ isError: false, content: [{ type: "text", text: "A moving test pattern." }] });
    expect(calls).toHaveLength(1);
  });

  it("sends the Authorization header and one image_url block per frame in the JSON body", async () => {
    let capturedInit: { headers: Record<string, string>; body: string } | undefined;
    const fetchFn: FetchFn = async (_url, init) => {
      capturedInit = init;
      return { ok: true, status: 200, statusText: "OK", json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
    };

    await understandVideoViaApi(["AAA=", "BBB="], "hi", { apiKey: "sk-abc", fetchFn });

    expect(capturedInit?.headers.Authorization).toBe("Bearer sk-abc");
    const parsedBody = JSON.parse(capturedInit?.body ?? "{}");
    expect(parsedBody.messages[0].content.filter((block: { type: string }) => block.type === "image_url")).toHaveLength(2);
  });

  it("returns isError:true with a helpful message on network failure instead of throwing", async () => {
    const fetchFn: FetchFn = async () => {
      throw new Error("ECONNREFUSED");
    };

    const result = await understandVideoViaApi(["AAA="], "hi", { apiKey: "test-key", fetchFn });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("ECONNREFUSED");
  });

  it("returns isError:true on a non-ok HTTP response instead of throwing", async () => {
    const fetchFn: FetchFn = async () => ({ ok: false, status: 429, statusText: "Too Many Requests", json: async () => ({}) });

    const result = await understandVideoViaApi(["AAA="], "hi", { apiKey: "test-key", fetchFn });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("429");
  });

  it("returns an informative rate-limit message with the real seconds-to-wait when a 429 carries a Retry-After header", async () => {
    const fetchFn: FetchFn = async () => ({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      headers: { get: (name: string) => (name === "retry-after" ? "5" : null) },
      json: async () => ({}),
    });

    const result = await understandVideoViaApi(["AAA="], "hi", { apiKey: "test-key", fetchFn });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Rate limited");
    expect(result.content[0].text).toContain("5 second");
  });

  it("still returns a sensible rate-limit fallback message for a 429 with no retry header at all", async () => {
    const fetchFn: FetchFn = async () => ({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      headers: { get: () => null },
      json: async () => ({}),
    });

    const result = await understandVideoViaApi(["AAA="], "hi", { apiKey: "test-key", fetchFn });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Rate limited");
    expect(result.content[0].text).toContain("429");
  });

  it("returns isError:true when the response body cannot be parsed into text", async () => {
    const fetchFn: FetchFn = async () => ({ ok: true, status: 200, statusText: "OK", json: async () => ({ choices: [] }) });

    const result = await understandVideoViaApi(["AAA="], "hi", { apiKey: "test-key", fetchFn });

    expect(result.isError).toBe(true);
    expect(result.content[0].text.length).toBeGreaterThan(0);
  });
});

describe("understandVideo (real ffmpeg + mocked HTTP end-to-end)", () => {
  it("extracts real frames from a real video and sends them through a mocked API call", async () => {
    const calls: unknown[] = [];
    const fetchFn: FetchFn = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, statusText: "OK", json: async () => ({ choices: [{ message: { content: "test pattern" } }] }) };
    };

    const result = await understandVideo(FIXTURE_VIDEO_PATH, "Describe this.", 2, { apiKey: "test-key", fetchFn });

    expect(result).toEqual({ isError: false, content: [{ type: "text", text: "test pattern" }] });
    expect(calls).toHaveLength(1);
    const parsedBody = JSON.parse((calls[0] as { init: { body: string } }).init.body);
    expect(parsedBody.messages[0].content.filter((block: { type: string }) => block.type === "image_url")).toHaveLength(2);
  });

  it("returns isError:true (never throws) when the real ffmpeg extraction fails on a bad path", async () => {
    const fetchFn: FetchFn = async () => {
      throw new Error("should not be called");
    };

    const result = await understandVideo("/tmp/opencode/no-such-video.mp4", "Describe this.", 3, { apiKey: "test-key", fetchFn });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Failed to extract frames");
  });
});
