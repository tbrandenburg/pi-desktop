import type { DesktopAgentApi, PackageInfo, SessionRecord } from "../../shared/events";

/**
 * Reads the `?fakeModels=` query param from the current browser URL to force
 * edge-case states in the fake desktop API without hand-editing this file
 * (see AGENTS.md lesson 13). Add new cases here as new edge cases arise.
 */
function fakeModelsOverride(): "empty" | null {
  const value = new URLSearchParams(window.location.search).get("fakeModels");
  return value === "empty" ? "empty" : null;
}

/**
 * In-memory stand-in for the Electron preload bridge, used only when the app
 * is opened in a plain browser tab (no `window.desktopApi`, e.g. the Vite
 * dev server without Electron). Lets the whole renderer — session browsing,
 * model selection, multi-turn streaming — be exercised with a normal browser
 * automation tool, without touching Electron, Node, or a real LLM provider.
 * Never used inside the packaged app: Electron's preload script always
 * injects the real `window.desktopApi` before any renderer script runs.
 */
export function createFakeDesktopApi(): DesktopAgentApi {
  const sessions = new Map<string, SessionRecord>();
  let listener: ((event: import("../../shared/events").ChatEvent) => void) | null = null;
  let modelListListener: ((models: import("../../shared/events").ModelInfo[]) => void) | null = null;
  let workspaceDir = "/home/fake-user";
  // Small in-memory package list -- no real install logic here, just
  // enough shape (source) to keep the Settings UI's package list
  // section exercisable in the browser dev harness (see AGENTS.md lesson #14).
  const packages: PackageInfo[] = [];
  let toolsExpanded = false;
  let editorText = "";

  return {
    async listModels() {
      if (fakeModelsOverride() === "empty") return [];
      return [
        { id: "fake-mini", label: "Fake Mini (browser test)", providerId: "fake", configured: true },
        { id: "fake-pro", label: "Fake Pro (browser test)", providerId: "fake", configured: true },
      ];
    },

    onModelListUpdated(callback) {
      // The real bridge only pushes partial results while a real, slow
      // extension-activation pass is in flight (issue #167 part C). This
      // harness has no such slow path -- deliver a short-delayed partial
      // (a subset) before `listModels()` above resolves, purely so the
      // progressive-merge code path in `chat-store.ts` is exercised by the
      // browser dev harness too, then never fire again.
      modelListListener = callback;
      if (fakeModelsOverride() !== "empty") {
        setTimeout(() => {
          modelListListener?.([{ id: "fake-mini", label: "Fake Mini (browser test)", providerId: "fake", configured: true }]);
        }, 5);
      }
      return () => {
        modelListListener = null;
      };
    },

    async startChat(request) {
      const requestId = crypto.randomUUID();
      const reply = `Echo (${request.model}): ${request.messages.at(-1)?.content ?? ""}`;
      queueMicrotask(async () => {
        listener?.({ type: "started", requestId });
        let content = "";
        for (const word of reply.split(" ")) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          content += `${word} `;
          listener?.({ type: "text-delta", requestId, text: `${word} ` });
        }
        listener?.({ type: "completed", requestId });
        // Mimic the real AgentHarness's automatic on-disk session writes:
        // the fake bridge persists the conversation itself instead of
        // relying on a renderer-initiated save call (there is none anymore).
        const firstUserMessage = request.messages.find((m) => m.role === "user");
        sessions.set(request.conversationId, {
          id: request.conversationId,
          title: firstUserMessage?.content.slice(0, 60) || "New chat",
          model: request.model,
          updatedAt: Date.now(),
          messages: [...request.messages, { role: "assistant", content: content.trim() }],
        });
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

    async deleteSession(id) {
      sessions.delete(id);
    },

    async getWorkspace() {
      return { dir: workspaceDir };
    },

    async chooseWorkspace() {
      // No native dialog in the browser dev harness; deterministically
      // "choose" a different fake folder so Sidebar/session-list refresh
      // behavior can still be exercised (see Milestone 6's scope decision).
      workspaceDir = workspaceDir === "/home/fake-user" ? "/home/fake-user/other-workspace" : "/home/fake-user";
      sessions.clear();
      return { dir: workspaceDir };
    },

    async getVersion() {
      return "0.0.0-dev";
    },

    async listCommands() {
      // No extensions in the browser dev harness -- an empty list is the
      // correct, honest fake (see AGENTS.md lesson #14: don't invent fake
      // data the real bridge wouldn't produce for an equivalent state).
      return [];
    },

    onExtensionUIRequest() {
      // No extension ever runs in this harness, so no UI request is ever
      // pushed -- return a no-op unsubscribe to satisfy the real interface.
      return () => {};
    },

    async respondExtensionUI() {},

    async listPackages() {
      return [...packages];
    },

    async installPackage(source) {
      // The fake harness auto-confirms the install (no real modal exists in
      // the browser dev harness) -- the real bridge always blocks on a
      // genuine confirm dialog instead, see `src/main/packages/service.ts`.
      const info: PackageInfo = { source: source.trim() };
      const existingIndex = packages.findIndex((p) => p.source === info.source);
      if (existingIndex >= 0) packages[existingIndex] = info;
      else packages.push(info);
      return info;
    },

    async removePackage(source) {
      const index = packages.findIndex((p) => p.source === source);
      if (index >= 0) packages.splice(index, 1);
    },

    async updatePackage() {},

    async getToolsExpanded() {
      return toolsExpanded;
    },

    async reportToolsExpanded(value) {
      toolsExpanded = value;
    },

    async getEditorText() {
      return editorText;
    },

    async reportEditorText(text) {
      editorText = text;
    },

    async queryAutocomplete() {
      // No extensions run in this harness, so no provider ever registers --
      // an empty list is the honest fake (mirrors `listCommands()` above).
      return [];
    },

    async listShortcuts() {
      return [];
    },

    async triggerShortcut() {},
  };
}
