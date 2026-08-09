/**
 * Hardcoded ids of `pi-free` dynamic-fetch providers that are known to
 * register 0 models whenever no API key/credential is configured, per
 * issue #172 (follow-up UX polish from #168's diagnosis).
 *
 * There is currently no generic, upstream signal in `pi-ai`'s refresh
 * result to distinguish "skipped, no credential" from "attempted and
 * failed" (tracked upstream at earendil-works/pi#7854, still unresolved).
 * Until that lands, this list must be maintained by hand rather than
 * derived generically -- see the full 12-provider enumeration and root
 * cause in apmantza/pi-free#421, and the concrete "only fastrouter/cline
 * populate by default" observation already documented in this repo's
 * `src/main/model/registry.ts` (issue #165) and `registry.test.ts`.
 *
 * This is intentionally scoped to the renderer only (pure UX hint, no
 * functional fix) -- the model registry in `src/main/model` is untouched.
 */
export const CREDENTIAL_GATED_PROVIDER_IDS: readonly string[] = [
  "kilo",
  "zenmux",
  "crofai",
  "deepinfra",
  "sambanova",
  "novita",
  "stepfun",
  "routeway",
  "tokenrouter",
  "anyapi",
  "bai",
  "openmodel",
];

/** Hint text shown for a known credential-gated provider with 0 models. */
export const CREDENTIAL_GATED_HINT = "requires an API key (not configured)";

/**
 * Given the currently-known qualified model ids (each `"provider/modelId"`,
 * see `src/main/model/registry.ts`'s `qualifyModelId`), returns the known
 * credential-gated provider ids that have contributed zero models so far.
 */
export function missingCredentialGatedProviders(modelIds: readonly string[]): string[] {
  const populatedProviderIds = new Set(modelIds.map((id) => id.split("/")[0]));
  return CREDENTIAL_GATED_PROVIDER_IDS.filter((providerId) => !populatedProviderIds.has(providerId));
}
