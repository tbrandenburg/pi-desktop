import { Object as TObject, String as TString } from "typebox";
import type { AgentTool, ExecutionEnv } from "@earendil-works/pi-agent-core";
import { assertPathWithinRoot } from "./path-guard";

const parameters = TObject({
  path: TString({ description: "Directory path, relative to the workspace root." }),
});

/**
 * Read-only directory listing tool. Uses `env.listDir` so listing stays
 * confined to whatever workspace directory the `ExecutionEnv` was
 * constructed with (see `createReadFileTool` for the identical rationale).
 * `assertPathWithinRoot` additionally rejects any path (relative traversal
 * or absolute) that would resolve outside `env.cwd`.
 */
export function createListFilesTool(env: ExecutionEnv): AgentTool<typeof parameters> {
  return {
    name: "list_files",
    label: "List Files",
    description: "List files and directories at a path in the current workspace.",
    parameters,
    async execute(_toolCallId, params) {
      assertPathWithinRoot(env.cwd, params.path);
      const result = await env.listDir(params.path);
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      const listing = result.value
        .map((entry) => `${entry.kind === "directory" ? "d" : "-"} ${entry.name}`)
        .join("\n");
      return {
        content: [{ type: "text", text: listing || "(empty directory)" }],
        details: { path: params.path, entries: result.value },
      };
    },
  };
}
