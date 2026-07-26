import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createReadFileTool } from "./read-file";
import { createListFilesTool } from "./list-files";
import { realAgentCoreLoaders } from "../test-support/real-agent-core-loaders";

describe("read-only tools (real NodeExecutionEnv, real disk)", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-tools-"));
    fs.writeFileSync(path.join(cwd, "hello.txt"), "hello world");
    fs.mkdirSync(path.join(cwd, "sub"));
    fs.writeFileSync(path.join(cwd, "sub", "nested.txt"), "nested");
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("read_file returns the exact real file contents", async () => {
    const { NodeExecutionEnv } = await realAgentCoreLoaders.loadAgentCoreNode!();
    const env = new NodeExecutionEnv({ cwd });
    const tool = createReadFileTool(env);

    const result = await tool.execute("call-1", { path: "hello.txt" });

    expect(result.content).toEqual([{ type: "text", text: "hello world" }]);
    expect(result.details).toEqual({ path: "hello.txt" });
  });

  it("read_file throws with a real not-found error for a missing file", async () => {
    const { NodeExecutionEnv } = await realAgentCoreLoaders.loadAgentCoreNode!();
    const env = new NodeExecutionEnv({ cwd });
    const tool = createReadFileTool(env);

    await expect(tool.execute("call-2", { path: "missing.txt" })).rejects.toThrow();
  });

  it("list_files returns the exact real directory entries", async () => {
    const { NodeExecutionEnv } = await realAgentCoreLoaders.loadAgentCoreNode!();
    const env = new NodeExecutionEnv({ cwd });
    const tool = createListFilesTool(env);

    const result = await tool.execute("call-3", { path: "." });

    expect(result.content[0].type).toBe("text");
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("hello.txt") });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("sub") });
    const details = result.details as { entries: { name: string; kind: string }[] };
    expect(details.entries.map((e) => e.name).sort()).toEqual(["hello.txt", "sub"]);
  });

  it("list_files reports an empty directory distinctly from a missing one", async () => {
    fs.mkdirSync(path.join(cwd, "empty-dir"));
    const { NodeExecutionEnv } = await realAgentCoreLoaders.loadAgentCoreNode!();
    const env = new NodeExecutionEnv({ cwd });
    const tool = createListFilesTool(env);

    const result = await tool.execute("call-4", { path: "empty-dir" });

    expect(result.content).toEqual([{ type: "text", text: "(empty directory)" }]);
  });
});
