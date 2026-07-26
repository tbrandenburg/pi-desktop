import path from "node:path";

/**
 * Confines `userPath` to `root` (the workspace root the `ExecutionEnv` was
 * constructed with), rejecting relative traversal (`..`) or absolute paths
 * that would resolve outside of it. Returns the resolved absolute path
 * unused by callers -- they still pass the original `userPath` on to
 * `env.readTextFile`/`env.listDir`, this function only validates it.
 *
 * Throws a plain `Error` on rejection, which the tools' existing
 * `execute()` error handling already surfaces to the agent/UI.
 */
export function assertPathWithinRoot(root: string, userPath: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(resolvedRoot, userPath);
  const isWithinRoot = resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep);
  if (!isWithinRoot) {
    throw new Error(`Path escapes the workspace root: ${userPath}`);
  }
}
