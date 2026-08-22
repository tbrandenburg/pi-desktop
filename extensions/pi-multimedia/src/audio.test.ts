import { describe, expect, it } from "vitest";
import {
  AUDIO_MODEL,
  buildAudioRequest,
  detectAudioFormat,
  extractResponseText,
  understandAudioViaApi,
  UnsupportedAudioFormatError,
  type FetchFn,
} from "./audio.js";

/**
 * Builds a tiny synthetic (but structurally valid) WAV file byte buffer:
 * a 44-byte RIFF/WAVE header followed by a handful of silent PCM samples.
 * This is enough to exercise real base64 encoding without any external
 * fixture download.
 */
function buildSyntheticWavBase64(): string {
  const sampleCount = 8;
  const bytesPerSample = 2;
  const dataSize = sampleCount * bytesPerSample;
  const buffer = new Uint8Array(44 + dataSize);
  const view = new DataView(buffer.buffer);
  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) buffer[offset + i] = value.charCodeAt(i);
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, 8000, true); // sample rate
  view.setUint32(28, 16000, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, dataSize, true);
  // Remaining bytes are already zero-initialized (silence).

  return Buffer.from(buffer).toString("base64");
}

describe("detectAudioFormat", () => {
  it("maps known extensions to the API's accepted format strings", () => {
    expect(detectAudioFormat("clip.wav")).toBe("wav");
    expect(detectAudioFormat("clip.mp3")).toBe("mp3");
    expect(detectAudioFormat("/abs/path/clip.m4a")).toBe("mp3");
  });

  it("throws UnsupportedAudioFormatError for unknown or missing extensions", () => {
    expect(() => detectAudioFormat("clip.ogg")).toThrow(UnsupportedAudioFormatError);
    expect(() => detectAudioFormat("clip")).toThrow(UnsupportedAudioFormatError);
  });
});

describe("buildAudioRequest", () => {
  it("builds the exact gpt-audio-1.5 chat-completions request shape from a real wav buffer", () => {
    const base64 = buildSyntheticWavBase64();
    const request = buildAudioRequest(base64, "wav", "Describe this clip.");

    expect(request.model).toBe(AUDIO_MODEL);
    expect(request.modalities).toEqual(["text"]);
    expect(request.messages).toHaveLength(1);
  });

  it("nests the text prompt and input_audio blocks with the real base64 payload", () => {
    const base64 = buildSyntheticWavBase64();
    const request = buildAudioRequest(base64, "mp3", "What is said?");

    const [message] = request.messages;
    expect(message.content).toEqual([
      { type: "text", text: "What is said?" },
      { type: "input_audio", input_audio: { data: base64, format: "mp3" } },
    ]);
    expect(message.content[1].input_audio.data.length).toBeGreaterThan(0);
  });
});

describe("extractResponseText", () => {
  it("prefers the message content field when present", () => {
    const text = extractResponseText({ choices: [{ message: { content: " a transcript " } }] });
    expect(text).toBe("a transcript");
  });

  it("falls back to the audio transcript field when content is absent", () => {
    const text = extractResponseText({ choices: [{ message: { audio: { transcript: "spoken words" } } }] });
    expect(text).toBe("spoken words");
    expect(text.length).toBeGreaterThan(0);
  });

  it("throws when neither content nor transcript is present", () => {
    expect(() => extractResponseText({ choices: [{ message: {} }] })).toThrow();
    expect(() => extractResponseText({})).toThrow();
  });
});

describe("understandAudioViaApi", () => {
  const base64 = buildSyntheticWavBase64();

  it("returns a non-error TextContent result from a successful mocked response", async () => {
    const calls: unknown[] = [];
    const fetchFn: FetchFn = async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ choices: [{ message: { content: "This is a beep tone." } }] }),
      };
    };

    const result = await understandAudioViaApi(base64, "wav", "Describe this.", {
      apiKey: "test-key",
      fetchFn,
    });

    expect(result).toEqual({ isError: false, content: [{ type: "text", text: "This is a beep tone." }] });
    expect(calls).toHaveLength(1);
  });

  it("sends the Authorization header and JSON body built from buildAudioRequest", async () => {
    let capturedInit: { headers: Record<string, string>; body: string } | undefined;
    const fetchFn: FetchFn = async (_url, init) => {
      capturedInit = init;
      return { ok: true, status: 200, statusText: "OK", json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
    };

    await understandAudioViaApi(base64, "wav", "hi", { apiKey: "sk-abc", fetchFn });

    expect(capturedInit?.headers.Authorization).toBe("Bearer sk-abc");
    const parsedBody = JSON.parse(capturedInit?.body ?? "{}");
    expect(parsedBody.messages[0].content[1].input_audio.format).toBe("wav");
  });

  it("returns isError:true with a helpful message on network failure instead of throwing", async () => {
    const fetchFn: FetchFn = async () => {
      throw new Error("ECONNREFUSED");
    };

    const result = await understandAudioViaApi(base64, "wav", "hi", { apiKey: "test-key", fetchFn });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("ECONNREFUSED");
  });

  it("returns isError:true on a non-ok HTTP response instead of throwing", async () => {
    const fetchFn: FetchFn = async () => ({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      json: async () => ({}),
    });

    const result = await understandAudioViaApi(base64, "wav", "hi", { apiKey: "test-key", fetchFn });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("429");
  });

  it("returns isError:true when the response body cannot be parsed into text", async () => {
    const fetchFn: FetchFn = async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ choices: [] }),
    });

    const result = await understandAudioViaApi(base64, "wav", "hi", { apiKey: "test-key", fetchFn });

    expect(result.isError).toBe(true);
    expect(result.content[0].text.length).toBeGreaterThan(0);
  });
});
