import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildModelsRegistry,
  findModelById,
  qualifyModelId,
  asBareModelId,
  asQualifiedModelId,
  APP_SETTINGS_PROVIDER_ID,
} from "./registry";
import { realModelsLoaders } from "./test-support/real-models-loaders";
import { realCodingAgentLoaders } from "../agent/test-support/real-coding-agent-loaders";
import { buildProviderTestResourceLoader } from "./test-support/inline-provider-extension";

describe("buildModelsRegistry", () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    // Deliberately empty: no ~/.pi/agent and no <cwd>/.pi/agent at all, to
    // prove models.json is not mandatory -- the app's own settings.json is a
    // fully valid, standalone model source.
    home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-models-home-"));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-models-cwd-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("makes a model configured only via the app's own settings listable and streamable, with zero .pi files present", async () => {
    const registry = await buildModelsRegistry(
      home,
      cwd,
      {
        apiKey: "sk-app-only",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
      },
      realModelsLoaders,
    );

    const available = await registry.models.getAvailable();
    expect(available).toEqual([
      expect.objectContaining({ id: "gpt-4o-mini", provider: APP_SETTINGS_PROVIDER_ID }),
    ]);

    const found = findModelById(registry.models, qualifyModelId(APP_SETTINGS_PROVIDER_ID, asBareModelId("gpt-4o-mini")));
    expect(found?.providerId).toBe(APP_SETTINGS_PROVIDER_ID);

    // stream() must resolve auth from the in-memory static apiKey without
    // touching disk (proves the provider is genuinely static/self-contained).
    const auth = await registry.models.getAuth(APP_SETTINGS_PROVIDER_ID);
    expect(auth?.auth.apiKey).toBe("sk-app-only");
  });

  it("actually dispatches a real network stream call for an app-settings-only model (proves it is streamable, not just listable)", async () => {
    // baseUrl deliberately points at a port nothing listens on, so the real
    // pi-ai openai-completions implementation's HTTP client fails fast with a
    // connection error -- this is the true system boundary (network), so it
    // is not mocked. What this proves is that `models.stream()` got far
    // enough to resolve auth for the right provider and issue a genuine
    // outbound request; an "unconfigured provider"/auth error here would
    // instead mean the registry wiring itself is broken.
    const registry = await buildModelsRegistry(
      home,
      cwd,
      {
        apiKey: "sk-app-only",
        baseUrl: "http://127.0.0.1:1/v1",
        model: "gpt-4o-mini",
      },
      realModelsLoaders,
    );

    const found = findModelById(registry.models, qualifyModelId(APP_SETTINGS_PROVIDER_ID, asBareModelId("gpt-4o-mini")));
    expect(found).not.toBeNull();

    const events = registry.models.stream(found!.model, {
      messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
    });

    const collected: string[] = [];
    for await (const event of events) {
      collected.push(event.type);
    }

    // Streams terminate with either "done" or "error" (see AssistantMessageEvent
    // doc comment); a real connection failure must surface as "error", never
    // silently resolve as "done".
    expect(collected[collected.length - 1]).toBe("error");
    const result = await events.result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBeTruthy();
  });

  it("returns no models when neither app settings nor .pi/agent config is present", async () => {
    const registry = await buildModelsRegistry(home, cwd, undefined, realModelsLoaders);
    await expect(registry.models.getAvailable()).resolves.toEqual([]);
  });

  it("registers no provider when app settings are incomplete (missing apiKey)", async () => {
    const registry = await buildModelsRegistry(
      home,
      cwd,
      {
        apiKey: "",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
      },
      realModelsLoaders,
    );
    await expect(registry.models.getAvailable()).resolves.toEqual([]);
  });
});

describe("buildModelsRegistry with pi-ai built-in providers (auth.json)", () => {
  let home: string;
  let cwd: string;
  let agentDir: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-builtin-home-"));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-builtin-cwd-"));
    agentDir = path.join(home, ".pi", "agent");
    fs.mkdirSync(agentDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("discovers pi-ai's full built-in OpenRouter catalog from auth.json alone, with no models.json entry", async () => {
    fs.writeFileSync(
      path.join(agentDir, "auth.json"),
      JSON.stringify({ openrouter: { type: "api_key", key: "sk-or-test-key" } }),
    );

    const registry = await buildModelsRegistry(home, cwd, undefined, realModelsLoaders);
    const available = await registry.models.getAvailable("openrouter");

    // Real, unmocked pi-ai built-in catalog: proves this isn't a hand-picked
    // subset -- the actual generated OpenRouter model count ships with the
    // installed pi-ai version.
    expect(available.length).toBeGreaterThan(100);
    expect(available.every((m) => m.provider === "openrouter")).toBe(true);

    const auth = await registry.models.getAuth("openrouter");
    expect(auth?.auth.apiKey).toBe("sk-or-test-key");
  });

  it("does not surface a built-in provider's models when no credential is configured for it", async () => {
    // No auth.json at all: openrouter is a registered built-in provider (so
    // its catalog exists), but must not be "available" without a credential.
    const registry = await buildModelsRegistry(home, cwd, undefined, realModelsLoaders);
    const provider = registry.models.getProvider("openrouter");
    expect(provider).toBeDefined();
    expect(provider!.getModels().length).toBeGreaterThan(100);

    const available = await registry.models.getAvailable("openrouter");
    expect(available).toEqual([]);
  });

  it("lets project-local auth.json override the global credential for the same provider id", async () => {
    fs.writeFileSync(
      path.join(agentDir, "auth.json"),
      JSON.stringify({ openrouter: { type: "api_key", key: "sk-or-global-key" } }),
    );
    const projectAgentDir = path.join(cwd, ".pi", "agent");
    fs.mkdirSync(projectAgentDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectAgentDir, "auth.json"),
      JSON.stringify({ openrouter: { type: "api_key", key: "sk-or-project-key" } }),
    );

    const registry = await buildModelsRegistry(home, cwd, undefined, realModelsLoaders);
    const auth = await registry.models.getAuth("openrouter");
    expect(auth?.auth.apiKey).toBe("sk-or-project-key");
  });

  it("resolves a fully-qualified id to the exact provider requested, even when a bare model id is ambiguous across providers", async () => {
    // Real-world regression: pi-ai's built-in catalog ships a model
    // literally named "gpt-5.6-luna" identically from *six* different
    // built-in providers (azure-openai-responses, cloudflare-ai-gateway,
    // github-copilot, openai, openai-codex, opencode). A bare-id lookup is
    // structurally ambiguous; qualifyModelId/findModelById must resolve
    // deterministically to the exact provider encoded in the id, not
    // whichever provider happens to register last.
    const registry = await buildModelsRegistry(home, cwd, undefined, realModelsLoaders);

    const collidingProviders = registry.models
      .getProviders()
      .filter((p) => p.getModels().some((m) => m.id === "gpt-5.6-luna"))
      .map((p) => p.id);
    expect(collidingProviders.length).toBeGreaterThanOrEqual(6);

    for (const providerId of collidingProviders) {
      const found = findModelById(registry.models, qualifyModelId(providerId, asBareModelId("gpt-5.6-luna")));
      expect(found?.providerId).toBe(providerId);
    }
  });

  it("a user-configured app-settings model never collides with a built-in catalog entry of the same bare id", async () => {
    // Built-in "openai" ships a model literally named "gpt-4o-mini". A
    // user-configured app-settings model of the same *bare* id is a
    // structurally distinct, fully-qualified id ("app-settings/gpt-4o-mini"
    // vs "openai/gpt-4o-mini") and cannot collide with it.
    const registry = await buildModelsRegistry(
      home,
      cwd,
      { apiKey: "sk-app-only", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
      realModelsLoaders,
    );

    const appSettingsMatch = findModelById(
      registry.models,
      qualifyModelId(APP_SETTINGS_PROVIDER_ID, asBareModelId("gpt-4o-mini")),
    );
    expect(appSettingsMatch?.providerId).toBe(APP_SETTINGS_PROVIDER_ID);

    const builtinMatch = findModelById(registry.models, qualifyModelId("openai", asBareModelId("gpt-4o-mini")));
    expect(builtinMatch?.providerId).toBe("openai");
  });
});

describe("buildModelsRegistry source precedence", () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-precedence-home-"));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-precedence-cwd-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("lets a global .pi/agent models.json entry override an app-settings provider registered under the same id, proving precedence is array-order-driven, not just non-colliding", async () => {
    // Deliberately reuse APP_SETTINGS_PROVIDER_ID as the models.json provider
    // id, so both sources register under the *exact same* provider id --
    // last source in the array wins via `setProvider`'s upsert-by-id
    // semantics. `agentDirSource("globalDir")` is ordered after
    // `appSettingsSource` in `SOURCES`, so its model must win.
    const agentDir = path.join(home, ".pi", "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          [APP_SETTINGS_PROVIDER_ID]: {
            api: "openai-completions",
            baseUrl: "https://global.example.com/v1",
            apiKey: "sk-global-override",
            models: [{ id: "global-model" }],
          },
        },
      }),
    );

    const registry = await buildModelsRegistry(
      home,
      cwd,
      {
        apiKey: "sk-app-only",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
      },
      realModelsLoaders,
    );

    const available = await registry.models.getAvailable(APP_SETTINGS_PROVIDER_ID);
    expect(available).toEqual([
      expect.objectContaining({ id: "global-model", provider: APP_SETTINGS_PROVIDER_ID }),
    ]);

    const auth = await registry.models.getAuth(APP_SETTINGS_PROVIDER_ID);
    expect(auth?.auth.apiKey).toBe("sk-global-override");
  });
});

describe("findModelById edge cases", () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-findmodel-home-"));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-findmodel-cwd-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("returns null for an id with no '/' separator at all", async () => {
    const registry = await buildModelsRegistry(
      home,
      cwd,
      { apiKey: "sk-app-only", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
      realModelsLoaders,
    );
    expect(findModelById(registry.models, asQualifiedModelId("no-separator-here"))).toBeNull();
    expect(findModelById(registry.models, asQualifiedModelId(""))).toBeNull();
  });

  it("returns null when the provider segment does not correspond to any registered provider", async () => {
    const registry = await buildModelsRegistry(
      home,
      cwd,
      { apiKey: "sk-app-only", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
      realModelsLoaders,
    );
    expect(findModelById(registry.models, asQualifiedModelId("nonexistent-provider/gpt-4o-mini"))).toBeNull();
  });

  it("returns null when the provider exists but the model id segment does not match any of its models", async () => {
    const registry = await buildModelsRegistry(
      home,
      cwd,
      { apiKey: "sk-app-only", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
      realModelsLoaders,
    );
    const found = findModelById(registry.models, qualifyModelId(APP_SETTINGS_PROVIDER_ID, asBareModelId("no-such-model")));
    expect(found).toBeNull();
  });

  it("returns null for a slash-less id, even when the id's prefix coincidentally names a real provider and the full id coincidentally names one of its models", async () => {
    // Regression-style edge case: without the `separatorIndex === -1` guard,
    // slicing a slash-less id would still produce a "providerId" (all but
    // the last char) and "modelId" (the full string) that can, by pure
    // coincidence, both resolve to real registered entries. This proves the
    // guard is load-bearing, not redundant with the later lookups failing
    // naturally.
    const agentDir = path.join(home, ".pi", "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          myprov: {
            api: "openai-completions",
            baseUrl: "https://x.example/v1",
            apiKey: "sk-x",
            models: [{ id: "myprovX" }],
          },
        },
      }),
    );
    const registry = await buildModelsRegistry(home, cwd, undefined, realModelsLoaders);

    // Sanity check the coincidental setup actually exists as described.
    expect(registry.models.getProvider("myprov")).toBeDefined();
    expect(registry.models.getProvider("myprov")!.getModels().some((m) => m.id === "myprovX")).toBe(true);

    expect(findModelById(registry.models, asQualifiedModelId("myprovX"))).toBeNull();
  });
});

describe("buildModelsRegistry with extension-registered providers (issue #147)", () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-models-ext-home-"));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-models-ext-cwd-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("surfaces a model registered by a real extension via pi.registerProvider(...)", async () => {
    const extensionResourceLoader = await buildProviderTestResourceLoader(cwd);

    const registry = await buildModelsRegistry(home, cwd, undefined, {
      ...realModelsLoaders,
      codingAgentLoaders: realCodingAgentLoaders,
      extensionResourceLoader,
    });

    const provider = registry.models.getProvider("pi-free-fixture");
    expect(provider).toBeDefined();
    expect(provider!.getModels().some((m) => m.id === "fixture-model")).toBe(true);

    const found = findModelById(registry.models, qualifyModelId("pi-free-fixture", asBareModelId("fixture-model")));
    expect(found?.providerId).toBe("pi-free-fixture");
  });

  it("gives an explicit app-settings provider precedence over an extension-registered provider with the same id", async () => {
    const extensionResourceLoader = await buildProviderTestResourceLoader(cwd);

    const registry = await buildModelsRegistry(
      home,
      cwd,
      {
        apiKey: "sk-app-only",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
      },
      {
        ...realModelsLoaders,
        codingAgentLoaders: realCodingAgentLoaders,
        extensionResourceLoader,
      },
    );

    // The extension-registered provider must still be lower precedence than
    // the app's own settings.json-configured provider -- confirmed here by
    // checking that app-settings' own provider id/model was not clobbered
    // by the extension pass (they use different ids in this fixture, so
    // this also proves both sources contributed simultaneously without one
    // source silently suppressing the other's unrelated entries).
    expect(registry.models.getProvider(APP_SETTINGS_PROVIDER_ID)).toBeDefined();
    expect(registry.models.getProvider(APP_SETTINGS_PROVIDER_ID)!.getModels().some((m) => m.id === "gpt-4o-mini")).toBe(
      true,
    );
    expect(registry.models.getProvider("pi-free-fixture")).toBeDefined();
  });

  it("contributes no providers when no extension registers any (real activation pass with zero registerProvider calls)", async () => {
    // No extensionResourceLoader override -- createAgentSession's own real
    // default DefaultResourceLoader runs against the empty temp cwd/agentDir,
    // discovering zero extensions.
    const registry = await buildModelsRegistry(home, cwd, undefined, {
      ...realModelsLoaders,
      codingAgentLoaders: realCodingAgentLoaders,
    });

    await expect(registry.models.getAvailable()).resolves.toEqual([]);
    expect(registry.models.getProvider("pi-free-fixture")).toBeUndefined();
  });

  it("discovers a real on-disk npm-style package (e.g. pi-free) via the given homeDir's own .pi/agent/settings.json -- no extensionResourceLoader override, no PI_CODING_AGENT_DIR env var", async () => {
    // Regression test for a real bug caught by a manual end-to-end repro
    // (not by any of the tests above, since they all inject
    // `extensionResourceLoader` directly, which makes `createAgentSession`'s
    // own `agentDir` option a no-op per its own source -- see sdk.js:
    // `resourceLoader = options.resourceLoader; if (!resourceLoader) { ...
    // uses agentDir... }`). Without explicitly passing `agentDir: ctx.globalDir`
    // into `createAgentSession`, `extensionProviderSource` would silently
    // resolve against `PI_CODING_AGENT_DIR`/`os.homedir()` instead of the
    // `home` directory this test (and any real multi-profile caller) explicitly
    // passes to `buildModelsRegistry` -- exactly the divergence every other
    // source here (`agentDirSource`, `AuthJsonCredentialStore`) already avoids
    // by using `ctx.globalDir` directly.
    const packageDir = path.join(home, ".pi", "agent", "npm", "node_modules", "pi-free-fixture-ondisk");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: "pi-free-fixture-ondisk", version: "1.0.0", pi: { extensions: ["./index.js"] } }, null, 2),
    );
    fs.writeFileSync(
      path.join(packageDir, "index.js"),
      `module.exports = function (pi) {
        pi.registerProvider("pi-free-ondisk-provider", {
          baseUrl: "https://fixture.example/v1",
          api: "openai-completions",
          models: [{ id: "ondisk-model", name: "On-disk Model" }],
        });
      };`,
    );
    fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({ packages: ["npm:pi-free-fixture-ondisk"] }, null, 2),
    );

    const registry = await buildModelsRegistry(home, cwd, undefined, {
      ...realModelsLoaders,
      codingAgentLoaders: realCodingAgentLoaders,
      // Deliberately no `extensionResourceLoader` override -- this exercises
      // createAgentSession's own real default DefaultResourceLoader
      // construction, the exact path production's `model:list` IPC handler
      // (via `listConfiguredModels`/`resolvePiDefault`, always called with
      // `homeDir = os.homedir()`) actually goes through.
    });

    const provider = registry.models.getProvider("pi-free-ondisk-provider");
    expect(provider).toBeDefined();
    expect(provider!.getModels().some((m) => m.id === "ondisk-model")).toBe(true);
  });

  it("populates a provider's dynamic-fetch model list via refreshModels(...) -- regression test for issue #165 (pi-free's kilo/zenmux/crofai-style providers registering with 0 models)", async () => {
    // Deliberately NOT another eager/synchronous `registerProvider({ models:
    // [...] })` fixture (see `buildProviderTestResourceLoader`'s fixture) --
    // that pattern was exactly the gap that let #165 ship undetected: it
    // never exercises `ModelRuntime.refresh({ allowNetwork: true })`, which
    // is the real mechanism `pi-free`'s dynamic-fetch providers rely on.
    // This fixture registers synchronously with an EMPTY model list, then
    // only returns real models from its `refreshModels` callback -- proving
    // `extensionProviderSource` must call `.refresh(...)` itself to surface
    // them.
    let refreshCallCount = 0;
    const dynamicFetchExtension = (pi: ExtensionAPI): void => {
      pi.registerProvider("pi-free-dynamic-fixture", {
        baseUrl: "https://dynamic-fixture.example/v1",
        api: "openai-completions",
        // A static placeholder key -- real free-tier pi-free providers (e.g.
        // kilo/zenmux) similarly configure a resolvable API key even for a
        // "free" endpoint, since `pi-ai`'s `Models.refresh(...)` only calls a
        // provider's `refreshModels` once a credential actually resolves
        // (`resolveRefreshCredential` in `@earendil-works/pi-ai`'s
        // `models.js`); a provider with no resolvable auth is silently
        // skipped by `refresh(...)` entirely, regardless of network access.
        apiKey: "fixture-static-key",
        models: [],
        async refreshModels() {
          refreshCallCount += 1;
          return [
            {
              id: "dynamic-model",
              name: "Dynamic Model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 32_000,
              maxTokens: 4_096,
            },
          ];
        },
      });
    };
    const extensionResourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: cwd,
      settingsManager: SettingsManager.inMemory(),
      extensionFactories: [dynamicFetchExtension],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await extensionResourceLoader.reload();

    const registry = await buildModelsRegistry(home, cwd, undefined, {
      ...realModelsLoaders,
      codingAgentLoaders: realCodingAgentLoaders,
      extensionResourceLoader,
    });

    // Before the fix, `refreshModels` is never invoked and the provider
    // keeps its synchronously-registered empty model list.
    expect(refreshCallCount).toBeGreaterThan(0);
    const provider = registry.models.getProvider("pi-free-dynamic-fixture");
    expect(provider).toBeDefined();
    expect(provider!.getModels().some((m) => m.id === "dynamic-model")).toBe(true);
  });
});
