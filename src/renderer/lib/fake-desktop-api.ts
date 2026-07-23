import type { DesktopLLMApi, SessionRecord } from "../../shared/events";

/**
 * In-memory stand-in for the Electron preload bridge, used only when the app
 * is opened in a plain browser tab (no `window.desktopApi`, e.g. the Vite
 * dev server without Electron). Lets the whole renderer — session browsing,
 * model selection, multi-turn streaming — be exercised with a normal browser
 * automation tool, without touching Electron, Node, or a real LLM provider.
 * Never used inside the packaged app: Electron's preload script always
 * injects the real `window.desktopApi` before any renderer script runs.
 */
export function createFakeDesktopApi(): DesktopLLMApi {
  const sessions = new Map<string, SessionRecord>();
  let listener: ((event: import("../../shared/events").ChatEvent) => void) | null = null;

  return {
    async listModels() {
      return [
        { id: "fake-mini", label: "Fake Mini (browser test)" },
        { id: "fake-pro", label: "Fake Pro (browser test)" },
      ];
    },

    async startChat(request) {
      const requestId = crypto.randomUUID();
      const reply = `Echo (${request.model}): ${request.messages.at(-1)?.content ?? ""}`;
      queueMicrotask(async () => {
        listener?.({ type: "started", requestId });
        for (const word of reply.split(" ")) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          listener?.({ type: "text-delta", requestId, text: `${word} ` });
        }
        listener?.({ type: "completed", requestId });
      });
      return { requestId };
    },

    async cancelChat() {},

    async saveProviderSettings() {},

    async getProviderSettings() {
      return { baseUrl: "https://fake.local/v1", model: "fake-mini", hasApiKey: true };
    },

    onChatEvent(callback) {
      listener = callback;
      return () => {
        listener = null;
      };
    },

    async listSessions() {
      return [...sessions.values()]
        .map(({ id, title, model, updatedAt }) => ({ id, title, model, updatedAt }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    },

    async getSession(id) {
      return sessions.get(id) ?? null;
    },

    async saveSession(session) {
      sessions.set(session.id, session);
    },

    async deleteSession(id) {
      sessions.delete(id);
    },
  };
}
