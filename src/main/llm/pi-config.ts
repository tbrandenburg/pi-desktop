import os from "node:os";
import type { ModelInfo } from "../../shared/events";
import { buildModelsRegistry, type ModelsLoaders, type ModelsRegistry } from "./models";

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
 * Lists every model available from the currently configured `.pi/agent`
 * providers (project-local `<cwd>/.pi/agent` first, then the global
 * `~/.pi/agent`), so the model picker only ever shows models the user can
 * actually reach with the credentials they already have -- no hardcoded
 * placeholder models.
 */
export async function listConfiguredModels(
  homeDir: string = os.homedir(),
  cwd: string = process.cwd(),
  loaders?: ModelsLoaders,
): Promise<ModelInfo[]> {
  const registry = await buildModelsRegistry(homeDir, cwd, undefined, loaders);
  const available = await registry.models.getAvailable();

  const seen = new Set<string>();
  const models: ModelInfo[] = [];
  for (const model of available) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    models.push({ id: model.id, label: `${model.provider}/${model.id}` });
  }
  return models;
}
