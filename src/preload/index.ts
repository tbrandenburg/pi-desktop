import { contextBridge, ipcRenderer } from "electron";
import type {
  ChatEvent,
  CommandInfo,
  DesktopAgentApi,
  ExtensionUIRequest,
  ExtensionUIResponse,
  ModelInfo,
  ProviderSettings,
  ProviderSettingsSummary,
  SessionRecord,
  SessionSummary,
  StartChatRequest,
  WorkspaceInfo,
} from "../shared/events";

const api: DesktopAgentApi = {
  listModels(): Promise<ModelInfo[]> {
    return ipcRenderer.invoke("model:list");
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
};

contextBridge.exposeInMainWorld("desktopApi", api);
