import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createReadFileTool } from "./read-file";
import { createListFilesTool } from "./list-files";
import { createReadOnlyTools } from "./index";
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

  it("read_file exposes exact registration metadata for the harness", async () => {
    const { NodeExecutionEnv } = await realAgentCoreLoaders.loadAgentCoreNode!();
    const env = new NodeExecutionEnv({ cwd });
    const tool = createReadFileTool(env);

    expect(tool.name).toBe("read_file");
    expect(tool.label).toBe("Read File");
    expect(tool.description).toBe("Read the full text contents of a file in the current workspace.");
    expect((tool.parameters as { properties: { path: { description?: string } } }).properties.path.description).toBe(
      "Directory path, relative to the workspace root.",
    );
  });

  it("read_file rejects a relative path-traversal attempt outside the workspace root", async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-outside-"));
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), "top secret");
    const traversal = path.relative(cwd, path.join(outsideDir, "secret.txt"));
    const { NodeExecutionEnv } = await realAgentCoreLoaders.loadAgentCoreNode!();
    const env = new NodeExecutionEnv({ cwd });
    const tool = createReadFileTool(env);

    await expect(tool.execute("call-traversal", { path: traversal })).rejects.toThrow(
      /escapes the workspace root/i,
    );
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it("read_file rejects an absolute path outside the workspace root", async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-outside-"));
    const secretPath = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(secretPath, "top secret");
    const { NodeExecutionEnv } = await realAgentCoreLoaders.loadAgentCoreNode!();
    const env = new NodeExecutionEnv({ cwd });
    const tool = createReadFileTool(env);

    await expect(tool.execute("call-absolute", { path: secretPath })).rejects.toThrow(
      /escapes the workspace root/i,
    );
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it("read_file still reads a legitimate nested in-workspace path", async () => {
    const { NodeExecutionEnv } = await realAgentCoreLoaders.loadAgentCoreNode!();
    const env = new NodeExecutionEnv({ cwd });
    const tool = createReadFileTool(env);

    const result = await tool.execute("call-nested", { path: path.join("sub", "nested.txt") });

    expect(result.content).toEqual([{ type: "text", text: "nested" }]);
    expect(result.details).toEqual({ path: path.join("sub", "nested.txt") });
  });

  it("list_files returns the exact real directory entries with exact `kind`-prefixed, newline-joined formatting", async () => {
    const { NodeExecutionEnv } = await realAgentCoreLoaders.loadAgentCoreNode!();
    const env = new NodeExecutionEnv({ cwd });
    const tool = createListFilesTool(env);

    const result = await tool.execute("call-3", { path: "." });

    expect(result.content).toEqual([{ type: "text", text: "- hello.txt\nd sub" }]);
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

  it("list_files throws with a real not-found error for a missing directory", async () => {
    const { NodeExecutionEnv } = await realAgentCoreLoaders.loadAgentCoreNode!();
    const env = new NodeExecutionEnv({ cwd });
    const tool = createListFilesTool(env);

    const call = tool.execute("call-5", { path: "does-not-exist" });

    await expect(call).rejects.toBeInstanceOf(Error);
    await expect(call).rejects.toThrow(/ENOENT|not found|does-not-exist/i);
  });

  it("list_files exposes exact registration metadata for the harness", async () => {
    const { NodeExecutionEnv } = await realAgentCoreLoaders.loadAgentCoreNode!();
    const env = new NodeExecutionEnv({ cwd });
    const tool = createListFilesTool(env);

    expect(tool.name).toBe("list_files");
    expect(tool.label).toBe("List Files");
    expect(tool.description).toBe("List files and directories at a path in the current workspace.");
    expect((tool.parameters as { properties: { path: { description?: string } } }).properties.path.description).toBe(
      "Directory path, relative to the workspace root.",
    );
  });

  it("list_files rejects a relative path-traversal attempt outside the workspace root", async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-outside-"));
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), "top secret");
    const traversal = path.relative(cwd, outsideDir);
    const { NodeExecutionEnv } = await realAgentCoreLoaders.loadAgentCoreNode!();
    const env = new NodeExecutionEnv({ cwd });
    const tool = createListFilesTool(env);

    await expect(tool.execute("call-traversal", { path: traversal })).rejects.toThrow(
      /escapes the workspace root/i,
    );
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it("list_files rejects an absolute path outside the workspace root", async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-outside-"));
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), "top secret");
    const { NodeExecutionEnv } = await realAgentCoreLoaders.loadAgentCoreNode!();
    const env = new NodeExecutionEnv({ cwd });
    const tool = createListFilesTool(env);

    await expect(tool.execute("call-absolute", { path: outsideDir })).rejects.toThrow(
      /escapes the workspace root/i,
    );
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it("list_files still lists a legitimate nested in-workspace path", async () => {
    const { NodeExecutionEnv } = await realAgentCoreLoaders.loadAgentCoreNode!();
    const env = new NodeExecutionEnv({ cwd });
    const tool = createListFilesTool(env);

    const result = await tool.execute("call-nested", { path: "sub" });

    expect(result.content).toEqual([{ type: "text", text: "- nested.txt" }]);
  });
});

describe("createReadOnlyTools", () => {
  it("wires up exactly the read_file and list_files tools, in that order", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-tools-index-"));
    const { NodeExecutionEnv } = await realAgentCoreLoaders.loadAgentCoreNode!();
    const env = new NodeExecutionEnv({ cwd });

    const tools = createReadOnlyTools(env);

    expect(tools).toHaveLength(2);
    expect(tools.map((tool) => tool.name)).toEqual(["read_file", "list_files"]);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});