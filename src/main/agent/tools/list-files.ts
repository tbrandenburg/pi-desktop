import fs from "node:fs/promises";
import { Object as TObject, String as TString } from "typebox";
import type { ToolDefinition } from "../coding-agent-loaders";
import { resolveWithinRoot } from "./path-guard";

const parameters = TObject({
  path: TString({ description: "Directory path, relative to the workspace root." }),
});

/**
 * Read-only directory listing tool, adapted to pi-coding-agent's
 * `ToolDefinition` shape (see ADR 0001 §3.3). See `createReadFileTool` for
 * the identical traversal-guard rationale.
 */
export function createListFilesTool(cwd: string): ToolDefinition<typeof parameters> {
  return {
    name: "list_files",
    label: "List Files",
    description: "List files and directories at a path in the current workspace.",
    parameters,
    async execute(_toolCallId, params) {
      const resolved = resolveWithinRoot(cwd, params.path);
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fs.readdir(resolved, { withFileTypes: true });
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error));
      }
      const listing = entries
        .map((entry) => `${entry.isDirectory() ? "d" : "-"} ${entry.name}`)
        .join("\n");
      return {
        content: [{ type: "text", text: listing || "(empty directory)" }],
        details: {
          path: params.path,
          entries: entries.map((entry) => ({
            name: entry.name,
            kind: entry.isDirectory() ? ("directory" as const) : ("file" as const),
          })),
        },
      };
    },
  };
}
