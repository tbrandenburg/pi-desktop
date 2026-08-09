import type { ModelInfo } from "../../shared/events";

/**
 * In-process cache for `listConfiguredModels()`'s result (issue #166 part
 * A). `model:list` previously rebuilt the whole registry -- including the
 * ~2.3-2.6s `extensionProviderSource` extension-activation pass -- on every
 * single IPC call, even when nothing had changed since the last call.
 *
 * Keyed by a fingerprint of the inputs that actually affect the built
 * result (`homeDir`, `cwd`, and the app-settings fields that feed
 * `appSettingsProviderOptions`) -- a cache hit returns the exact same
 * `ModelInfo[]` instantly, with zero rebuild.
 *
 * Deliberately NOT time-based: no TTL/timer expiry. The cache is only ever
 * invalidated explicitly, by calling `invalidateModelsCache()` after a real
 * change that could affect the result -- currently `settings:save` and the
 * three `packages:*` mutation handlers in `ipc.ts`. A stale cache is only
 * possible if some other real config-changing path forgets to invalidate;
 * that's a bug to fix at the call site, not something a timer should paper
 * over.
 */
let cached: { key: string; models: ModelInfo[] } | null = null;

function fingerprint(homeDir: string, cwd: string, appSettings?: { apiKey: string; baseUrl: string; model: string }): string {
  return JSON.stringify([homeDir, cwd, appSettings ?? null]);
}

/**
 * Returns the cached model list for this exact input fingerprint, if any
 * was previously stored via `setCachedModels`. `undefined` means "not
 * cached (or invalidated) -- caller must rebuild".
 */
export function getCachedModels(
  homeDir: string,
  cwd: string,
  appSettings?: { apiKey: string; baseUrl: string; model: string },
): ModelInfo[] | undefined {
  const key = fingerprint(homeDir, cwd, appSettings);
  return cached && cached.key === key ? cached.models : undefined;
}

export function setCachedModels(
  homeDir: string,
  cwd: string,
  appSettings: { apiKey: string; baseUrl: string; model: string } | undefined,
  models: ModelInfo[],
): void {
  cached = { key: fingerprint(homeDir, cwd, appSettings), models };
}

/** Drops any cached result -- call after any real config change (see doc comment above). */
export function invalidateModelsCache(): void {
  cached = null;
}
