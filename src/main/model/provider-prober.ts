/**
 * Starts a background sweep to check reachability of the given providers
 * (Tier 2 of the three-tier model availability signal, issue #175).
 *
 * STUB in this PR -- the real implementation (bounded-concurrency network
 * probes per provider, classifying each as "reachable" / "auth-failed" /
 * "unreachable" via `setProviderReachability` in `model-status.ts`) is a
 * follow-up work package. This stub intentionally does nothing so the call
 * site in `registry.ts` (at the end of `buildModelsRegistry`) is stable for
 * that follow-up to fill in without ever needing to touch `registry.ts`
 * again.
 */
export function scheduleProviderAvailabilitySweep(providerIds: readonly string[]): void {
  // no-op stub -- real implementation lands in a follow-up PR (issue #175 Tier 2).
  void providerIds;
}
