import os from "node:os";
import type { ModelInfo } from "../../shared/events";
import {
  buildModelsRegistry,
  qualifyModelId,
  asBareModelId,
  type AppSettingsProviderInput,
  type ModelsLoaders,
  type ModelsRegistry,
} from "./registry";
import type { MutableModels } from "@earendil-works/pi-ai";

/**
 * Tier 1 of the three-tier model availability signal (issue #175/#179): a
 * richer classification of a provider's current credential state than a
 * single boolean, since "not configured" (`Boolean(auth?.auth.apiKey)`)
 * used to collapse at least four genuinely different, actionable states
 * into one identical glyph in the picker:
 *
 *  - `"configured"` -- resolved auth with a real `apiKey` string (the old
 *    `true` case).
 *  - `"free"` -- resolved auth with no `apiKey` and not sourced via OAuth,
 *    i.e. a provider that needs no credential at all (e.g. `llm7`).
 *  - `"oauth"` -- resolved auth sourced via OAuth (`AuthResult.source ===
 *    "OAuth"`, pi-ai's own label for this -- see `resolve.d.ts`'s
 *    `AuthResult.source` doc comment) with a currently-valid session.
 *  - `"missing"` -- no credential resolvable at all (`auth` is
 *    `undefined`) -- the old `false` case for "never configured".
 *  - `"auth-error"` -- `getAuth()` rejected specifically with a
 *    `ModelsError`-shaped `"auth"`/`"oauth"` error code (e.g. a suspended
 *    GitHub account's OAuth token-refresh call itself failing with 403).
 *    Duck-typed via `(err as { code?: string }).code` rather than a real
 *    `instanceof ModelsError` check, deliberately avoiding a runtime value
 *    import of `@earendil-works/pi-ai` from this module (this file only
 *    ever type-imports from pi-ai; a real import here would need to
 *    survive tsc's CommonJS downlevel of the package's ESM exports, which
 *    is the exact hazard class documented in this repo's AGENTS.md
 *    "diagnosing bugs that only reproduce in the packaged app" #1/#4).
 *
 * Memoized per distinct `providerId` via the caller-supplied `cache` --
 * there can be 1000+ models across only ~37 providers, so `models.getAuth()`
 * must be called at most once per provider, never once per model.
 *
 * Any *other* rejection (no recognizable auth/oauth error code) is still
 * treated as `"missing"` rather than propagated, for the same reason as
 * before: this is called once per distinct provider inside `Promise.all` in
 * `toModelInfos`, so an uncaught rejection here would fail the *entire*
 * model list -- including every other, unrelated, perfectly healthy
 * provider (verified against a real `github-copilot` suspension in
 * production).
 */
export type CredentialState = "free" | "configured" | "oauth" | "missing" | "auth-error";

export async function isProviderConfigured(
  models: MutableModels,
  providerId: string,
  cache: Map<string, Promise<CredentialState>>,
): Promise<CredentialState> {
  let pending = cache.get(providerId);
  if (!pending) {
    pending = models
      .getAuth(providerId)
      .then((auth): CredentialState => {
        if (!auth) return "missing";
        if (auth.auth.apiKey) return "configured";
        if (auth.source === "OAuth") return "oauth";
        return "free";
      })
      .catch((err: unknown): CredentialState => {
        const code = (err as { code?: string } | null | undefined)?.code;
        return code === "auth" || code === "oauth" ? "auth-error" : "missing";
      });
    cache.set(providerId, pending);
  }
  return pending;
}

/**
 * Maps a provider's `getAvailable()` result to the renderer-facing
 * `ModelInfo[]` shape. Extracted so both `listConfiguredModels`'s final
 * result and its optional progressive partial callback (issue #167 part C)
 * share exactly one mapping implementation -- never duplicated.
 */
async function toModelInfos(
  models: MutableModels,
  available: Awaited<ReturnType<MutableModels["getAvailable"]>>,
  configuredCache: Map<string, Promise<CredentialState>>,
): Promise<ModelInfo[]> {
  return Promise.all(
    available.map(async (model) => {
      const credentialState = await isProviderConfigured(models, model.provider, configuredCache);
      return {
        id: qualifyModelId(model.provider, asBareModelId(model.id)),
        label: `${model.provider}/${model.id}`,
        providerId: model.provider,
        // Derived boolean kept for any caller still checking plain
        // "usable right now" -- `credentialState` is the source of truth
        // for the picker's richer glyphs (issue #179).
        configured: credentialState !== "missing" && credentialState !== "auth-error",
        credentialState,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxTokens,
      };
    }),
  );
}

export interface ResolvedPiDefault {
  apiKey: string;
  baseUrl: string;
  /** Bare model id (not qualified with a provider prefix). */
  model: string;
  /** Fully-qualified `provider/modelId` -- see `qualifyModelId`. */
  label: string;
}

async function resolveFromRegistry(
  registry: ModelsRegistry,
  providerId: string,
  modelId: string | undefined,
): Promise<ResolvedPiDefault | null> {
  const provider = registry.models.getProvider(providerId);
  if (!provider) return null;

  const providerModels = provider.getModels();
  const model = (modelId && providerModels.find((m) => m.id === modelId)) || providerModels[0];
  if (!model) return null;

  const auth = await registry.models.getAuth(providerId);
  if (!auth?.auth.apiKey) return null;

  return {
    apiKey: auth.auth.apiKey,
    baseUrl: model.baseUrl,
    model: model.id,
    label: qualifyModelId(providerId, asBareModelId(model.id)),
  };
}

/**
 * Resolves a ready-to-use default provider/model from the user's existing
 * `.pi/agent` configuration (the same config used by the Pi CLI/agent),
 * so the desktop app can start chatting on first launch without requiring
 * a manual API key entry. Returns null if nothing usable is found.
 *
 * Mirrors the Pi CLI's precedence: a project-local `<cwd>/.pi/agent`
 * (e.g. a repo checked out with its own `.pi/agent/settings.json`) takes
 * priority over the global `~/.pi/agent`.
 */
export async function resolvePiDefault(
  homeDir: string = os.homedir(),
  cwd: string = process.cwd(),
  loaders?: ModelsLoaders,
): Promise<ResolvedPiDefault | null> {
  const registry = await buildModelsRegistry(homeDir, cwd, undefined, loaders);

  if (registry.defaultProviderId) {
    const resolved = await resolveFromRegistry(
      registry,
      registry.defaultProviderId,
      registry.defaultModelId,
    );
    if (resolved) return resolved;
  }

  // No usable configured default: fall back to the first available
  // (auth-configured) model from any provider.
  const available = await registry.models.getAvailable();
  const first = available[0];
  if (!first) return null;
  return resolveFromRegistry(registry, first.provider, first.id);
}

/**
 * Lists every model available from the currently configured providers:
 * the app's own `settings.json` (if given), the global `~/.pi/agent`, and
 * the project-local `<cwd>/.pi/agent` -- so the model picker shows every
 * model the user can actually reach with credentials they already have,
 * including a model configured purely through the app's own Settings UI
 * with no `.pi/agent` config present at all.
 *
 * `ModelInfo.id` is the fully-qualified `provider/modelId` (see
 * `qualifyModelId`), not the bare model id -- required for correctness
 * once pi-ai's built-in catalogs are registered, since bare model ids are
 * *not* unique across providers (e.g. "gpt-5.6-luna" ships identically
 * from six different built-in providers).
 */
export async function listConfiguredModels(
  homeDir: string = os.homedir(),
  cwd: string = process.cwd(),
  appSettings?: AppSettingsProviderInput,
  loaders?: ModelsLoaders,
  /**
   * Optional progressive callback (issue #167 part C): invoked with an
   * early, partial `ModelInfo[]` snapshot every time one more provider
   * source resolves, ahead of this function's own final, authoritative
   * return value -- lets a caller (`ipc.ts`'s `model:list` handler) push
   * incremental updates to the renderer during a slow, cold (uncached)
   * call instead of blocking on the single slowest source. Never changes
   * this function's final return value in any way.
   */
  onPartialModels?: (models: ModelInfo[]) => void,
): Promise<ModelInfo[]> {
  // Shared across both the progressive partial callback and the final
  // result below, so `models.getAuth()` is still called at most once per
  // distinct provider across this whole `listConfiguredModels` call, not
  // once per partial snapshot.
  const configuredCache = new Map<string, Promise<CredentialState>>();
  const registry = await buildModelsRegistry(
    homeDir,
    cwd,
    appSettings,
    loaders,
    onPartialModels
      ? (models) => {
          void models
            .getAvailable()
            .then((available) => toModelInfos(models, available, configuredCache))
            .then(onPartialModels);
        }
      : undefined,
  );
  const available = await registry.models.getAvailable();

  return toModelInfos(registry.models, available, configuredCache);
}
