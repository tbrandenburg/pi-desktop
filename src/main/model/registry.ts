import os from "node:os";
import path from "node:path";
import type {
  Api,
  CreateProviderOptions,
  Model,
  MutableModels,
  Provider,
  ProviderStreams,
} from "@earendil-works/pi-ai";
import type { ResourceLoader } from "@earendil-works/pi-coding-agent";

import { nativeDynamicImport } from "../native-import";
import {
  loadCodingAgent,
  type CodingAgentLoaders,
} from "../agent/coding-agent-loaders";
import {
  AuthJsonCredentialStore,
  placeholderModel,
  readJson,
  readProvidersFromAgentDir,
  type AgentSettingsFile,
} from "./pi-agent-dir";

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
  /**
   * Injectable `@earendil-works/pi-coding-agent` loader for
   * `extensionProviderSource` below -- reuses `src/main/agent/coding-agent-
   * loaders.ts`'s exact same `nativeDynamicImport`-hidden production loader
   * (and its injection seam) rather than duplicating it. See that module's
   * own doc comment for why the real loader is invisible to Vitest.
   */
  codingAgentLoaders?: CodingAgentLoaders;
  /**
   * Test-only: overrides `extensionProviderSource`'s `ResourceLoader`,
   * mirroring `AgentRuntimeRunArgs.resourceLoader` (`src/main/agent/
   * runtime.ts`) -- lets tests load a real inline test extension via
   * `extensionFactories` without touching any real global/project extension
   * directory. Production code never sets this: omitting it lets
   * `createAgentSession` construct its own default `DefaultResourceLoader`,
   * which applies the same real project-trust gating `AgentRuntime.
   * listCommands()` already relies on for the identical discovery pattern.
   */
  extensionResourceLoader?: ResourceLoader;
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
 * Shared context passed to every `ProviderSource.load()` call -- everything
 * a source might need to resolve its own `CreateProviderOptions[]`.
 */
interface ProviderSourceContext {
  globalDir: string;
  projectDir: string;
  cwd: string;
  appSettings?: AppSettingsProviderInput;
  loadApiModule: (api: string) => Promise<ProviderStreams>;
  loadBuiltinProviders: () => Promise<BuiltinProvidersModule>;
  codingAgentLoaders: CodingAgentLoaders;
  extensionResourceLoader?: ResourceLoader;
}

/**
 * What a `ProviderSource` contributes: either a fully pre-built pi-ai
 * `Provider` (the built-in catalogs, which are registered directly via
 * `models.setProvider`) or `CreateProviderOptions` to be built via
 * `createProvider` first. Kept as a discriminated union rather than a
 * lossy cast so `buildModelsRegistry`'s loop stays fully typed.
 */
type RegistryEntry = { kind: "provider"; provider: Provider } | { kind: "options"; options: CreateProviderOptions };

/**
 * A single model/provider source. Each source resolves to zero or more
 * `RegistryEntry`s, later upserted into the registry via
 * `models.setProvider` -- last one wins on a given provider id. Precedence
 * across sources is therefore just their position in the `SOURCES` array
 * below (see `buildModelsRegistry`), not hand-written statement order.
 */
interface ProviderSource {
  load(ctx: ProviderSourceContext): Promise<RegistryEntry[]>;
}

/**
 * Models contributed by extensions configured via `settings.json`'s
 * `"packages"` array (e.g. `npm:pi-free`) that call `pi.registerProvider(...)`
 * at activation time (issue #147). Structurally this needs a real
 * pi-coding-agent `ModelRuntime` + extension-activation pass -- raw
 * `@earendil-works/pi-ai` APIs (used by every other source here) have no
 * concept of extensions at all.
 *
 * Reuses the exact throwaway-session pattern `AgentRuntime.listCommands()`
 * (`src/main/agent/runtime.ts`) already established for the identical
 * purpose (discovering `pi.registerCommand` commands): a fresh
 * `ModelRuntime.create()` + `SessionManager.inMemory(cwd)` +
 * `createAgentSession({ ..., noTools: "all" })` call, with no persisted
 * session and no resolved model needed. `createAgentSession`'s own
 * `_buildRuntime` flushes every extension's `pi.registerProvider`/
 * `registerNativeProvider` call directly onto the `modelRuntime` passed in
 * (confirmed against the real installed package, see issue #147), so
 * `extensionRuntime.getRegisteredProviderIds()` afterwards is exactly the
 * set of providers extensions registered -- not the runtime's own
 * `auth.json`/builtin-catalog providers, which are read back separately by
 * `builtinProviderSource`/`agentDirSource` below.
 *
 * `resourceLoader` is intentionally left to `createAgentSession`'s own
 * default construction (a `DefaultResourceLoader`) unless a test injects
 * one via `ctx.extensionResourceLoader` -- that default already applies
 * the same real project-trust gating `listCommands()` relies on for
 * exactly this reason (see the trust/perf discussion in issue #147; adding
 * new trust-gating or caching logic here is explicitly out of scope).
 *
 * Any failure while activating extensions (e.g. a broken third-party
 * package) must not brick the rest of the model picker -- caught and
 * treated as "this source contributes nothing", same as every other
 * source here silently contributing nothing when its own optional config
 * is absent/invalid.
 *
 * Some extensions (e.g. `pi-free`'s dynamic-fetch providers like `kilo`,
 * `zenmux`, `crofai`) register synchronously with an EMPTY model list by
 * design, expecting a later `ModelRuntime.refresh({ allowNetwork: true })`
 * call (via each provider's own `refreshModels` callback) to populate them
 * -- mirroring `pi-coding-agent`'s own `pi update --models` CLI flow. Since
 * `ModelRuntime.create()` above is deliberately created with
 * `allowModelNetwork: false` (this source must never make a network call
 * before the caller opts in), those providers stayed empty forever without
 * an explicit follow-up refresh (issue #165). Do this refresh with a short
 * (~4s) bounded timeout since it runs on every model-list request, not a
 * one-off user command -- a provider whose refresh doesn't finish in time
 * simply keeps 0 models that round (no worse than before this fix); a
 * timeout must never throw/reject and must never discard providers that
 * already resolved.
 */
const extensionProviderSource: ProviderSource = {
  async load(ctx) {
    try {
      const { createAgentSession, ModelRuntime, SessionManager } = await loadCodingAgent(ctx.codingAgentLoaders);
      const extensionRuntime = await ModelRuntime.create({
        allowModelNetwork: false,
        // Mirror the `agentDir: ctx.globalDir` pin on the `createAgentSession`
        // call below (see its comment) onto this `ModelRuntime.create()` call
        // too -- otherwise this runtime's own auth/models file resolution
        // falls back to `getAgentDir()`'s implicit default instead of the
        // `homeDir` `buildModelsRegistry` was actually given (issue #165).
        authPath: path.join(ctx.globalDir, "auth.json"),
        modelsPath: path.join(ctx.globalDir, "models.json"),
      });
      await createAgentSession({
        cwd: ctx.cwd,
        // Explicitly pin the global agent dir to the same `globalDir` every
        // other source here uses (`agentDirSource`/`AuthJsonCredentialStore`),
        // rather than relying on `createAgentSession`'s own implicit default
        // (`getAgentDir()`, driven by `PI_CODING_AGENT_DIR`/`os.homedir()`).
        // Without this, a caller that explicitly passes a non-default
        // `homeDir` to `buildModelsRegistry` (e.g. a test, or any future
        // multi-profile support) would have this source silently look at
        // the wrong directory while every other source correctly used the
        // given `homeDir` -- confirmed by a real end-to-end repro with a
        // real on-disk `npm:`-style package before this line was added.
        agentDir: ctx.globalDir,
        modelRuntime: extensionRuntime,
        sessionManager: SessionManager.inMemory(ctx.cwd),
        noTools: "all",
        resourceLoader: ctx.extensionResourceLoader,
      });

      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), 4_000);
      try {
        await extensionRuntime.refresh({
          allowNetwork: true,
          force: true,
          signal: abortController.signal,
        });
      } catch {
        // A slow/failing dynamic-fetch provider must not prevent already-
        // registered providers (including ones whose refresh already
        // succeeded) from being returned below.
      } finally {
        clearTimeout(timeout);
      }

      return extensionRuntime
        .getRegisteredProviderIds()
        .map((providerId) => extensionRuntime.getProvider(providerId))
        .filter((provider): provider is Provider => provider !== undefined)
        .map((provider) => ({ kind: "provider", provider }) as const);
    } catch {
      return [];
    }
  },
};

/**
 * Every pi-ai built-in provider (37 known providers, e.g. "openrouter",
 * "anthropic", "google", "github-copilot", ...), credentialed from
 * `.pi/agent/auth.json` via the registry's shared `CredentialStore` (set up
 * separately in `buildModelsRegistry`, not per-source). This surfaces a
 * provider's full real model catalog (e.g. OpenRouter's ~270 models with
 * real cost/context-window metadata) as soon as the user has a credential
 * for it, with zero `models.json` entry needed.
 */
const builtinProviderSource: ProviderSource = {
  async load(ctx) {
    const { builtinProviders } = await ctx.loadBuiltinProviders();
    return builtinProviders().map((provider) => ({ kind: "provider", provider }) as const);
  },
};

/** The app's own single-slot `settings.json` config (via `SettingsStore`). */
const appSettingsSource: ProviderSource = {
  async load(ctx) {
    if (!ctx.appSettings) return [];
    const options = await appSettingsProviderOptions(ctx.appSettings, ctx.loadApiModule);
    return options ? [{ kind: "options", options }] : [];
  },
};

/** Custom providers from a `.pi/agent/models.json` at a given directory. */
function agentDirSource(dirKey: "globalDir" | "projectDir"): ProviderSource {
  return {
    async load(ctx) {
      const options = await readProvidersFromAgentDir(ctx[dirKey], ctx.loadApiModule);
      return options.map((o) => ({ kind: "options", options: o }) as const);
    },
  };
}

/**
 * Lowest precedence first, since `setProvider` upserts by id -- last one
 * wins. See each source above for what it contributes. `models.json`/
 * `auth.json` are optional at every level -- a source that has none simply
 * contributes no providers, and built-ins still work off `auth.json` alone.
 * `extensionProviderSource` is the absolute lowest precedence: an explicit
 * user config (`app-settings`/`.pi/agent/models.json`) must never be
 * silently overridden by a third-party extension (issue #147).
 */
const SOURCES: ProviderSource[] = [
  extensionProviderSource,
  builtinProviderSource,
  appSettingsSource,
  agentDirSource("globalDir"),
  agentDirSource("projectDir"),
];

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

  const ctx: ProviderSourceContext = {
    globalDir,
    projectDir,
    cwd,
    appSettings,
    loadApiModule,
    loadBuiltinProviders,
    codingAgentLoaders: loaders.codingAgentLoaders ?? {},
    extensionResourceLoader: loaders.extensionResourceLoader,
  };

  for (const source of SOURCES) {
    for (const entry of await source.load(ctx)) {
      models.setProvider(entry.kind === "provider" ? entry.provider : createProvider(entry.options));
    }
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
 * Branded string types distinguishing bare vs. fully-qualified model ids
 * (issue #113). Both are plain strings at runtime -- the brand exists only
 * at the type level, to stop a bare id from being passed where a qualified
 * id is expected (or vice versa) without the compiler catching it. This
 * class of bug shipped for real once already (see AGENTS.md lesson #11):
 * a bare id like "gpt-5.6-luna" is not unique across providers, so any
 * call site that quietly treats one form as the other can silently route
 * to the wrong provider.
 *
 * Use `asBareModelId`/`asQualifiedModelId` to brand a value at the one
 * trust boundary where it's known to genuinely be that form (e.g. a
 * provider's own `model.id`, or an already-qualified id round-tripped
 * from the renderer) -- never to blanket-silence an unrelated type error.
 */
declare const bareModelIdBrand: unique symbol;
declare const qualifiedModelIdBrand: unique symbol;

/** A model id scoped to one already-known provider, e.g. a provider's own `model.id`. */
export type BareModelId = string & { readonly [bareModelIdBrand]: true };

/** The `provider/modelId` form produced by `qualifyModelId`, globally unique across all registered providers. */
export type QualifiedModelId = string & { readonly [qualifiedModelIdBrand]: true };

/** Brands a string as a `BareModelId` at a trust boundary where it's known to genuinely be one. */
export function asBareModelId(id: string): BareModelId {
  return id as BareModelId;
}

/** Brands a string as a `QualifiedModelId` at a trust boundary where it's known to genuinely be one (e.g. round-tripped from the renderer). */
export function asQualifiedModelId(id: string): QualifiedModelId {
  return id as QualifiedModelId;
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
export function qualifyModelId(providerId: string, modelId: BareModelId): QualifiedModelId {
  return `${providerId}/${modelId}` as QualifiedModelId;
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
  qualifiedId: QualifiedModelId,
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
