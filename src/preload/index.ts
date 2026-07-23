import { contextBridge, ipcRenderer } from "electron";
import type {
  ChatEvent,
  DesktopLLMApi,
  ModelInfo,
  ProviderSettings,
  ProviderSettingsSummary,
  SessionRecord,
  SessionSummary,
  StartChatRequest,
} from "../shared/events";

const api: DesktopLLMApi = {
  listModels(): Promise<ModelInfo[]> {
    return ipcRenderer.invoke("llm:list-models");
  },

  startChat(request: StartChatRequest): Promise<{ requestId: string }> {
    return ipcRenderer.invoke("llm:start-chat", request);
  },

  cancelChat(requestId: string): Promise<void> {
    return ipcRenderer.invoke("llm:cancel-chat", requestId);
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

  saveSession(session: SessionRecord): Promise<void> {
    return ipcRenderer.invoke("sessions:save", session);
  },

  deleteSession(id: string): Promise<void> {
    return ipcRenderer.invoke("sessions:delete", id);
  },
};

contextBridge.exposeInMainWorld("desktopApi", api);
