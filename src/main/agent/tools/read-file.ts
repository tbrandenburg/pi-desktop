import fs from "node:fs/promises";
import { Object as TObject, String as TString } from "typebox";
import type { ToolDefinition } from "../coding-agent-loaders";
import { resolveWithinRoot } from "./path-guard";

const parameters = TObject({
  path: TString({ description: "File path, relative to the workspace root." }),
});

/**
 * Read-only file tool, adapted to pi-coding-agent's `ToolDefinition` shape
 * (see ADR 0001 §3.3). Confined to `cwd` via `resolveWithinRoot` -- the same
 * traversal guard the pre-Phase-1 `AgentTool`-based version used, just
 * reading through plain `node:fs/promises` instead of an injected
 * `ExecutionEnv` (pi-coding-agent's own built-in tools take the same
 * `cwd: string` + raw `fs` approach; see `dist/core/tools/index.d.ts`).
 */
export function createReadFileTool(cwd: string): ToolDefinition<typeof parameters> {
  return {
    name: "read_file",
    label: "Read File",
    description: "Read the full text contents of a file in the current workspace.",
    parameters,
    async execute(_toolCallId, params) {
      const resolved = resolveWithinRoot(cwd, params.path);
      let text: string;
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
}
