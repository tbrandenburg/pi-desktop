import { Object as TObject, String as TString } from "typebox";
import type { AgentTool, ExecutionEnv } from "@earendil-works/pi-agent-core";
import { assertPathWithinRoot } from "./path-guard";

const parameters = TObject({
  path: TString({ description: "Directory path, relative to the workspace root." }),
});

/**
 * Read-only file tool. Reads through the harness's injected `ExecutionEnv`
 * (`env.readTextFile`), never raw `node:fs`, so file access stays confined
 * to whatever workspace directory the environment was constructed with.
 * `assertPathWithinRoot` additionally rejects any path (relative traversal
 * or absolute) that would resolve outside `env.cwd`, since the underlying
 * `NodeExecutionEnv` performs no such confinement itself.
 */
export function createReadFileTool(env: ExecutionEnv): AgentTool<typeof parameters> {
  return {
    name: "read_file",
    label: "Read File",
    description: "Read the full text contents of a file in the current workspace.",
    parameters,
    async execute(_toolCallId, params) {
      assertPathWithinRoot(env.cwd, params.path);
      const result = await env.readTextFile(params.path);
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return {
        content: [{ type: "text", text: result.value }],
        details: { path: params.path },
      };
    },
  };
}
