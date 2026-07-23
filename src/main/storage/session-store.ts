import type StoreType from "electron-store";
import type { SessionRecord, SessionSummary } from "../../shared/events";

interface SessionsSchema {
  sessions: Record<string, SessionRecord>;
}

/**
 * Persists conversations (message history + model + title) across app
 * restarts. Kept isolated behind a small store wrapper, same pattern as
 * `SettingsStore`, so the rest of the main process never touches
 * `electron-store` directly.
 */
export class SessionStore {
  private store: StoreType<SessionsSchema> | null = null;

  private async load() {
    if (this.store) return this.store;
    const { default: Store } = await import("electron-store");
    this.store = new Store<SessionsSchema>({
      name: "sessions",
      defaults: { sessions: {} },
    });
    return this.store;
  }

  async list(): Promise<SessionSummary[]> {
    const store = await this.load();
    const sessions = Object.values(store.get("sessions"));
    return sessions
      .map(({ id, title, model, updatedAt }) => ({ id, title, model, updatedAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: string): Promise<SessionRecord | null> {
    const store = await this.load();
    return store.get("sessions")[id] ?? null;
  }

  async save(session: SessionRecord): Promise<void> {
    const store = await this.load();
    const sessions = store.get("sessions");
    store.set("sessions", { ...sessions, [session.id]: session });
  }

  async delete(id: string): Promise<void> {
    const store = await this.load();
    const sessions = { ...store.get("sessions") };
    delete sessions[id];
    store.set("sessions", sessions);
  }
}
