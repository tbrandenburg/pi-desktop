import { type BrowserWindow, ipcMain } from "electron";
import {
  startChatRequestSchema,
  providerSettingsSchema,
  sessionRecordSchema,
} from "../shared/schemas";
import type { ModelInfo } from "../shared/events";
import { ChatService } from "./llm/chat-service";
import { SettingsStore } from "./storage/settings-store";
import { SessionStore } from "./storage/session-store";

const CURATED_MODELS: ModelInfo[] = [
  { id: "gpt-4o-mini", label: "GPT-4o mini" },
  { id: "gpt-4o", label: "GPT-4o" },
  { id: "gpt-4.1-mini", label: "GPT-4.1 mini" },
];

export function registerIpcHandlers(getWindow: () => BrowserWindow | null): void {
  const settingsStore = new SettingsStore();
  const sessionStore = new SessionStore();
  const chatService = new ChatService(settingsStore, getWindow);

  ipcMain.handle("llm:list-models", async (): Promise<ModelInfo[]> => {
    return CURATED_MODELS;
  });

  ipcMain.handle("llm:start-chat", async (_event, rawRequest: unknown) => {
    const request = startChatRequestSchema.parse(rawRequest);
    const requestId = await chatService.startChat(request);
    return { requestId };
  });

  ipcMain.handle("llm:cancel-chat", async (_event, requestId: string) => {
    chatService.cancel(requestId);
  });

  ipcMain.handle("settings:save", async (_event, rawSettings: unknown) => {
    const settings = providerSettingsSchema.parse(rawSettings);
    await settingsStore.save(settings);
  });

  ipcMain.handle("settings:get", async () => {
    return settingsStore.getSummary();
  });

  ipcMain.handle("sessions:list", async () => {
    return sessionStore.list();
  });

  ipcMain.handle("sessions:get", async (_event, id: string) => {
    return sessionStore.get(id);
  });

  ipcMain.handle("sessions:save", async (_event, rawSession: unknown) => {
    const session = sessionRecordSchema.parse(rawSession);
    await sessionStore.save(session);
  });

  ipcMain.handle("sessions:delete", async (_event, id: string) => {
    await sessionStore.delete(id);
  });
}
