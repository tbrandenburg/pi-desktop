import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import piMultimedia, {
  buildUnderstandAudioTool,
  buildUnderstandVideoTool,
  findModelByNameHint,
  type MinimalExtensionContext,
  type RegistryModel,
} from "./index.js";
import type { FetchFn } from "./audio.js";

interface RegisteredTool {
  name: string;
  execute: (
    toolCallId: string,
    params: { path: string; mode?: "transcribe" | "understand"; prompt?: string },
    signal?: unknown,
    onUpdate?: unknown,
    ctx?: MinimalExtensionContext,
  ) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
}

/** Builds a fake `MinimalExtensionContext` with a registry exposing exactly the given models and a fixed resolved api key. */
function fakeContext(models: RegistryModel[], apiKey = "registry-resolved-key"): MinimalExtensionContext {
  return {
    modelRegistry: {
      getAvailable: () => models,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey }),
    },
  };
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

describe("findModelByNameHint", () => {
  const openaiModel = (id: string, name = id): RegistryModel => ({ id, name, api: "openai-completions", baseUrl: "https://api.openai.com/v1" });
  const anthropicModel = (id: string): RegistryModel => ({ id, name: id, api: "anthropic-messages", baseUrl: "https://api.anthropic.com" });

  it("prefers an exact id match over a substring match", () => {
    const models = [openaiModel("gpt-audio-1.5-preview"), openaiModel("gpt-transcribe")];

    expect(findModelByNameHint(models, "gpt-transcribe")).toBe(models[1]);
  });

  it("falls back to a case-insensitive substring match when no exact match exists", () => {
    const models = [openaiModel("azure/gpt-audio-1.5-2026-08")];

    expect(findModelByNameHint(models, "GPT-AUDIO-1.5")).toBe(models[0]);
  });

  it("excludes models whose api is not openai-completions, even on an exact name match", () => {
    const models = [anthropicModel("gpt-audio-1.5")];

    expect(findModelByNameHint(models, "gpt-audio-1.5")).toBeUndefined();
  });

  it("returns undefined when nothing matches", () => {
    const models = [openaiModel("claude-sonnet-5")];

    expect(findModelByNameHint(models, "gpt-transcribe")).toBeUndefined();
  });

  it("matches a real-world OpenRouter id shorter than the default hint (issue #239)", () => {
    // Real reproduction: OpenRouter's `openai/gpt-audio` vs. this tool's default
    // AUDIO_MODEL hint `gpt-audio-1.5` -- neither is a substring of the other
    // without stripping the `openai/` provider prefix first.
    const models = [openaiModel("openai/gpt-audio")];

    expect(findModelByNameHint(models, "gpt-audio-1.5")).toBe(models[0]);
  });
});

describe("registry-first model resolution (issue #235)", () => {
  it("understand_audio (transcribe mode) uses the registry-matched model id and resolved api key over env vars", async () => {
    const filePath = writeTempWavFile();
    try {
      let calledModel = "";
      let calledAuth = "";
      const fetchFn = (async (_url: string, init: { headers: Record<string, string>; body: FormData }) => {
        calledModel = init.body.get("model") as string;
        calledAuth = init.headers.Authorization;
        return { ok: true, status: 200, statusText: "OK", json: async () => ({ text: "hi" }) };
      }) as unknown as typeof fetch;
      const tool = buildUnderstandAudioTool({ MULTIMEDIA_AUDIO_API_KEY: "env-key-should-be-ignored" }, fetchFn);
      const ctx = fakeContext([
        { id: "gpt-transcribe-2026", name: "gpt-transcribe-2026", api: "openai-completions", baseUrl: "https://registry.example/v1" },
      ]);

      const result = await tool.execute("call-registry-transcribe", { path: filePath }, undefined, undefined, ctx);

      expect(calledModel).toBe("gpt-transcribe-2026");
      expect(calledAuth).toBe("Bearer registry-resolved-key");
      expect(result.isError).toBe(false);
    } finally {
      unlinkSync(filePath);
    }
  });

  it("understand_video uses the registry-matched model and resolved api key over env vars", async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "pi-multimedia-index-video-fixture-"));
    const videoPath = join(fixtureDir, "fixture.mp4");
    execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=160x120:rate=5", videoPath], { stdio: "pipe" });
    try {
      let calledModel = "";
      let calledAuth = "";
      const fetchFn = (async (_url: string, init: { headers: Record<string, string>; body: string }) => {
        const body = JSON.parse(init.body) as { model: string };
        calledModel = body.model;
        calledAuth = init.headers.Authorization;
        return { ok: true, status: 200, statusText: "OK", json: async () => ({ choices: [{ message: { content: "a scene" } }] }) };
      }) as unknown as typeof fetch;
      const tool = buildUnderstandVideoTool({ MULTIMEDIA_VIDEO_API_KEY: "env-key-should-be-ignored" }, fetchFn);
      const ctx = fakeContext([
        { id: "gpt-4o-vision-2026", name: "gpt-4o-vision-2026", api: "openai-completions", baseUrl: "https://registry.example/v1" },
      ]);

      const result = await tool.execute("call-registry-video", { path: videoPath, frameCount: 1 }, undefined, undefined, ctx);

      expect(calledModel).toBe("gpt-4o-vision-2026");
      expect(calledAuth).toBe("Bearer registry-resolved-key");
      expect(result.isError).toBe(false);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it("falls back to env vars when the registry has no matching model", async () => {
    const filePath = writeTempWavFile();
    try {
      let calledAuth = "";
      const fetchFn = (async (_url: string, init: { headers: Record<string, string> }) => {
        calledAuth = init.headers.Authorization;
        return { ok: true, status: 200, statusText: "OK", json: async () => ({ text: "hi" }) };
      }) as unknown as typeof fetch;
      const tool = buildUnderstandAudioTool({ MULTIMEDIA_AUDIO_API_KEY: "env-key" }, fetchFn);
      const ctx = fakeContext([{ id: "claude-sonnet-5", name: "claude-sonnet-5", api: "anthropic-messages", baseUrl: "https://api.anthropic.com" }]);

      await tool.execute("call-fallback", { path: filePath }, undefined, undefined, ctx);

      expect(calledAuth).toBe("Bearer env-key");
    } finally {
      unlinkSync(filePath);
    }
  });

  it("falls back to env vars when no ctx/registry is provided at all", async () => {
    const filePath = writeTempWavFile();
    try {
      let calledAuth = "";
      const fetchFn = (async (_url: string, init: { headers: Record<string, string> }) => {
        calledAuth = init.headers.Authorization;
        return { ok: true, status: 200, statusText: "OK", json: async () => ({ text: "hi" }) };
      }) as unknown as typeof fetch;
      const tool = buildUnderstandAudioTool({ MULTIMEDIA_AUDIO_API_KEY: "env-key" }, fetchFn);

      await tool.execute("call-no-ctx", { path: filePath });

      expect(calledAuth).toBe("Bearer env-key");
    } finally {
      unlinkSync(filePath);
    }
  });
});
