import { describe, expect, it } from "vitest";
import piMultimedia, { buildUnderstandAudioTool, buildUnderstandVideoTool } from "./index.js";
import type { FetchFn } from "./audio.js";

interface RegisteredTool {
  name: string;
  execute: (
    toolCallId: string,
    params: { path: string; prompt?: string },
  ) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
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
