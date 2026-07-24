import { type BrowserWindow, ipcMain } from "electron";
import {
  startChatRequestSchema,
  providerSettingsSchema,
  sessionRecordSchema,
} from "../shared/schemas";
import type { ModelInfo } from "../shared/events";
import { ChatService } from "./llm/chat-service";
import { listConfiguredModels, resolvePiDefault } from "./llm/pi-config";
import { SettingsStore } from "./storage/settings-store";
import { SessionStore } from "./storage/session-store";

export function registerIpcHandlers(getWindow: () => BrowserWindow | null): void {
  const settingsStore = new SettingsStore();
  const sessionStore = new SessionStore();
  const chatService = new ChatService(settingsStore, getWindow);

  ipcMain.handle("llm:list-models", async (): Promise<ModelInfo[]> => {
    // The model list is sourced entirely from the providers configured in
    // `.pi/agent` (project-local, then global) -- no hardcoded placeholder
    // models. If the user hasn't saved their own settings yet, the model
    // resolved from `.pi/agent` is put first so it's selected by default
    // and chat works out of the box.
    const settings = await settingsStore.get();
    // Only register the app's own settings as their own model source when
    // the user actually saved them explicitly -- `settings` here may just be
    // resolvePiDefault()'s .pi/agent-derived fallback (see SettingsStore.get()),
    // and registering that as a separate "app-settings" provider would just
    // duplicate the underlying .pi/agent provider under a misleading label.
    const hasSavedApiKey = await settingsStore.hasSavedApiKey();
    const models = await listConfiguredModels(
      undefined,
      undefined,
      hasSavedApiKey ? settings : undefined,
    );
    const piDefault = await resolvePiDefault();

    if (piDefault && piDefault.model === settings.model) {
      const defaultEntry =
        models.find((m) => m.id === piDefault.model) ?? { id: piDefault.model, label: piDefault.label };
      return [defaultEntry, ...models.filter((m) => m.id !== piDefault.model)];
    }

    return models;
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
