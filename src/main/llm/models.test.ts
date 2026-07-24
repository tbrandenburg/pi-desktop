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
