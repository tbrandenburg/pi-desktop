import os from "node:os";
import path from "node:path";
import type { MutableModels } from "@earendil-works/pi-ai";

import { nativeDynamicImport } from "../native-import";
import { AuthJsonCredentialStore } from "./pi-agent-dir";
import { setProviderReachability } from "./model-status";
import { isProbeFresh, markProbed } from "./provider-probe-cache";
import type { ProviderReachability } from "../../shared/events";

/**
 * Starts a background sweep to check reachability of the given providers
 * (Tier 2 of the three-tier model availability signal, issue #175).
 *
 * ## Design decision: what "one cheap authenticated call" means here
 *
 * The issue's ideal design is "one cheap authenticated request per
 * provider, classified 200/401-403/timeout-5xx". `@earendil-works/pi-ai`'s
 * `Models`/`Provider` public API (`node_modules/@earendil-works/pi-ai/dist/
 * models.d.ts`) does not expose a generic per-provider "make one minimal
 * authenticated call" primitive: `Provider.stream()` requires a full model +
 * context (not "cheap"), and `checkAuth()` is documented as checking local
 * auth completeness "without refreshing OAuth" (no network). There is also
 * no generic `baseUrl`-based health endpoint shared across all 37 built-in
 * catalogs to hand-roll a raw HTTP call against (would require per-provider
 * hardcoded URLs, exactly what the issue says would not scale/violates DRY).
 *
 * The one real primitive pi-ai DOES expose that (a) is provider-generic,
 * (b) is inherently a *classified* operation, and (c) already involves a
 * real network round-trip for OAuth-credentialed providers is
 * `Models.getAuth(providerId)`:
 *  - No credential resolvable at all -> resolves `undefined`. Zero network
 *    cost, and definitely not usable -- classified `auth-failed` directly,
 *    mirroring the issue's own explicitly-endorsed simplification ("no
 *    credential means definitely not usable, no need to hit the network").
 *  - A stored OAuth credential -> `getAuth` performs a real refresh network
 *    call if the access token is expired/near-expiry (pi-ai's own OAuth
 *    resolution flow), and rejects with `ModelsError` code `"oauth"` if that
 *    refresh fails against the real provider -- this is a genuine
 *    classified network outcome, not a local-only check.
 *  - Rejects with code `"auth"` for a locally-invalid credential (e.g.
 *    malformed api key resolution) -> classified `auth-failed`.
 *  - Resolves a valid `AuthResult` -> classified `reachable`.
 *  - Any other rejection (generic network error, our own timeout abort,
 *    `"provider"`/`"stream"`/`"model_source"`/`"model_validation"` codes)
 *    -> classified `unreachable`.
 *
 * This is a deliberate, documented simplification versus a literal
 * "hit the real chat/completions endpoint" probe: it verifies credential
 * validity (and, for OAuth providers, a real round-trip to the provider's
 * token endpoint) but does NOT prove the provider's actual model-serving
 * endpoint is reachable for API-key-only providers (the majority of the 37
 * built-in catalogs use static api keys with no refresh call, so those
 * providers' `"reachable"` classification only proves "we have what looks
 * like a usable key locally", not a real round trip). This is the
 * `{ ok, status }`-style injectable escape hatch the issue explicitly
 * allows for exactly this situation -- see `ProviderProbeFn` below,
 * `defaultProbe`'s exact behavior is documented (and unit-tested) rather
 * than silently assumed correct for all 37 providers.
 */

export type ProviderProbeResult = Exclude<ProviderReachability, "checking">;

/** Injectable per-provider probe seam -- see the module doc comment above for why. */
export type ProviderProbeFn = (providerId: string, signal: AbortSignal) => Promise<ProviderProbeResult>;

interface PiAiCreateModels {
  createModels: (options?: { credentials?: AuthJsonCredentialStore }) => MutableModels;
}
interface BuiltinProvidersModule {
  builtinProviders: () => Array<{ id: string; [key: string]: unknown }>;
}

async function loadPiAi(): Promise<PiAiCreateModels> {
  return (await nativeDynamicImport("@earendil-works/pi-ai")) as unknown as PiAiCreateModels;
}
async function loadBuiltinProviders(): Promise<BuiltinProvidersModule> {
  return (await nativeDynamicImport("@earendil-works/pi-ai/providers/all")) as unknown as BuiltinProvidersModule;
}

/**
 * Lazily builds (once per process) a `MutableModels` registered with every
 * built-in provider catalog and a real `AuthJsonCredentialStore`, purely so
 * `defaultProbe` can call `models.getAuth(providerId)`. This deliberately
 * does NOT reuse `registry.ts`'s full `buildModelsRegistry` (custom
 * `models.json`/extension/app-settings providers, ~2.3-2.6s extension
 * activation pass) -- the prober only needs the same built-in-catalog +
 * auth-resolution machinery `pi-config.ts` already uses, not the full
 * registry assembly. `registry.ts` is not imported here to avoid a circular
 * import (it already imports this module for the sweep call site).
 */
let probeModelsPromise: Promise<MutableModels> | null = null;
function getProbeModels(): Promise<MutableModels> {
  if (!probeModelsPromise) {
    probeModelsPromise = (async () => {
      const [{ createModels }, { builtinProviders }] = await Promise.all([loadPiAi(), loadBuiltinProviders()]);
      const globalDir = path.join(os.homedir(), ".pi", "agent");
      const projectDir = path.join(process.cwd(), ".pi", "agent");
      const models = createModels({ credentials: new AuthJsonCredentialStore(globalDir, projectDir) });
      for (const provider of builtinProviders()) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        models.setProvider(provider as any);
      }
      return models;
    })();
  }
  return probeModelsPromise;
}

/**
 * Real default probe -- see the module doc comment for exactly what this
 * does and does not verify. `Models.getAuth` has no `AbortSignal` parameter
 * (see `AuthResolutionOverrides` in pi-ai's own types), so the ~5s bound is
 * enforced by `probeOne`'s `Promise.race` below, not by threading `signal`
 * into `getAuth` itself -- a timed-out OAuth refresh call may keep running
 * in the background after we've already classified it `unreachable`, but
 * never blocks the sweep past the timeout.
 */
const defaultProbe: ProviderProbeFn = async (providerId) => {
  const models = await getProbeModels();
  try {
    const auth = await models.getAuth(providerId);
    return auth ? "reachable" : "auth-failed";
  } catch (error) {
    const code = (error as { code?: string } | undefined)?.code;
    return code === "auth" || code === "oauth" ? "auth-failed" : "unreachable";
  }
};

const PROBE_TIMEOUT_MS = 5_000;
const MAX_CONCURRENCY = 8;

async function probeOne(providerId: string, probe: ProviderProbeFn): Promise<void> {
  markProbed(providerId);
  setProviderReachability(providerId, "checking");

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), PROBE_TIMEOUT_MS);
  const timeoutPromise = new Promise<ProviderProbeResult>((resolve) => {
    abortController.signal.addEventListener("abort", () => resolve("unreachable"));
  });
  try {
    const result = await Promise.race([probe(providerId, abortController.signal), timeoutPromise]);
    setProviderReachability(providerId, result);
  } catch {
    // A probe implementation that itself throws unexpectedly (rather than
    // resolving a classified outcome) must still leave the provider in a
    // terminal state, never stuck at "checking" forever.
    setProviderReachability(providerId, "unreachable");
  } finally {
    clearTimeout(timeout);
  }
}

/** Hand-rolled worker-pool concurrency limiter -- see AGENTS.md's YAGNI/KISS guidance; no new dependency for an 8-wide queue. */
async function runWithConcurrencyLimit(items: readonly string[], limit: number, probe: ProviderProbeFn): Promise<void> {
  let index = 0;
  async function worker(): Promise<void> {
    while (index < items.length) {
      const providerId = items[index++];
      await probeOne(providerId, probe);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
}

/**
 * Starts a background sweep to check reachability of the given providers
 * (Tier 2 of the three-tier model availability signal, issue #175). Fire-
 * and-forget: returns synchronously, the sweep itself runs asynchronously.
 *
 * Providers whose cache entry (`provider-probe-cache.ts`) is still fresh
 * (default 90s TTL) are skipped entirely -- repeated calls (e.g. a settings
 * save shortly after app start) don't pile up redundant re-probes.
 * Concurrency is capped at 8 in-flight probes; each probe is individually
 * bounded to ~5s via `AbortController`.
 *
 * `probe` is an injectable override for tests (defaults to `defaultProbe`,
 * the real `Models.getAuth`-based implementation documented above).
 */
export function scheduleProviderAvailabilitySweep(
  providerIds: readonly string[],
  probe: ProviderProbeFn = defaultProbe,
): void {
  if (providerIds.length === 0) return;

  const due = providerIds.filter((id) => !isProbeFresh(id));
  if (due.length === 0) return;

  void runWithConcurrencyLimit(due, MAX_CONCURRENCY, probe);
}
