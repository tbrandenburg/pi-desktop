import type StoreType from "electron-store";
import type {
  ChatMessage,
  ProviderSettings,
  ProviderSettingsSummary,
} from "../../shared/events";

export interface StoredSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
}

const DEFAULT_SETTINGS: StoredSettings = {
  apiKey: "",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
};

/**
 * Thin wrapper around electron-store. Kept isolated so the rest of the main
 * process does not depend on the storage implementation directly.
 */
export class SettingsStore {
  private store: StoreType<StoredSettings> | null = null;

  private async load() {
    if (this.store) return this.store;
    const { default: Store } = await import("electron-store");
    this.store = new Store<StoredSettings>({
      name: "provider-settings",
      defaults: DEFAULT_SETTINGS,
    });
    return this.store;
  }

  async get(): Promise<StoredSettings> {
    const store = await this.load();
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

  async save(settings: ProviderSettings): Promise<void> {
    const store = await this.load();
    if (settings.apiKey) {
      store.set("apiKey", settings.apiKey);
    }
    store.set("baseUrl", settings.baseUrl);
    store.set("model", settings.model);
  }
}

export type { ChatMessage };
