import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { workspaceDirSchema } from "../shared/schemas";

/**
 * Parses an optional launch-directory positional argument (e.g.
 * `pi-desktop .`) out of `process.argv`, resolving relative paths against
 * the real launch `cwd` (meaningful here, unlike the persisted-settings
 * default workspace dir -- see `settings/store.ts`).
 *
 * Electron's argv shape differs between dev and packaged launches:
 * - dev (`electron .`): `[electronBinary, mainEntryPoint, ...userArgs]`
 * - packaged (AppImage/exe): `[appBinary, ...userArgs]`
 *
 * Returns `undefined` (never throws) if no argument was given, or if the
 * given argument does not resolve to an existing directory -- callers
 * should fall back to existing default behavior in that case.
 */
export function resolveLaunchDirectoryArg(argv: string[], isPackaged: boolean, cwd: string): string | undefined {
  const offset = isPackaged ? 1 : 2;
  const arg = argv[offset];
  if (!arg) return undefined;

  const resolved = resolve(cwd, arg);
  const parsed = workspaceDirSchema.safeParse(resolved);
  if (!parsed.success) {
    console.warn(`[cli-args] Ignoring invalid workspace directory argument "${arg}": ${parsed.error.message}`);
    return undefined;
  }

  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    console.warn(`[cli-args] Ignoring workspace directory argument "${arg}": not an existing directory.`);
    return undefined;
  }

  return resolved;
}
