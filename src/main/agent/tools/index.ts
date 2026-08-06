import type { ToolDefinition } from "../coding-agent-loaders";
import { createReadFileTool } from "./read-file";
import { createListFilesTool } from "./list-files";

export { createReadFileTool } from "./read-file";
export { createListFilesTool } from "./list-files";

/**
 * Read-only tool set exposed to the agent session as `customTools`.
 * Deliberately excludes write/edit/bash tools -- out of scope for issue
 * #41's original read-only decision, preserved unchanged by the Phase 1
 * runtime swap (issue #90).
 */
export function createReadOnlyTools(cwd: string): ToolDefinition[] {
  return [createReadFileTool(cwd), createListFilesTool(cwd)];
}
