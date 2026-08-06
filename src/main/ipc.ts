import { app, type BrowserWindow, dialog, ipcMain } from "electron";
import { startChatRequestSchema, providerSettingsSchema, workspaceDirSchema } from "../shared/schemas";
import type { CommandInfo, ExtensionUIResponse, ModelInfo, WorkspaceInfo } from "../shared/events";
import { ChatService } from "./chat/service";
import { listConfiguredModels, resolvePiDefault } from "./model/pi-config";
import { SettingsStore } from "./settings/store";
import { SessionService } from "./session/service";
import type { AgentCoreLoaders } from "./agent/core";
import type { CodingAgentLoaders } from "./agent/coding-agent-loaders";

export interface RegisterIpcHandlersDeps {
  agentCoreLoaders?: AgentCoreLoaders;
  codingAgentLoaders?: CodingAgentLoaders;
}

export function registerIpcHandlers(
  getWindow: () => BrowserWindow | null,
  deps: RegisterIpcHandlersDeps = {},
): void {
  const settingsStore = new SettingsStore();
  let currentWorkspaceDir = "";
  const getWorkspaceDir = () => currentWorkspaceDir;
  void settingsStore.getWorkspaceDir().then((dir) => {
    currentWorkspaceDir = dir;
  });

  const sessionService = new SessionService(getWorkspaceDir, deps.agentCoreLoaders, deps.codingAgentLoaders);
  const chatService = new ChatService(settingsStore, getWindow, undefined, getWorkspaceDir);

  ipcMain.handle("app:get-version", (): string => {
    return app.getVersion();
  });

  ipcMain.handle("model:list", async (): Promise<ModelInfo[]> => {
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

    // `piDefault.model` and `settings.model` are both *bare* model ids (see
    // ResolvedPiDefault/StoredSettings) -- equal here means the currently
    // active settings genuinely are this resolved .pi/agent default (not a
    // coincidental same-name match against an unrelated custom model),
    // since `settings.model` only ever equals `piDefault.model` when
    // SettingsStore.get() itself returned the fallback value. `models`
    // entries use the fully-qualified id (`piDefault.label`), so match on
    // that instead.
    if (piDefault && piDefault.model === settings.model) {
      const defaultEntry =
        models.find((m) => m.id === piDefault.label) ?? { id: piDefault.label, label: piDefault.label };
      return [defaultEntry, ...models.filter((m) => m.id !== piDefault.label)];
    }

    return models;
  });

  ipcMain.handle("chat:start", async (_event, rawRequest: unknown) => {
    const request = startChatRequestSchema.parse(rawRequest);
    const requestId = await chatService.startChat(request);
    return { requestId };
  });

  ipcMain.handle("chat:cancel", async (_event, requestId: string) => {
    chatService.cancel(requestId);
  });

  ipcMain.handle("chat:list-commands", async (): Promise<CommandInfo[]> => {
    return chatService.listCommands();
  });

  ipcMain.handle("extension-ui:respond", async (_event, requestId: string, response: ExtensionUIResponse) => {
    chatService.respondExtensionUI(requestId, response);
  });

  ipcMain.handle("settings:save", async (_event, rawSettings: unknown) => {
    const settings = providerSettingsSchema.parse(rawSettings);
    await settingsStore.save(settings);
  });

  ipcMain.handle("settings:get", async () => {
    return settingsStore.getSummary();
  });

  ipcMain.handle("sessions:list", async () => {
    return sessionService.list();
  });

  ipcMain.handle("sessions:get", async (_event, id: string) => {
    return sessionService.get(id);
  });

  ipcMain.handle("sessions:delete", async (_event, id: string) => {
    await sessionService.delete(id);
  });

  ipcMain.handle("workspace:get", async (): Promise<WorkspaceInfo> => {
    const dir = await settingsStore.getWorkspaceDir();
    currentWorkspaceDir = dir;
    return { dir };
  });

  ipcMain.handle("workspace:choose", async (): Promise<WorkspaceInfo | null> => {
    const win = getWindow();
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ["openDirectory"] })
      : await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (result.canceled || result.filePaths.length === 0) return null;

    const dir = workspaceDirSchema.parse(result.filePaths[0]);
    await settingsStore.setWorkspaceDir(dir);
    currentWorkspaceDir = dir;
    return { dir };
  });
}
