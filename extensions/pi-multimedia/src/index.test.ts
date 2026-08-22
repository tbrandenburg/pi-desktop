import { describe, expect, it } from "vitest";
import { mkdtempSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import piMultimedia, { buildUnderstandAudioTool, buildUnderstandVideoTool } from "./index.js";
import type { FetchFn } from "./audio.js";

interface RegisteredTool {
  name: string;
  execute: (
    toolCallId: string,
    params: { path: string; mode?: "transcribe" | "understand"; prompt?: string },
  ) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
}

/** Writes a minimal but structurally valid WAV file to a temp path and returns its path. */
function writeTempWavFile(): string {
  const sampleCount = 8;
  const buffer = Buffer.alloc(44 + sampleCount * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + sampleCount * 2, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(sampleCount * 2, 40);

  const dir = mkdtempSync(join(tmpdir(), "pi-multimedia-test-"));
  const filePath = join(dir, "clip.wav");
  writeFileSync(filePath, buffer);
  return filePath;
}

function collect(): { tools: RegisteredTool[]; commands: string[] } {
  const tools: RegisteredTool[] = [];
  const commands: string[] = [];
  piMultimedia({
    registerTool: (tool) => tools.push(tool as unknown as RegisteredTool),
    registerCommand: (name) => commands.push(name),
  });
  return { tools, commands };
}

describe("piMultimedia extension factory", () => {
  it("registers exactly the understand_audio and understand_video tools", () => {
    const { tools } = collect();

    expect(tools.map((t) => t.name)).toEqual(["understand_audio", "understand_video"]);
    expect(tools).toHaveLength(2);
  });

  it("registers the multimedia-status signal command", () => {
    const { commands } = collect();

    expect(commands).toEqual(["multimedia-status"]);
    expect(commands).toHaveLength(1);
  });
});

describe("buildUnderstandAudioTool execute()", () => {
  it("returns isError:true for an unreadable/missing file without throwing", async () => {
    const fetchFn: FetchFn = async () => {
      throw new Error("should not be called");
    };
    const tool = buildUnderstandAudioTool({}, fetchFn as unknown as typeof fetch);

    const result = await tool.execute("call-1", { path: "/nonexistent/does-not-exist.wav" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("does-not-exist.wav");
  });

  it("returns isError:true for an unsupported extension before touching the filesystem or network", async () => {
    const fetchFn: FetchFn = async () => {
      throw new Error("should not be called");
    };
    const tool = buildUnderstandAudioTool({}, fetchFn as unknown as typeof fetch);

    const result = await tool.execute("call-2", { path: "clip.ogg" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("ogg");
  });

  it("defaults to mode:'transcribe' and routes through the multipart transcription path", async () => {
    const filePath = writeTempWavFile();
    try {
      let calledUrl = "";
      const fetchFn = (async (url: string) => {
        calledUrl = url;
        return { ok: true, status: 200, statusText: "OK", json: async () => ({ text: "real transcript text" }) };
      }) as unknown as typeof fetch;
      const tool = buildUnderstandAudioTool({}, fetchFn);

      const result = await tool.execute("call-transcribe", { path: filePath });

      expect(calledUrl).toContain("/audio/transcriptions");
      expect(result.content).toEqual([{ type: "text", text: "real transcript text" }]);
    } finally {
      unlinkSync(filePath);
    }
  });

  it("routes mode:'understand' through the chat-completions gpt-audio-1.5 path instead", async () => {
    const filePath = writeTempWavFile();
    try {
      let calledUrl = "";
      const fetchFn = (async (url: string) => {
        calledUrl = url;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ choices: [{ message: { content: "It sounds like a calm melody." } }] }),
        };
      }) as unknown as typeof fetch;
      const tool = buildUnderstandAudioTool({}, fetchFn);

      const result = await tool.execute("call-understand", { path: filePath, mode: "understand", prompt: "Describe the mood." });

      expect(calledUrl).toContain("/chat/completions");
      expect(result.content).toEqual([{ type: "text", text: "It sounds like a calm melody." }]);
    } finally {
      unlinkSync(filePath);
    }
  });
});

describe("buildUnderstandVideoTool execute()", () => {
  it("returns isError:true for a non-existent video file without throwing (real ffmpeg failure)", async () => {
    const fetchFn: FetchFn = async () => {
      throw new Error("should not be called");
    };
    const tool = buildUnderstandVideoTool({}, fetchFn as unknown as typeof fetch);

    const result = await tool.execute("call-3", { path: "/nonexistent/does-not-exist.mp4" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("does-not-exist.mp4");
  });
});
