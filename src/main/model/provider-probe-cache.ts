/**
 * Small TTL cache for Tier 2 provider-reachability probing (issue #175).
 *
 * `scheduleProviderAvailabilitySweep` (`provider-prober.ts`) can be invoked
 * repeatedly in quick succession -- once at app start, and again after any
 * settings/package change that rebuilds the models registry
 * (`buildModelsRegistry`'s call site in `registry.ts`). Without this cache,
 * a settings save shortly after app start would immediately re-probe every
 * one of the ~37 built-in providers again, even though the prior sweep's
 * results are still fresh. This mirrors the existing module-level-cache
 * style already used by `registry-cache.ts`, but time-based (TTL) instead
 * of invalidation-based, since Tier 2 results are inherently time-sensitive
 * (a provider that was down 2 minutes ago may be back up now) rather than
 * purely a function of config inputs.
 *
 * Deliberately NOT wired into the same `invalidateModelsCache()` call sites
 * as `registry-cache.ts` -- a settings/package change doesn't necessarily
 * mean a previously-reachable provider became unreachable, so letting the
 * TTL alone govern re-probing (rather than eagerly invalidating on every
 * config change) keeps this simple and avoids redundant network calls.
 */

/** 90s default TTL: within the issue's suggested 60-120s range. */
const DEFAULT_TTL_MS = 90_000;

const probedAt = new Map<string, number>();

/**
 * Returns true if `providerId` was probed within the last `ttlMs`
 * milliseconds (default 90s), i.e. a new probe can be safely skipped.
 * `now` is injectable for tests; production callers should omit it.
 */
export function isProbeFresh(providerId: string, now: number = Date.now(), ttlMs: number = DEFAULT_TTL_MS): boolean {
  const last = probedAt.get(providerId);
  if (last === undefined) return false;
  return now - last < ttlMs;
}

/**
 * Records that `providerId` was just probed (or a probe for it was just
 * started), starting/refreshing its TTL window. `now` is injectable for
 * tests; production callers should omit it.
 */
export function markProbed(providerId: string, now: number = Date.now()): void {
  probedAt.set(providerId, now);
}

/** Resets all cache entries -- test isolation only. */
export function clearProbeCache(): void {
  probedAt.clear();
}
