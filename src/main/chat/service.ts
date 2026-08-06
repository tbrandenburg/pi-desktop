import { randomUUID } from "node:crypto";
import path from "node:path";
import type { BrowserWindow } from "electron";
import type { ChatEvent, CommandInfo, ExtensionUIRequest, ExtensionUIResponse, StartChatRequest } from "../../shared/events";
import {
  buildModelsRegistry,
  findModelById,
  qualifyModelId,
  asBareModelId,
  asQualifiedModelId,
  APP_SETTINGS_PROVIDER_ID,
  type ModelsRegistry,
} from "../model/registry";
import type { SettingsStore } from "../settings/store";
import { AgentRuntime } from "../agent/runtime";
import { IpcUIContextBridge } from "../agent/ui-context";

async function loadModelsRegistryForChat(
  settings: { apiKey: string; baseUrl: string; model: string },
): Promise<ModelsRegistry> {
  return buildModelsRegistry(undefined, undefined, settings);
}

/**
 * Owns all active streaming requests. Runs entirely in the Electron main
 * process; the renderer only ever sees `ChatEvent` objects via IPC.
 *
 * Chat turns are delegated to `AgentRuntime` (a `pi-coding-agent`
 * `AgentSession` wrapper), which owns the tool-execution loop, context
 * compaction, and cwd-scoped session persistence -- this class no longer
 * talks directly to pi-ai's low-level `Models.stream()`.
 */
export class ChatService {
  private activeAborts = new Map<string, AbortController>();
  // Shared across every chat turn (ADR 0001 §3.4 Phase 2, issue #91):
  // `ctx.ui.*` dialog calls are keyed by their own generated request id, so
  // one bridge safely serves however many `AgentRuntime.run` sessions are
  // in flight -- no per-request instance needed.
  private readonly uiContextBridge: IpcUIContextBridge;

  constructor(
    private readonly settingsStore: SettingsStore,
    private readonly getWindow: () => BrowserWindow | null,
    private readonly loadModelsRegistry: (
      settings: { apiKey: string; baseUrl: string; model: string },
    ) => Promise<ModelsRegistry> = loadModelsRegistryForChat,
    private readonly getWorkspaceDir: () => string = () => process.cwd(),
    private readonly agentRuntime: AgentRuntime = new AgentRuntime(),
    /**
     * Shared `IpcUIContextBridge` instance, injected so `PackageService`'s
     * mandatory trust prompt (`../packages/service.ts`, issue #92) can reuse
     * this exact same real modal mechanism instead of a second, parallel
     * one -- see `ipc.ts`'s wiring. Defaults to constructing its own (as
     * before this param existed) when omitted, e.g. in every existing test.
     */
    uiContextBridge?: IpcUIContextBridge,
  ) {
    this.uiContextBridge = uiContextBridge ?? new IpcUIContextBridge((request) => this.emitExtensionUIRequest(request));
  }

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

  /** Lists `pi.registerCommand` slash-commands for the composer's `/` autocomplete. */
  async listCommands(): Promise<CommandInfo[]> {
    return this.agentRuntime.listCommands(path.resolve(this.getWorkspaceDir()));
  }

  /** Resolves a pending `select`/`confirm`/`input` extension UI dialog with the renderer's answer. */
  respondExtensionUI(requestId: string, response: ExtensionUIResponse): void {
    this.uiContextBridge.respond(requestId, response);
  }

  /**
   * Surfaces a real, blocking `confirm` modal in the renderer via the same
   * `ExtensionUIContext` IPC bridge used for `ctx.ui.confirm` calls made by
   * extensions -- reused as-is for `PackageService`'s mandatory trust
   * prompt (ADR 0001 §3.7, issue #92) instead of a second, parallel modal
   * mechanism.
   */
  confirmViaUI(title: string, message: string): Promise<boolean> {
    return this.uiContextBridge.uiContext.confirm(title, message);
  }

  private emitExtensionUIRequest(request: ExtensionUIRequest): void {
    const win = this.getWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send("extension-ui:request", request);
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
      const modelId = request.model
        ? asQualifiedModelId(request.model)
        : settings.model
          ? qualifyModelId(APP_SETTINGS_PROVIDER_ID, asBareModelId(settings.model))
          : undefined;
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
        providerId: found.providerId,
        model: found.model,
        apiKey: settings.apiKey,
        signal,
        emit: (event) => this.emit(event),
        uiContext: this.uiContextBridge.uiContext,
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
