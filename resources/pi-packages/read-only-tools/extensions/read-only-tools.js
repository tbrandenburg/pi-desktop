"use strict";

/**
 * First-party pi-package (ADR 0001 §3.5, issue #97) bundling pi-desktop's
 * own read-only `read_file`/`list_files` tools as a real `pi.registerTool`
 * extension -- loaded by pi-coding-agent's own extension loader (jiti)
 * exactly like any third-party pi-package would be, via
 * `DefaultResourceLoader`'s `additionalExtensionPaths` (see
 * `src/main/agent/runtime.ts`). This is the *sole* implementation of these
 * two tools: the pre-#97 `src/main/agent/tools/` `customTools` adapter was
 * removed once this real package-discovery pipeline was proven to work
 * end-to-end, per issue #97's "replace, don't duplicate" instruction.
 *
 * Deliberately dependency-free (no `typebox`/other npm imports): the
 * `parameters` schema below is hand-written as the exact same plain JSON
 * Schema shape typebox's `Object`/`String` builders produce at runtime (see
 * `docs/adr/0001-reuse-pi-extension-mechanism.md` §3.5's "peer deps
 * provided by the host, not bundled per-package" note -- this file avoids
 * even needing that peer dependency, since `extraResources` copies this
 * directory outside the app's own `node_modules`/asar tree, where plain
 * Node module resolution for a bare `require("typebox")` specifier is not
 * guaranteed to succeed).
 *
 * Confined to the *session's* `ctx.cwd` (not a path baked in at package
 * load time) via `resolveWithinRoot` below -- `ExtensionContext.cwd` is
 * supplied fresh by pi-coding-agent on every tool `execute()` call, so this
 * single bundled package instance correctly scopes itself to whatever
 * workspace directory the running session was opened against.
 */

const fs = require("node:fs/promises");
const path = require("node:path");

function resolveWithinRoot(root, userPath) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(resolvedRoot, userPath);
  const isWithinRoot = resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep);
  if (!isWithinRoot) {
    throw new Error(`Path escapes the workspace root: ${userPath}`);
  }
  return resolvedTarget;
}

const readFileTool = {
  name: "read_file",
  label: "Read File",
  description: "Read the full text contents of a file in the current workspace.",
  parameters: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string", description: "File path, relative to the workspace root." },
    },
  },
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const resolved = resolveWithinRoot(ctx.cwd, params.path);
    let text;
    try {
      text = await fs.readFile(resolved, "utf8");
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
    return {
      content: [{ type: "text", text }],
      details: { path: params.path },
    };
  },
};

const listFilesTool = {
  name: "list_files",
  label: "List Files",
  description: "List files and directories at a path in the current workspace.",
  parameters: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string", description: "Directory path, relative to the workspace root." },
    },
  },
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const resolved = resolveWithinRoot(ctx.cwd, params.path);
    let entries;
    try {
      entries = await fs.readdir(resolved, { withFileTypes: true });
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
    const listing = entries.map((entry) => `${entry.isDirectory() ? "d" : "-"} ${entry.name}`).join("\n");
    return {
      content: [{ type: "text", text: listing || "(empty directory)" }],
      details: {
        path: params.path,
        entries: entries.map((entry) => ({
          name: entry.name,
          kind: entry.isDirectory() ? "directory" : "file",
        })),
      },
    };
  },
};

/**
 * Real extension entry point -- jiti loads this module and calls its
 * default export with the `ExtensionAPI` object (`pi.registerTool(...)`,
 * see pi-coding-agent's `dist/core/extensions/loader.js`).
 */
module.exports = function registerReadOnlyTools(pi) {
  pi.registerTool(readFileTool);
  pi.registerTool(listFilesTool);
};
