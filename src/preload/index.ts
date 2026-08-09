import { contextBridge, ipcRenderer } from "electron";
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
} from "../shared/events";

const api: DesktopAgentApi = {
  listModels(): Promise<ModelInfo[]> {
    return ipcRenderer.invoke("model:list");
  },

  onModelListUpdated(listener: (models: ModelInfo[]) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, models: ModelInfo[]) => listener(models);
    ipcRenderer.on("model:list-updated", handler);
    return () => ipcRenderer.removeListener("model:list-updated", handler);
  },

  startChat(request: StartChatRequest): Promise<{ requestId: string }> {
    return ipcRenderer.invoke("chat:start", request);
  },

  cancelChat(requestId: string): Promise<void> {
    return ipcRenderer.invoke("chat:cancel", requestId);
  },

  saveProviderSettings(settings: ProviderSettings): Promise<void> {
    return ipcRenderer.invoke("settings:save", settings);
  },

  getProviderSettings(): Promise<ProviderSettingsSummary> {
    return ipcRenderer.invoke("settings:get");
  },

  onChatEvent(listener: (event: ChatEvent) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, chatEvent: ChatEvent) =>
      listener(chatEvent);
    ipcRenderer.on("chat:event", handler);
    return () => ipcRenderer.removeListener("chat:event", handler);
  },

  listSessions(): Promise<SessionSummary[]> {
    return ipcRenderer.invoke("sessions:list");
  },

  getSession(id: string): Promise<SessionRecord | null> {
    return ipcRenderer.invoke("sessions:get", id);
  },

  deleteSession(id: string): Promise<void> {
    return ipcRenderer.invoke("sessions:delete", id);
  },

  getWorkspace(): Promise<WorkspaceInfo> {
    return ipcRenderer.invoke("workspace:get");
  },

  chooseWorkspace(): Promise<WorkspaceInfo | null> {
    return ipcRenderer.invoke("workspace:choose");
  },

  getVersion(): Promise<string> {
    return ipcRenderer.invoke("app:get-version");
  },

  listCommands(): Promise<CommandInfo[]> {
    return ipcRenderer.invoke("chat:list-commands");
  },

  onExtensionUIRequest(listener: (request: ExtensionUIRequest) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, request: ExtensionUIRequest) => listener(request);
    ipcRenderer.on("extension-ui:request", handler);
    return () => ipcRenderer.removeListener("extension-ui:request", handler);
  },

  respondExtensionUI(requestId: string, response: ExtensionUIResponse): Promise<void> {
    return ipcRenderer.invoke("extension-ui:respond", requestId, response);
  },

  listPackages(): Promise<PackageInfo[]> {
    return ipcRenderer.invoke("packages:list");
  },

  installPackage(source: string): Promise<PackageInfo> {
    return ipcRenderer.invoke("packages:install", source);
  },

  removePackage(source: string): Promise<void> {
    return ipcRenderer.invoke("packages:remove", source);
  },

  updatePackage(source: string): Promise<void> {
    return ipcRenderer.invoke("packages:update", source);
  },

  getToolsExpanded(): Promise<boolean> {
    return ipcRenderer.invoke("extension-ui:get-tools-expanded");
  },

  reportToolsExpanded(value: boolean): Promise<void> {
    return ipcRenderer.invoke("extension-ui:report-tools-expanded", value);
  },

  getEditorText(): Promise<string> {
    return ipcRenderer.invoke("extension-ui:get-editor-text");
  },

  reportEditorText(text: string): Promise<void> {
    return ipcRenderer.invoke("extension-ui:report-editor-text", text);
  },

  queryAutocomplete(text: string): Promise<AutocompleteSuggestion[]> {
    return ipcRenderer.invoke("extension-ui:query-autocomplete", text);
  },

  listShortcuts(): Promise<ShortcutInfo[]> {
    return ipcRenderer.invoke("shortcuts:list");
  },

  triggerShortcut(id: string): Promise<void> {
    return ipcRenderer.invoke("shortcuts:trigger", id);
  },
};

contextBridge.exposeInMainWorld("desktopApi", api);
