import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import { createReadFileTool } from "./read-file";
import { createListFilesTool } from "./list-files";

export { createReadFileTool } from "./read-file";
export { createListFilesTool } from "./list-files";

/**
 * Read-only tool set exposed to the agent harness. Deliberately excludes
 * write/edit/bash tools -- out of scope for issue #41 (see its Scope
 * Boundaries section).
 */
export function createReadOnlyTools(env: ExecutionEnv) {
  return [createReadFileTool(env), createListFilesTool(env)];
}
