import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ResolvedPiDefault {
  apiKey: string;
  baseUrl: string;
  model: string;
  label: string;
}

interface PiAgentSettings {
  defaultProvider?: string;
  defaultModel?: string;
}

interface PiAuthEntry {
  type?: string;
  key?: string;
}

interface PiCustomProvider {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  models?: Array<{ id?: string }>;
}

interface PiModelsConfig {
  providers?: Record<string, PiCustomProvider>;
}

// Base URLs for well-known OpenAI-compatible providers that store a plain
// API key in auth.json. Only providers we can actually call through the
// openai-completions API belong here.
const KNOWN_PROVIDER_BASE_URLS: Record<string, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  openai: "https://api.openai.com/v1",
};

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

function resolveApiKeyValue(raw: string): string {
  // models.json may reference an env var, e.g. "$LLM7_TOKEN".
  if (!raw.startsWith("$")) return raw;
  return process.env[raw.slice(1)] ?? "";
}

function resolveFromKnownProvider(
  provider: string,
  model: string | undefined,
  authDir: string,
): ResolvedPiDefault | null {
  const baseUrl = KNOWN_PROVIDER_BASE_URLS[provider];
  if (!baseUrl) return null;

  const auth = readJson<Record<string, PiAuthEntry>>(path.join(authDir, "auth.json"));
  const entry = auth?.[provider];
  if (!entry || entry.type !== "api_key" || !entry.key) return null;

  return {
    apiKey: entry.key,
    baseUrl,
    model: model || "",
    label: `${provider}/${model ?? ""}`,
  };
}

function resolveFromCustomProviders(
  agentDir: string,
  preferredProvider?: string,
  preferredModel?: string,
): ResolvedPiDefault | null {
  const modelsConfig = readJson<PiModelsConfig>(path.join(agentDir, "models.json"));
  const providers = modelsConfig?.providers;
  if (!providers) return null;

  const entries = Object.entries(providers);
  const ordered = preferredProvider
    ? entries.sort(([name]) => (name === preferredProvider ? -1 : 1))
    : entries;

  for (const [name, provider] of ordered) {
    if (provider.api !== "openai-completions" || !provider.baseUrl) continue;
    const apiKey = provider.apiKey ? resolveApiKeyValue(provider.apiKey) : "";
    if (!apiKey) continue;
    const modelIds = provider.models?.map((m) => m.id).filter((id): id is string => !!id) ?? [];
    if (modelIds.length === 0) continue;
    // Prefer the configured default model when this is the provider it
    // belongs to and the model is actually listed; otherwise fall back to
    // the provider's first model.
    const modelId =
      name === preferredProvider && preferredModel && modelIds.includes(preferredModel)
        ? preferredModel
        : modelIds[0];
    return {
      apiKey,
      baseUrl: provider.baseUrl,
      model: modelId,
      label: `${name}/${modelId}`,
    };
  }
  return null;
}

/**
 * Resolves a ready-to-use default provider/model from the user's existing
 * `.pi/agent` configuration (the same config used by the Pi CLI/agent),
 * so the desktop app can start chatting on first launch without requiring
 * a manual API key entry. Returns null if nothing usable is found.
 */
export function resolvePiDefault(homeDir: string = os.homedir()): ResolvedPiDefault | null {
  const agentDir = path.join(homeDir, ".pi", "agent");
  const settings = readJson<PiAgentSettings>(path.join(agentDir, "settings.json"));

  if (settings?.defaultProvider) {
    const knownDefault = resolveFromKnownProvider(
      settings.defaultProvider,
      settings.defaultModel,
      agentDir,
    );
    if (knownDefault?.apiKey && knownDefault.model) return knownDefault;

    const customDefault = resolveFromCustomProviders(
      agentDir,
      settings.defaultProvider,
      settings.defaultModel,
    );
    if (customDefault) return customDefault;
  }

  return resolveFromCustomProviders(agentDir);
}
