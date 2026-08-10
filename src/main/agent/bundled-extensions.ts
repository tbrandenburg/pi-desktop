import fs from "node:fs";
import path from "node:path";

/**
 * Everything this module needs to know about the *Electron runtime* to
 * resolve where pi-desktop's own bundled extensions live.
 *
 * `app.isPackaged` / `process.resourcesPath` are real-Electron-runtime-only
 * APIs, so — exactly like the removed `resolvePiPackagesReadOnlyToolsDir`
 * did before it (issue #97, removed by #132) — that resolution is injected
 * from `src/main/ipc.ts` (the real Electron entry point) instead of being
 * imported here. This module must stay loadable under plain Vitest/Node,
 * where no real `electron` module exists.
 */
export interface BundledExtensionsEnv {
  /** `app.isPackaged`. */
  isPackaged: boolean;
  /** `process.resourcesPath` — only meaningful when `isPackaged` is true. */
  resourcesPath?: string;
  /** Repo root in dev mode; defaults to the process cwd. */
  repoRoot?: string;
}

/** Directory name `electron-builder.yml`'s `extraResources` maps `extensions/` to. */
export const PACKAGED_EXTENSIONS_DIRNAME = "pi-extensions";

/** Source directory of the first-party extensions workspace in dev mode. */
export const DEV_EXTENSIONS_DIRNAME = "extensions";

/**
 * Resolves the directory holding pi-desktop's own first-party extension
 * packages: `<process.resourcesPath>/pi-extensions` once packaged
 * (`electron-builder.yml`'s `extraResources` only applies to the packaged
 * app), `<repo>/extensions` in dev mode. Returns `undefined` when that
 * directory doesn't exist, so callers can treat bundled extensions as
 * strictly optional (they must never be load-bearing for basic chat).
 */
export function resolveBundledExtensionsDir(env: BundledExtensionsEnv): string | undefined {
  const dir = env.isPackaged
    ? env.resourcesPath
      ? path.join(env.resourcesPath, PACKAGED_EXTENSIONS_DIRNAME)
      : undefined
    : path.join(env.repoRoot ?? process.cwd(), DEV_EXTENSIONS_DIRNAME);
  if (!dir) return undefined;
  try {
    return fs.statSync(dir).isDirectory() ? dir : undefined;
  } catch {
    return undefined;
  }
}

interface PiManifest {
  pi?: { extensions?: unknown };
}

/**
 * Enumerates the immediate subdirectories of `dir` that are real pi
 * packages (a `package.json` declaring a `pi.extensions` manifest) and
 * returns the absolute path of every manifest-declared entry file that
 * actually exists on disk.
 *
 * The returned array is what gets fed to `DefaultResourceLoader`'s
 * `additionalExtensionPaths` option. Both a package *directory* and an
 * *entry file* are accepted by pi-coding-agent's own
 * `packageManager.resolveExtensionSources()` (verified empirically against
 * the real `@earendil-works/pi-coding-agent` build, not from reading its
 * source); entry files are used here because they are explicit — a
 * directory without a `pi.extensions` manifest is silently treated as a
 * single extension file by the library, which would load unrelated
 * subdirectories that merely happen to sit next to a real package.
 *
 * One broken/unreadable package must never prevent the others from
 * loading, so every per-subdirectory failure is swallowed individually
 * (same rule `extensionProviderSource` already documents for third-party
 * packages).
 */
export function listBundledExtensionPaths(dir: string | undefined): string[] {
  if (!dir) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const paths: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pkgDir = path.join(dir, entry.name);
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")) as PiManifest;
      const declared = manifest.pi?.extensions;
      if (!Array.isArray(declared)) continue;
      for (const rel of declared) {
        if (typeof rel !== "string") continue;
        const abs = path.resolve(pkgDir, rel);
        if (fs.existsSync(abs)) paths.push(abs);
      }
    } catch {
      // Missing/unparseable package.json, unreadable directory, ...: skip
      // this one package only.
      continue;
    }
  }
  return paths;
}

/** Convenience: `listBundledExtensionPaths(resolveBundledExtensionsDir(env))`. */
export function resolveBundledExtensionPaths(env: BundledExtensionsEnv): string[] {
  return listBundledExtensionPaths(resolveBundledExtensionsDir(env));
}
