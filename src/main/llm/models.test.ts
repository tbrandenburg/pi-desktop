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
