import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

// Requires the *actual* bundled pi-package extension entry file directly
// (plain CommonJS, real `require`, no mocking) -- this is the sole real
// implementation of `read_file`/`list_files` post-issue-#97 (the old
// `src/main/agent/tools/` `customTools` adapter was deleted once this real
// package-discovery pipeline was proven to work, see `runtime.ts`/
// `runtime.test.ts`). Proves the extension module's own tool logic
// (path-guard + real fs reads) in isolation from the extension-loading
// pipeline; `runtime.test.ts`'s "bundled pi-package" tests separately prove
// the *discovery* half (that pi-coding-agent's own `additionalExtensionPaths`
// mechanism actually finds and loads this exact file).
const EXTENSION_PATH = path.resolve(
  __dirname,
  "../../../resources/pi-packages/read-only-tools/extensions/read-only-tools.js",
);

type RegisteredTools = Map<string, ToolDefinition>;

function loadRegisteredTools(): RegisteredTools {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const factory = require(EXTENSION_PATH) as (pi: { registerTool(tool: ToolDefinition): void }) => void;
  const tools: RegisteredTools = new Map();
  factory({
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
  });
  return tools;
}

function ctxWithCwd(cwd: string): ExtensionContext {
  return { cwd } as ExtensionContext;
}

describe("bundled read-only-tools pi-package extension module (real fs, real disk)", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-pkg-tools-"));
    fs.writeFileSync(path.join(cwd, "hello.txt"), "hello world");
    fs.mkdirSync(path.join(cwd, "sub"));
    fs.writeFileSync(path.join(cwd, "sub", "nested.txt"), "nested");
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("registers exactly read_file and list_files, in that order, via pi.registerTool", () => {
    const tools = loadRegisteredTools();

    expect(Array.from(tools.keys())).toEqual(["read_file", "list_files"]);
    expect(tools.size).toBe(2);
  });

  it("read_file reads real file contents using ctx.cwd (not a baked-in cwd)", async () => {
    const tools = loadRegisteredTools();
    const readFile = tools.get("read_file")!;

    const result = await readFile.execute("call-1", { path: "hello.txt" }, undefined, undefined, ctxWithCwd(cwd));

    expect(result.content).toEqual([{ type: "text", text: "hello world" }]);
    expect(result.details).toEqual({ path: "hello.txt" });
  });

  it("read_file rejects a real path-traversal attempt outside ctx.cwd", async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-pkg-outside-"));
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), "top secret");
    const traversal = path.relative(cwd, path.join(outsideDir, "secret.txt"));
    const tools = loadRegisteredTools();
    const readFile = tools.get("read_file")!;

    await expect(
      readFile.execute("call-2", { path: traversal }, undefined, undefined, ctxWithCwd(cwd)),
    ).rejects.toThrow(/escapes the workspace root/i);
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it("read_file throws a real not-found error for a missing file", async () => {
    const tools = loadRegisteredTools();
    const readFile = tools.get("read_file")!;

    await expect(
      readFile.execute("call-3", { path: "missing.txt" }, undefined, undefined, ctxWithCwd(cwd)),
    ).rejects.toThrow();
  });

  it("list_files lists real directory entries with exact kind-prefixed formatting", async () => {
    const tools = loadRegisteredTools();
    const listFiles = tools.get("list_files")!;

    const result = await listFiles.execute("call-4", { path: "." }, undefined, undefined, ctxWithCwd(cwd));

    expect(result.content).toEqual([{ type: "text", text: "- hello.txt\nd sub" }]);
    const details = result.details as { entries: { name: string; kind: string }[] };
    expect(details.entries.map((e) => e.name).sort()).toEqual(["hello.txt", "sub"]);
  });

  it("list_files scopes to a *different* ctx.cwd on a second call -- proves no cwd is baked in at load time", async () => {
    const otherCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-pkg-other-"));
    fs.writeFileSync(path.join(otherCwd, "only-here.txt"), "x");
    const tools = loadRegisteredTools();
    const listFiles = tools.get("list_files")!;

    const firstResult = await listFiles.execute("call-5a", { path: "." }, undefined, undefined, ctxWithCwd(cwd));
    const secondResult = await listFiles.execute(
      "call-5b",
      { path: "." },
      undefined,
      undefined,
      ctxWithCwd(otherCwd),
    );

    expect(firstResult.content).toEqual([{ type: "text", text: "- hello.txt\nd sub" }]);
    expect(secondResult.content).toEqual([{ type: "text", text: "- only-here.txt" }]);
    fs.rmSync(otherCwd, { recursive: true, force: true });
  });

  it("list_files rejects a real path-traversal attempt outside ctx.cwd", async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-pkg-outside2-"));
    const traversal = path.relative(cwd, outsideDir);
    const tools = loadRegisteredTools();
    const listFiles = tools.get("list_files")!;

    await expect(
      listFiles.execute("call-6", { path: traversal }, undefined, undefined, ctxWithCwd(cwd)),
    ).rejects.toThrow(/escapes the workspace root/i);
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });
});
