import os from "node:os";
import type StoreType from "electron-store";
import type {
  ChatMessage,
  ProviderSettings,
  ProviderSettingsSummary,
} from "../../shared/events";
import { resolvePiDefault } from "../model/pi-config";

export interface StoredSettings {
  apiKey: string;
  baseUrl: string;
  /**
   * Bare model id (never qualified with a provider prefix), always scoped
   * to the app's own single-slot provider -- see `APP_SETTINGS_PROVIDER_ID`
   * in `../model/registry`. Callers that need a fully-qualified id for registry
   * lookup/comparison (`chat-service.ts`, `ipc.ts`) qualify it themselves
   * with `qualifyModelId(APP_SETTINGS_PROVIDER_ID, model)`.
   */
  model: string;
}

interface SettingsSchema extends StoredSettings {
  /**
   * Absolute path of the cwd-scoped folder chat sessions are persisted
   * under (`JsonlSessionRepo`'s `sessionsRoot`). Defaults to the user's
   * home directory the first time it's read -- deliberately never
   * `process.cwd()`, which is meaningless once packaged (see AGENTS.md).
   */
  workspaceDir: string;
}

const DEFAULT_SETTINGS: SettingsSchema = {
  apiKey: "",
  baseUrl: "",
  model: "",
  workspaceDir: "",
};

/**
 * Thin wrapper around electron-store. Kept isolated so the rest of the main
 * process does not depend on the storage implementation directly.
 */
export class SettingsStore {
  private store: StoreType<SettingsSchema> | null = null;

  private async load() {
    if (this.store) return this.store;
    const { default: Store } = await import("electron-store");
    this.store = new Store<SettingsSchema>({
      name: "provider-settings",
      defaults: DEFAULT_SETTINGS,
    });
    return this.store;
  }

  async get(): Promise<StoredSettings> {
    const store = await this.load();

    // The user has never explicitly saved an API key: fall back to whatever
    // default provider/model is already configured in ~/.pi/agent, so the
    // app can chat on first launch without a manual API key entry.
    if (!store.get("apiKey")) {
      const piDefault = await resolvePiDefault();
      if (piDefault) {
        return {
          apiKey: piDefault.apiKey,
          baseUrl: piDefault.baseUrl,
          model: piDefault.model,
        };
      }
    }

    return {
      apiKey: store.get("apiKey"),
      baseUrl: store.get("baseUrl"),
      model: store.get("model"),
    };
  }

  async getSummary(): Promise<ProviderSettingsSummary> {
    const settings = await this.get();
    return {
      baseUrl: settings.baseUrl,
      model: settings.model,
      hasApiKey: settings.apiKey.length > 0,
    };
  }

  /**
   * True only when the user has explicitly saved their own provider
   * settings (as opposed to `get()`'s `.pi/agent`-derived fallback). Used to
   * decide whether the app's own settings.json should be registered as its
   * own model source -- registering the *fallback* value would just
   * duplicate whatever `.pi/agent` provider it was derived from, under a
   * misleading "app-settings" label.
   */
  async hasSavedApiKey(): Promise<boolean> {
    const store = await this.load();
    return Boolean(store.get("apiKey"));
  }

  async save(settings: ProviderSettings): Promise<void> {
    const store = await this.load();
    if (settings.apiKey) {
      store.set("apiKey", settings.apiKey);
    }
    store.set("baseUrl", settings.baseUrl);
    store.set("model", settings.model);
  }

  /**
   * Returns the persisted workspace directory, defaulting to (and
   * persisting) the user's home directory on first read. Never
   * `process.cwd()` -- a packaged AppImage's launch cwd is meaningless
   * (see AGENTS.md).
   */
  async getWorkspaceDir(): Promise<string> {
    const store = await this.load();
    const saved = store.get("workspaceDir");
    if (saved) return saved;
    const fallback = os.homedir();
    store.set("workspaceDir", fallback);
    return fallback;
  }

  async setWorkspaceDir(dir: string): Promise<void> {
    const store = await this.load();
    store.set("workspaceDir", dir);
  }
}

export type { ChatMessage };
