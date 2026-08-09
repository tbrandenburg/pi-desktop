import type { ModelInfo, ModelVerification, ProviderReachability } from "../../shared/events";

/**
 * In-process, in-memory status store for the three-tier model availability
 * signal (issue #175). Tier 1 ("configured") is computed synchronously at
 * registry-build time (see `registry.ts`/`pi-config.ts`) and is NOT stored
 * here. This module holds only the two tiers that are learned *after* the
 * registry is built:
 *
 *  - Tier 2 (`reachability`): a background provider-reachability probe,
 *    keyed by `providerId`. Populated by a follow-up "prober" work package
 *    (see `provider-prober.ts`'s stub) -- this module only stores/reads the
 *    result, it never performs the probing itself.
 *  - Tier 3 (`verified`): "has this exact model actually been used
 *    successfully/unsuccessfully", keyed by the fully-qualified `modelId`
 *    (`provider/modelId`, see `registry.ts`'s `qualifyModelId`). Populated
 *    by a follow-up "recorder" work package that hooks into a real chat
 *    completion/error in `src/main/agent/runtime.ts` -- this module is not
 *    that call site, only the shared store both a recorder and the
 *    renderer-facing read path depend on.
 *
 * Deliberately in-memory only (no persistence) -- Tier 2 is inherently
 * ephemeral/re-probed every app run, and the issue explicitly calls
 * in-memory "acceptable for v1" for Tier 3. Plain module-level `Map`s, no
 * external dependencies, mirroring the existing simple module-level-cache
 * style already used by `registry-cache.ts`.
 */

const reachabilityByProvider = new Map<string, ProviderReachability>();
const verificationByModel = new Map<string, ModelVerification>();

/**
 * Describes what changed in a single `setProviderReachability`/
 * `setModelVerification` call, so `onStatusChange` listeners can react to
 * only the field that actually changed instead of re-reading everything.
 * Exactly one of `providerId`/`modelId` is set per change.
 */
export interface StatusChange {
  providerId?: string;
  modelId?: string;
}

export type StatusChangeListener = (change: StatusChange) => void;

const listeners = new Set<StatusChangeListener>();

function notify(change: StatusChange): void {
  for (const listener of listeners) listener(change);
}

/** Tier 2: records the current reachability probe result for a provider. */
export function setProviderReachability(providerId: string, status: ProviderReachability): void {
  reachabilityByProvider.set(providerId, status);
  notify({ providerId });
}

/** Tier 2: reads the last known reachability for a provider, if any probe has run. */
export function getProviderReachability(providerId: string): ProviderReachability | undefined {
  return reachabilityByProvider.get(providerId);
}

/**
 * Tier 3: records that a specific fully-qualified model was just used for a
 * real chat completion, and whether it succeeded. `now` is injectable for
 * tests; production callers should omit it (defaults to `Date.now()`).
 */
export function setModelVerification(modelId: string, result: "ok" | "error", now: number = Date.now()): void {
  verificationByModel.set(modelId, { lastVerifiedAt: now, lastResult: result });
  notify({ modelId });
}

/** Tier 3: reads the last known verification for a fully-qualified model id, if it's ever been used. */
export function getModelVerification(modelId: string): ModelVerification | undefined {
  return verificationByModel.get(modelId);
}

/**
 * Merges any known Tier 2/Tier 3 status onto a `ModelInfo[]` list, without
 * touching `configured` (Tier 1 -- computed separately at registry-build
 * time, not stored here). A model with no known reachability/verification
 * is returned unchanged (no `reachability`/`verified` key added), so this
 * is always safe to call even before any probe/verification has ever run.
 */
export function applyStatus(models: ModelInfo[]): ModelInfo[] {
  return models.map((model) => {
    const reachability = reachabilityByProvider.get(model.providerId);
    const verified = verificationByModel.get(model.id);
    if (reachability === undefined && verified === undefined) return model;
    return {
      ...model,
      ...(reachability !== undefined ? { reachability } : {}),
      ...(verified !== undefined ? { verified } : {}),
    };
  });
}

/**
 * Subscribes to every Tier 2/Tier 3 status change, so a caller (e.g.
 * `ipc.ts`) can push updated `ModelInfo[]` deltas to the renderer over the
 * existing `model:list-updated` channel. Returns an unsubscribe function.
 *
 * NOTE for follow-up work packages (issue #175 Tier 2/Tier 3): this store
 * only tracks the change itself (`providerId`/`modelId`), not a full,
 * reconstructable `ModelInfo` for the affected id(s) -- the caller needs
 * its own last-known-full-`ModelInfo` index (e.g. built from `model:list`'s
 * own results) to turn a bare change notification into a valid partial
 * push payload. See `ipc.ts`'s `model:list` handler for where that wiring
 * should be added.
 */
export function onStatusChange(listener: StatusChangeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Resets all stored status AND all subscribed listeners -- test isolation only, must be called in every test file's `beforeEach` that touches this module. */
export function clearAllStatus(): void {
  reachabilityByProvider.clear();
  verificationByModel.clear();
  listeners.clear();
}
