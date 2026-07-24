import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  Api,
  Credential,
  CredentialInfo,
  CredentialStore,
  CreateProviderOptions,
  Model,
  MutableModels,
  Provider,
  ProviderStreams,
} from "@earendil-works/pi-ai";

// pi-ai ships ESM-only and only exposes its subpaths through an "import"
// condition (no "require" condition). Under tsconfig.main.json's
// "module": "CommonJS", tsc silently downlevels a literal `await import(x)`
// into `require(x)`, which throws only once the app is packaged (never in
// plain-TS unit tests or `npm run dev`). Hiding the call from tsc's static
// downlevel transform via `new Function(...)` forces a genuine native
// `import()` at runtime. See chat-service.ts for the original instance of
// this workaround.
const nativeDynamicImport: (specifier: string) => Promise<unknown> = new Function(
  "specifier",
  "return import(specifier);",
) as (specifier: string) => Promise<unknown>;

export interface PiAiModule {
  createModels: (...args: Parameters<typeof import("@earendil-works/pi-ai").createModels>) => MutableModels;
  createProvider: typeof import("@earendil-works/pi-ai").createProvider;
}

let piAiModule: PiAiModule | null = null;
async function defaultLoadPiAi(): Promise<PiAiModule> {
  if (!piAiModule) {
    piAiModule = (await nativeDynamicImport("@earendil-works/pi-ai")) as unknown as PiAiModule;
  }
  return piAiModule;
}

// Every pi-ai API implementation module exports exactly `stream`/`streamSimple`
// (the `ProviderStreams` shape), keyed here by the `api` string used in
// models.json / our own settings. Extend this map to support more APIs.
const API_MODULE_SPECIFIERS: Record<string, string> = {
  "openai-completions": "@earendil-works/pi-ai/api/openai-completions",
  "anthropic-messages": "@earendil-works/pi-ai/api/anthropic-messages",
  "google-generative-ai": "@earendil-works/pi-ai/api/google-generative-ai",
};

const apiModuleCache = new Map<string, Promise<ProviderStreams>>();
function defaultLoadApiModule(api: string): Promise<ProviderStreams> {
  const specifier = API_MODULE_SPECIFIERS[api];
  if (!specifier) {
    return Promise.reject(new Error(`Unsupported pi-ai API: "${api}"`));
  }
  let modulePromise = apiModuleCache.get(api);
  if (!modulePromise) {
    modulePromise = nativeDynamicImport(specifier) as Promise<ProviderStreams>;
    apiModuleCache.set(api, modulePromise);
  }
  return modulePromise;
}

export interface BuiltinProvidersModule {
  builtinProviders: () => Provider[];
}

const builtinProvidersSpecifier = "@earendil-works/pi-ai/providers/all";
let builtinProvidersModule: Promise<BuiltinProvidersModule> | null = null;
function defaultLoadBuiltinProviders(): Promise<BuiltinProvidersModule> {
  if (!builtinProvidersModule) {
    builtinProvidersModule = nativeDynamicImport(
      builtinProvidersSpecifier,
    ) as Promise<BuiltinProvidersModule>;
  }
  return builtinProvidersModule;
}

/**
 * Injectable pi-ai loaders. Production code relies on the defaults above
 * (real dynamic import). Because that import is deliberately hidden from
 * static analysis (see `nativeDynamicImport`), it is also invisible to
 * vi.mock's module interception -- and Vitest's default vm-based pool
 * additionally has no `importModuleDynamically` callback wired for
 * `new Function(...)`-constructed code, so the real loader cannot run
 * inside unit tests at all. Tests inject these directly instead, importing
 * the real `@earendil-works/pi-ai` package the normal (static) way at the
 * top of the test file, which Vitest's own ESM-aware transform handles
 * fine.
 */
export interface ModelsLoaders {
  loadPiAi?: () => Promise<PiAiModule>;
  loadApiModule?: (api: string) => Promise<ProviderStreams>;
  loadBuiltinProviders?: () => Promise<BuiltinProvidersModule>;
}

interface AgentSettingsFile {
  defaultProvider?: string;
  defaultModel?: string;
}

interface AgentModelConfig {
  id?: string;
}

interface AgentProviderConfig {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  models?: AgentModelConfig[];
}

interface AgentModelsFile {
  providers?: Record<string, AgentProviderConfig>;
}

interface AuthJsonEntry {
  type?: string;
  key?: string;
  refresh?: string;
  access?: string;
  expires?: number;
  [key: string]: unknown;
}

type AuthJsonFile = Record<string, AuthJsonEntry>;

function toCredential(entry: AuthJsonEntry | undefined): Credential | undefined {
  if (!entry) return undefined;
  if (entry.type === "api_key" && entry.key) {
    return { type: "api_key", key: entry.key };
  }
  if (entry.type === "oauth" && entry.refresh && entry.access && typeof entry.expires === "number") {
    return { type: "oauth", refresh: entry.refresh, access: entry.access, expires: entry.expires };
  }
  return undefined;
}

/**
 * Reads credentials from `.pi/agent/auth.json` (the same file the Pi
 * CLI/agent writes), project-local overriding global per provider id -- the
 * same precedence as `models.json`/`settings.json`. This is what lets a
 * pi-ai built-in provider (e.g. "openrouter") that has no `models.json`
 * entry at all still resolve real auth, exactly like the CLI.
 *
 * Read-mostly: `modify()`/`delete()` only update the in-memory view (used by
 * pi-ai's own OAuth refresh flow during a live request) and are never
 * persisted back to `auth.json` -- this app has no login/logout UI of its
 * own, so a refreshed token only lives for the current process lifetime.
 */
class AuthJsonCredentialStore implements CredentialStore {
  private overrides = new Map<string, Credential | null>();

  constructor(
    private readonly globalDir: string,
    private readonly projectDir: string,
  ) {}

  private fromDisk(providerId: string): Credential | undefined {
    const project = readJson<AuthJsonFile>(path.join(this.projectDir, "auth.json"));
    const projectCredential = toCredential(project?.[providerId]);
    if (projectCredential) return projectCredential;

    const global = readJson<AuthJsonFile>(path.join(this.globalDir, "auth.json"));
    return toCredential(global?.[providerId]);
  }

  async read(providerId: string): Promise<Credential | undefined> {
    if (this.overrides.has(providerId)) {
      return this.overrides.get(providerId) ?? undefined;
    }
    return this.fromDisk(providerId);
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const merged = new Map<string, Credential>();
    for (const dir of [this.globalDir, this.projectDir]) {
      const file = readJson<AuthJsonFile>(path.join(dir, "auth.json")) ?? {};
      for (const [providerId, entry] of Object.entries(file)) {
        const credential = toCredential(entry);
        if (credential) merged.set(providerId, credential);
      }
    }
    for (const [providerId, credential] of this.overrides) {
      if (credential) merged.set(providerId, credential);
      else merged.delete(providerId);
    }
    return Array.from(merged.entries()).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const current = await this.read(providerId);
    const next = await fn(current);
    this.overrides.set(providerId, next ?? null);
    return next;
  }

  async delete(providerId: string): Promise<void> {
    this.overrides.set(providerId, null);
  }
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

// models.json may reference an env var for a static key, e.g. "$LLM7_TOKEN".
// The `!command` form used elsewhere in the Pi CLI is out of scope here.
function resolveApiKeyValue(raw: string): string {
  if (!raw.startsWith("$")) return raw;
  return process.env[raw.slice(1)] ?? "";
}

function placeholderModel(id: string, provider: string, api: Api, baseUrl: string): Model<Api> {
  // Custom (user-configured) providers only ever declare an id/baseUrl/api in
  // models.json -- no cost/context-window/reasoning metadata. Only pi-ai's
  // baked-in catalog (`MODELS`) carries that for known providers; there is
  // nothing to look up for a user's own endpoint, so placeholder metadata is
  // used, same as the Pi CLI does for custom providers.
  return {
    id,
    name: id,
    api,
    provider,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
  };
}

async function toProviderOptions(
  id: string,
  cfg: AgentProviderConfig,
  loadApiModule: (api: string) => Promise<ProviderStreams>,
): Promise<CreateProviderOptions | null> {
  if (!cfg.api || !cfg.baseUrl) return null;
  const modelIds = (cfg.models ?? [])
    .map((m) => m.id)
    .filter((modelId): modelId is string => Boolean(modelId));
  if (modelIds.length === 0) return null;

  const apiKey = cfg.apiKey ? resolveApiKeyValue(cfg.apiKey) : "";
  if (!apiKey) return null;

  const api = cfg.api;
  const streams = await loadApiModule(api);
  const baseUrl = cfg.baseUrl;

  return {
    id,
    baseUrl,
    auth: {
      apiKey: {
        name: id,
        resolve: async () => ({ auth: { apiKey } }),
      },
    },
    models: modelIds.map((modelId) => placeholderModel(modelId, id, api, baseUrl)),
    api: streams,
  };
}

async function readProvidersFromAgentDir(
  dir: string,
  loadApiModule: (api: string) => Promise<ProviderStreams>,
): Promise<CreateProviderOptions[]> {
  const config = readJson<AgentModelsFile>(path.join(dir, "models.json"));
  const entries = Object.entries(config?.providers ?? {});
  const options = await Promise.all(
    entries.map(([id, cfg]) => toProviderOptions(id, cfg, loadApiModule)),
  );
  return options.filter((opts): opts is CreateProviderOptions => opts !== null);
}

/** The app's own single-slot `settings.json` config (via SettingsStore). */
export interface AppSettingsProviderInput {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export const APP_SETTINGS_PROVIDER_ID = "app-settings";

async function appSettingsProviderOptions(
  settings: AppSettingsProviderInput,
  loadApiModule: (api: string) => Promise<ProviderStreams>,
): Promise<CreateProviderOptions | null> {
  if (!settings.apiKey || !settings.baseUrl || !settings.model) return null;
  const api = "openai-completions";
  const streams = await loadApiModule(api);
  return {
    id: APP_SETTINGS_PROVIDER_ID,
    baseUrl: settings.baseUrl,
    auth: {
      apiKey: {
        name: APP_SETTINGS_PROVIDER_ID,
        resolve: async () => ({ auth: { apiKey: settings.apiKey } }),
      },
    },
    models: [placeholderModel(settings.model, APP_SETTINGS_PROVIDER_ID, api, settings.baseUrl)],
    api: streams,
  };
}

export interface ModelsRegistry {
  models: MutableModels;
  defaultProviderId?: string;
  defaultModelId?: string;
}

/**
 * Builds a `pi-ai` `MutableModels` registry from every configured model
 * source, in precedence order (lowest first, since `setProvider` upserts
 * by id -- last one wins):
 *
 *   1. every pi-ai built-in provider (37 known providers, e.g. "openrouter",
 *      "anthropic", "google", "github-copilot", ...), credentialed from
 *      `.pi/agent/auth.json` (project overriding global) -- this is what
 *      surfaces a provider's full real model catalog (e.g. OpenRouter's
 *      ~270 models with real cost/context-window metadata) as soon as the
 *      user has a credential for it, with zero `models.json` entry needed,
 *   2. the app's own `settings.json` (via `SettingsStore`), if provided,
 *   3. the global `~/.pi/agent` custom providers (`models.json`),
 *   4. the project-local `<cwd>/.pi/agent` custom providers (highest
 *      precedence) -- a custom `models.json` entry with the same id as a
 *      built-in provider fully overrides it.
 *
 * `models.json` is optional at every level -- a source that has none simply
 * contributes no custom providers, and built-ins still work off `auth.json`
 * alone.
 */
export async function buildModelsRegistry(
  homeDir: string = os.homedir(),
  cwd: string = process.cwd(),
  appSettings?: AppSettingsProviderInput,
  loaders: ModelsLoaders = {},
): Promise<ModelsRegistry> {
  const loadPiAi = loaders.loadPiAi ?? defaultLoadPiAi;
  const loadApiModule = loaders.loadApiModule ?? defaultLoadApiModule;
  const loadBuiltinProviders = loaders.loadBuiltinProviders ?? defaultLoadBuiltinProviders;

  const { createModels, createProvider } = await loadPiAi();

  const globalDir = path.join(homeDir, ".pi", "agent");
  const projectDir = path.join(cwd, ".pi", "agent");

  const credentials = new AuthJsonCredentialStore(globalDir, projectDir);
  const models = createModels({ credentials });

  const { builtinProviders } = await loadBuiltinProviders();
  for (const provider of builtinProviders()) {
    models.setProvider(provider);
  }

  if (appSettings) {
    const opts = await appSettingsProviderOptions(appSettings, loadApiModule);
    if (opts) models.setProvider(createProvider(opts));
  }

  for (const opts of await readProvidersFromAgentDir(globalDir, loadApiModule)) {
    models.setProvider(createProvider(opts));
  }
  for (const opts of await readProvidersFromAgentDir(projectDir, loadApiModule)) {
    models.setProvider(createProvider(opts));
  }

  const globalSettings = readJson<AgentSettingsFile>(path.join(globalDir, "settings.json"));
  const projectSettings = readJson<AgentSettingsFile>(path.join(projectDir, "settings.json"));

  return {
    models,
    defaultProviderId: projectSettings?.defaultProvider ?? globalSettings?.defaultProvider,
    defaultModelId: projectSettings?.defaultModel ?? globalSettings?.defaultModel,
  };
}

/**
 * Builds the fully-qualified, globally-unique id for a model: `provider/modelId`.
 * This -- not the bare model id -- is what's ever handed to the renderer as
 * `ModelInfo.id` and round-tripped back as `StartChatRequest.model`.
 *
 * This is necessary because bare model ids are *not* unique once pi-ai's
 * built-in catalogs are registered: e.g. "gpt-5.6-luna" ships identically
 * from six different built-in providers (azure-openai-responses,
 * cloudflare-ai-gateway, github-copilot, openai, openai-codex, opencode).
 * A flat `id` string can never disambiguate which one the user picked.
 */
export function qualifyModelId(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

/**
 * Resolves a fully-qualified `provider/modelId` id (as produced by
 * `qualifyModelId`) back to its exact model + provider -- an O(1), fully
 * deterministic lookup with no cross-provider ambiguity, since the
 * provider id is encoded directly in the string. The model id itself may
 * contain further "/" characters (e.g. OpenRouter's own "openai/gpt-4o"
 * naming), so only the *first* segment is treated as the provider id.
 */
export function findModelById(
  models: MutableModels,
  qualifiedId: string,
): { model: Model<Api>; providerId: string } | null {
  const separatorIndex = qualifiedId.indexOf("/");
  if (separatorIndex === -1) return null;

  const providerId = qualifiedId.slice(0, separatorIndex);
  const modelId = qualifiedId.slice(separatorIndex + 1);

  const provider = models.getProvider(providerId);
  if (!provider) return null;

  const match = provider.getModels().find((m) => m.id === modelId);
  return match ? { model: match, providerId } : null;
}
