import os from "node:os";
import type { ModelInfo } from "../../shared/events";
import {
  buildModelsRegistry,
  qualifyModelId,
  type AppSettingsProviderInput,
  type ModelsLoaders,
  type ModelsRegistry,
} from "./models";

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
    label: qualifyModelId(providerId, model.id),
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
): Promise<ModelInfo[]> {
  const registry = await buildModelsRegistry(homeDir, cwd, appSettings, loaders);
  const available = await registry.models.getAvailable();

  return available.map((model) => ({
    id: qualifyModelId(model.provider, model.id),
    label: `${model.provider}/${model.id}`,
  }));
}
