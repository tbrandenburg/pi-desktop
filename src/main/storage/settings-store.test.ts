import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SettingsStore } from "./settings-store";
import { resolvePiDefault } from "../llm/pi-config";

vi.mock("../llm/pi-config", () => ({
  resolvePiDefault: vi.fn(() => null),
}));

// Real electron-store (not mocked) writing to a throwaway directory on disk,
// to prove settings genuinely survive across process/app restarts rather
// than only round-tripping through an in-memory fake.
vi.mock("electron-store", async () => {
  const actual =
    await vi.importActual<typeof import("electron-store")>("electron-store");
  return actual;
});

describe("SettingsStore persistence (real electron-store)", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-settings-"));
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  function newStoreAt(dir: string): SettingsStore {
    const store = new SettingsStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (store as any).load = async function load() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((this as any).store) return (this as any).store;
      const { default: Store } = await import("electron-store");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).store = new Store({
        name: "provider-settings",
        cwd: dir,
        defaults: {
          apiKey: "",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4o-mini",
        },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (this as any).store;
    };
    return store;
  }

  it("persists provider settings to disk and reloads them in a fresh SettingsStore instance", async () => {
    const first = newStoreAt(cwd);
    await first.save({
      apiKey: "sk-real-secret",
      baseUrl: "https://custom.example.com/v1",
      model: "gpt-4o",
    });

    // simulate an app restart: brand-new SettingsStore instance, same disk cwd
    const second = newStoreAt(cwd);
    const settings = await second.get();

    expect(settings).toEqual({
      apiKey: "sk-real-secret",
      baseUrl: "https://custom.example.com/v1",
      model: "gpt-4o",
    });

    const summary = await second.getSummary();
    expect(summary).toEqual({
      baseUrl: "https://custom.example.com/v1",
      model: "gpt-4o",
      hasApiKey: true,
    });
  });

  it("preserves the existing on-disk API key when resaving with an empty apiKey field", async () => {
    const first = newStoreAt(cwd);
    await first.save({
      apiKey: "sk-original",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
    });

    const second = newStoreAt(cwd);
    await second.save({
      apiKey: "",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini-updated",
    });

    const third = newStoreAt(cwd);
    const settings = await third.get();
    expect(settings.apiKey).toBe("sk-original");
    expect(settings.model).toBe("gpt-4o-mini-updated");
  });

  it("falls back to the resolved .pi/agent default when the user never saved settings", async () => {
    vi.mocked(resolvePiDefault).mockReturnValue({
      apiKey: "sk-pi-default",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "openai/gpt-5.4-mini",
      label: "openrouter/openai/gpt-5.4-mini",
    });

    const store = newStoreAt(cwd);
    const settings = await store.get();

    expect(settings).toEqual({
      apiKey: "sk-pi-default",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "openai/gpt-5.4-mini",
    });

    const summary = await store.getSummary();
    expect(summary).toEqual({
      baseUrl: "https://openrouter.ai/api/v1",
      model: "openai/gpt-5.4-mini",
      hasApiKey: true,
    });

    vi.mocked(resolvePiDefault).mockReturnValue(null);
  });

  it("prefers explicitly saved settings over the .pi/agent default", async () => {
    vi.mocked(resolvePiDefault).mockReturnValue({
      apiKey: "sk-pi-default",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "openai/gpt-5.4-mini",
      label: "openrouter/openai/gpt-5.4-mini",
    });

    const store = newStoreAt(cwd);
    await store.save({
      apiKey: "sk-user-provided",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o",
    });

    const settings = await store.get();
    expect(settings.apiKey).toBe("sk-user-provided");
    expect(settings.model).toBe("gpt-4o");

    vi.mocked(resolvePiDefault).mockReturnValue(null);
  });
});
