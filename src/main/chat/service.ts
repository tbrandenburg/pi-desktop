import { randomUUID } from "node:crypto";
import path from "node:path";
import type { BrowserWindow } from "electron";
import type { ChatEvent, StartChatRequest } from "../../shared/events";
import { buildModelsRegistry, findModelById, qualifyModelId, APP_SETTINGS_PROVIDER_ID, type ModelsRegistry } from "../model/registry";
import type { SettingsStore } from "../settings/store";
import { AgentRuntime } from "../agent/runtime";

async function loadModelsRegistryForChat(
  settings: { apiKey: string; baseUrl: string; model: string },
): Promise<ModelsRegistry> {
  return buildModelsRegistry(undefined, undefined, settings);
}

/**
 * Owns all active streaming requests. Runs entirely in the Electron main
 * process; the renderer only ever sees `ChatEvent` objects via IPC.
 *
 * Chat turns are delegated to `AgentRuntime` (an `AgentHarness` wrapper),
 * which owns the tool-execution loop, context compaction, and cwd-scoped
 * session persistence (`JsonlSessionRepo`) -- this class no longer talks
 * directly to pi-ai's low-level `Models.stream()`.
 */
export class ChatService {
  private activeAborts = new Map<string, AbortController>();

  constructor(
    private readonly settingsStore: SettingsStore,
    private readonly getWindow: () => BrowserWindow | null,
    private readonly loadModelsRegistry: (
      settings: { apiKey: string; baseUrl: string; model: string },
    ) => Promise<ModelsRegistry> = loadModelsRegistryForChat,
    private readonly getWorkspaceDir: () => string = () => process.cwd(),
    private readonly agentRuntime: AgentRuntime = new AgentRuntime(),
  ) {}

  async startChat(request: StartChatRequest): Promise<string> {
    const requestId = randomUUID();
    const controller = new AbortController();
    this.activeAborts.set(requestId, controller);

    void this.runChat(requestId, request, controller.signal);

    return requestId;
  }

  cancel(requestId: string): void {
    this.activeAborts.get(requestId)?.abort();
  }

  private emit(event: ChatEvent): void {
    const win = this.getWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send("chat:event", event);
  }

  private async runChat(
    requestId: string,
    request: StartChatRequest,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const settings = await this.settingsStore.get();
      if (!settings.apiKey) {
        this.emit({
          type: "error",
          requestId,
          message:
            "No API key configured. Open settings and add a provider API key first.",
        });
        return;
      }

      // `request.model` (from the renderer's selected model) is always
      // already fully-qualified (`provider/modelId`, see `qualifyModelId`).
      // `settings.model` (StoredSettings, the defensive fallback used only
      // when the renderer somehow didn't send one) is always a *bare* model
      // id scoped to the app's own single-slot provider, so it must be
      // qualified before `findModelById` can resolve it.
      const modelId =
        request.model || (settings.model && qualifyModelId(APP_SETTINGS_PROVIDER_ID, settings.model));
      if (!modelId) {
        this.emit({
          type: "error",
          requestId,
          message: "No model selected. Choose a model before sending a message.",
        });
        return;
      }

      const registry = await this.loadModelsRegistry(settings);
      const found = findModelById(registry.models, modelId);
      if (!found) {
        this.emit({
          type: "error",
          requestId,
          message: `Model "${modelId}" is not configured. Open settings and select a configured model.`,
        });
        return;
      }

      await this.agentRuntime.run({
        requestId,
        request,
        cwd: path.resolve(this.getWorkspaceDir()),
        models: registry.models,
        model: found.model,
        signal,
        emit: (event) => this.emit(event),
      });
    } catch (error) {
      this.emit({
        type: "error",
        requestId,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.activeAborts.delete(requestId);
    }
  }
}
