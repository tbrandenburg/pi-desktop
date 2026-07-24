import os from "node:os";
import type { ModelInfo } from "../../shared/events";
import {
  buildModelsRegistry,
  type AppSettingsProviderInput,
  type ModelsLoaders,
  type ModelsRegistry,
} from "./models";

export interface ResolvedPiDefault {
  apiKey: string;
  baseUrl: string;
  model: string;
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
    label: `${providerId}/${model.id}`,
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
 */
export async function listConfiguredModels(
  homeDir: string = os.homedir(),
  cwd: string = process.cwd(),
  appSettings?: AppSettingsProviderInput,
  loaders?: ModelsLoaders,
): Promise<ModelInfo[]> {
  const registry = await buildModelsRegistry(homeDir, cwd, appSettings, loaders);
  const available = await registry.models.getAvailable();

  // Providers are iterated in precedence order (lowest first -- built-ins,
  // then app-settings, then global/project custom; see buildModelsRegistry).
  // pi-ai's built-in catalogs contain thousands of real model ids that can
  // plausibly collide with a user's own custom/app-settings model id, so a
  // plain first-seen dedupe would wrongly show a built-in's label for a
  // user-configured model of the same id. A `Map` keyed by id, written in
  // registration order, keeps the *last* (highest-precedence) provider's
  // label for any id collision instead.
  const byId = new Map<string, ModelInfo>();
  for (const model of available) {
    byId.set(model.id, { id: model.id, label: `${model.provider}/${model.id}` });
  }
  return Array.from(byId.values());
}
