import fs from "node:fs";
import path from "node:path";
import type {
  Api,
  Credential,
  CredentialInfo,
  CredentialStore,
  CreateProviderOptions,
  Model,
  ProviderStreams,
} from "@earendil-works/pi-ai";

// This module owns "read and parse `.pi/agent` files" (the same directory
// layout the Pi CLI/agent itself reads: `auth.json`, `models.json`,
// `settings.json`) -- a distinct concern from `models.ts`'s job of
// assembling a pi-ai `MutableModels` registry from whatever sources it's
// given. See `models.ts`'s `SOURCES` array for how this module's exports
// are wired in as a `ProviderSource`.

export interface AgentSettingsFile {
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

export function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

/**
 * Reads credentials from `.pi/agent/auth.json` (the same file the Pi
 * CLI/agent writes), project-local overriding global per provider id -- the
 * same precedence as `models.json`/`settings.json`. This is what lets a
 * pi-ai built-in provider (e.g. "openrouter") that has no `models.json`
 * entry at all still resolve real auth, exactly like the CLI.
 *
 * This is a deliberately reduced-scope adaptation of two upstream patterns,
 * not a from-scratch design:
 *  - The `CredentialStore` interface shape (`read`/`list`/`modify`/`delete`)
 *    and the in-memory `overrides` map for uncommitted changes mirror
 *    `@earendil-works/pi-ai@0.82.0`'s `InMemoryCredentialStore`
 *    (`node_modules/@earendil-works/pi-ai/dist/auth/credential-store.js`).
 *  - Reading disk lazily on every `read()`/`list()` call and layering
 *    in-memory overrides on top of it mirrors the CLI's `RuntimeCredentials`
 *    overlay (`@earendil-works/pi-coding-agent@0.82.0`'s
 *    `dist/core/runtime-credentials.js`) composed with `AuthStorage.list()`'s
 *    project-over-global precedence merge (`dist/core/auth-storage.js`);
 *    that package is not a dependency of this app, so it isn't in
 *    node_modules -- verified via `npm pack
 *    @earendil-works/pi-coding-agent@0.82.0` and inspecting the tarball.
 *
 * Deliberately NOT copied: `AuthStorage`'s `FileAuthStorageBackend` uses
 * `proper-lockfile` for atomic, cross-process-safe writes to `auth.json`.
 * This class never writes back to disk at all (see below), so there is
 * nothing to lock -- only add file locking here if a login/logout UI that
 * actually persists credentials is added later.
 *
 * Read-mostly: `modify()`/`delete()` only update the in-memory view (used by
 * pi-ai's own OAuth refresh flow during a live request) and are never
 * persisted back to `auth.json` -- this app has no login/logout UI of its
 * own, so a refreshed token only lives for the current process lifetime.
 */
export class AuthJsonCredentialStore implements CredentialStore {
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

// models.json may reference an env var for a static key, e.g. "$LLM7_TOKEN".
// The `!command` form used elsewhere in the Pi CLI is out of scope here.
function resolveApiKeyValue(raw: string): string {
  if (!raw.startsWith("$")) return raw;
  return process.env[raw.slice(1)] ?? "";
}

export function placeholderModel(id: string, provider: string, api: Api, baseUrl: string): Model<Api> {
  // Custom (user-configured) providers only ever declare an id/baseUrl/api in
  // models.json -- no cost/context-window/reasoning metadata. Only pi-ai's
  // baked-in catalog (`MODELS`) carries that for known providers; there is
  // nothing to look up for a user's own endpoint, so placeholder metadata is
  // used, same as the Pi CLI does for custom providers.
  //
  // The zero-value defaults below intentionally match the fallbacks in
  // `@earendil-works/pi-coding-agent@0.82.0`'s `modelFromJson()`
  // (`dist/core/provider-composer.js`, verified via `npm pack`): they are
  // `??`-chained after a model definition's own fields exactly the same way
  // there, i.e. `reasoning: false`, `input: ["text"]`, zero-cost `cost`,
  // `contextWindow: 128_000`, and `maxTokens: 16384`.
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
    maxTokens: 16384,
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

/** Custom providers declared in a `.pi/agent/models.json` at `dir`. */
export async function readProvidersFromAgentDir(
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
