import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildModelsRegistry, findModelById, APP_SETTINGS_PROVIDER_ID } from "./models";
import { realModelsLoaders } from "./test-support/real-models-loaders";

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

    const found = findModelById(registry.models, "gpt-4o-mini");
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

    const found = findModelById(registry.models, "gpt-4o-mini");
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

  it("prefers a user-configured model over a built-in catalog entry of the same id (id-collision precedence)", async () => {
    // A real built-in provider (openai) ships a model literally named
    // "gpt-4o-mini". A user-configured app-settings model of the same id
    // must win the lookup -- proves findModelById doesn't silently resolve
    // to an unrelated built-in provider on a plausible id collision.
    const registry = await buildModelsRegistry(
      home,
      cwd,
      { apiKey: "sk-app-only", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
      realModelsLoaders,
    );

    const found = findModelById(registry.models, "gpt-4o-mini");
    expect(found?.providerId).toBe(APP_SETTINGS_PROVIDER_ID);
  });
});
