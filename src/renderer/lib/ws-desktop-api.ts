import type {
  AutocompleteSuggestion,
  ChatEvent,
  CommandInfo,
  DesktopAgentApi,
  ExtensionUIRequest,
  ExtensionUIResponse,
  ModelInfo,
  PackageInfo,
  ProviderSettings,
  ProviderSettingsSummary,
  SessionRecord,
  SessionSummary,
  ShortcutInfo,
  StartChatRequest,
  WorkspaceInfo,
} from "../../shared/events";

/**
 * Renderer-side transport for the opt-in local web bridge (issue #228):
 * implements the exact same `DesktopAgentApi` contract as the real preload
 * bridge (`src/preload/index.ts`), but over `fetch()` (request/response)
 * and one shared `WebSocket` (the 3 push/streaming subscriptions), so a
 * plain browser tab with no `ipcRenderer` can drive the real backend
 * instead of `createFakeDesktopApi()`'s canned data.
 */
async function call<T>(baseUrl: string, channel: string, ...args: unknown[]): Promise<T> {
  const response = await fetch(`${baseUrl}/api/${encodeURIComponent(channel)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ args }),
  });
  const body = (await response.json()) as { result?: T; error?: string };
  if (!response.ok) throw new Error(body.error ?? `Web bridge call "${channel}" failed (${response.status})`);
  return body.result as T;
}

interface BridgeMessage {
  channel: "model:list-updated" | "chat:event" | "extension-ui:request";
  payload: unknown;
}

/**
 * One shared `WebSocket` fanned out to every subscribed listener by
 * `channel`, reconnecting on drop -- mirrors the preload bridge's
 * `ipcRenderer.on(channel, ...)` semantics closely enough that
 * `on*` subscribers here need no renderer-component changes.
 */
class BridgeSocket {
  private socket: WebSocket | null = null;
  private readonly listeners = new Map<BridgeMessage["channel"], Set<(payload: unknown) => void>>();

  constructor(private readonly wsUrl: string) {
    this.connect();
  }

  private connect(): void {
    const socket = new WebSocket(this.wsUrl);
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data as string) as BridgeMessage;
      for (const listener of this.listeners.get(message.channel) ?? []) listener(message.payload);
    };
    socket.onclose = () => {
      if (this.socket === socket) setTimeout(() => this.connect(), 1000);
    };
    this.socket = socket;
  }

  on(channel: BridgeMessage["channel"], listener: (payload: unknown) => void): () => void {
    const set = this.listeners.get(channel) ?? new Set();
    set.add(listener);
    this.listeners.set(channel, set);
    return () => set.delete(listener);
  }
}

export function createWebBridgeDesktopApi(baseUrl: string): DesktopAgentApi {
  const wsUrl = `${baseUrl.replace(/^http/, "ws")}/ws`;
  const bridgeSocket = new BridgeSocket(wsUrl);

  return {
    listModels(): Promise<ModelInfo[]> {
      return call(baseUrl, "model:list");
    },
    onModelListUpdated(listener: (models: ModelInfo[]) => void): () => void {
      return bridgeSocket.on("model:list-updated", (payload) => listener(payload as ModelInfo[]));
    },
    startChat(request: StartChatRequest): Promise<{ requestId: string }> {
      return call(baseUrl, "chat:start", request);
    },
    cancelChat(requestId: string): Promise<void> {
      return call(baseUrl, "chat:cancel", requestId);
    },
    saveProviderSettings(settings: ProviderSettings): Promise<void> {
      return call(baseUrl, "settings:save", settings);
    },
    getProviderSettings(): Promise<ProviderSettingsSummary> {
      return call(baseUrl, "settings:get");
    },
    onChatEvent(listener: (event: ChatEvent) => void): () => void {
      return bridgeSocket.on("chat:event", (payload) => listener(payload as ChatEvent));
    },
    listSessions(): Promise<SessionSummary[]> {
      return call(baseUrl, "sessions:list");
    },
    getSession(id: string): Promise<SessionRecord | null> {
      return call(baseUrl, "sessions:get", id);
    },
    deleteSession(id: string): Promise<void> {
      return call(baseUrl, "sessions:delete", id);
    },
    getWorkspace(): Promise<WorkspaceInfo> {
      return call(baseUrl, "workspace:get");
    },
    chooseWorkspace(): Promise<WorkspaceInfo | null> {
      // `dialog.showOpenDialog` has no browser equivalent (issue #228
      // non-goal) -- the bridge server itself rejects this with a clear
      // 501 error rather than a fake/degraded picker.
      return call(baseUrl, "workspace:choose");
    },
    getVersion(): Promise<string> {
      return call(baseUrl, "app:get-version");
    },
    listCommands(): Promise<CommandInfo[]> {
      return call(baseUrl, "chat:list-commands");
    },
    onExtensionUIRequest(listener: (request: ExtensionUIRequest) => void): () => void {
      return bridgeSocket.on("extension-ui:request", (payload) => listener(payload as ExtensionUIRequest));
    },
    respondExtensionUI(requestId: string, response: ExtensionUIResponse): Promise<void> {
      return call(baseUrl, "extension-ui:respond", requestId, response);
    },
    listPackages(): Promise<PackageInfo[]> {
      return call(baseUrl, "packages:list");
    },
    installPackage(source: string): Promise<PackageInfo> {
      return call(baseUrl, "packages:install", source);
    },
    removePackage(source: string): Promise<void> {
      return call(baseUrl, "packages:remove", source);
    },
    updatePackage(source: string): Promise<void> {
      return call(baseUrl, "packages:update", source);
    },
    getToolsExpanded(): Promise<boolean> {
      return call(baseUrl, "extension-ui:get-tools-expanded");
    },
    reportToolsExpanded(value: boolean): Promise<void> {
      return call(baseUrl, "extension-ui:report-tools-expanded", value);
    },
    getEditorText(): Promise<string> {
      return call(baseUrl, "extension-ui:get-editor-text");
    },
    reportEditorText(text: string): Promise<void> {
      return call(baseUrl, "extension-ui:report-editor-text", text);
    },
    queryAutocomplete(text: string): Promise<AutocompleteSuggestion[]> {
      return call(baseUrl, "extension-ui:query-autocomplete", text);
    },
    listShortcuts(): Promise<ShortcutInfo[]> {
      return call(baseUrl, "shortcuts:list");
    },
    triggerShortcut(id: string): Promise<void> {
      return call(baseUrl, "shortcuts:trigger", id);
    },
  };
}

/**
 * Probes whether a web-bridge server is reachable at `baseUrl` (issue #228
 * Phase 2) -- used by `desktop-api.ts`'s resolver to prefer the real
 * backend over the fake bridge whenever the bridge is enabled, without
 * requiring a build-time flag.
 */
export async function isWebBridgeReachable(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/app:get-version`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    return response.ok;
  } catch {
    return false;
  }
}
