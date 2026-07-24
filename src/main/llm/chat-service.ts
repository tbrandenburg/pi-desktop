import { randomUUID } from "node:crypto";
import type { AssistantMessageEvent, Context, Message } from "@earendil-works/pi-ai";
import type { BrowserWindow } from "electron";
import type { ChatEvent, StartChatRequest } from "../../shared/events";
import { buildModelsRegistry, findModelById, type ModelsRegistry } from "./models";
import type { SettingsStore } from "../storage/settings-store";

async function loadModelsRegistryForChat(
  settings: { apiKey: string; baseUrl: string; model: string },
): Promise<ModelsRegistry> {
  return buildModelsRegistry(undefined, undefined, settings);
}

function toContext(request: StartChatRequest): Context {
  const messages: Message[] = request.messages.map((message) => {
    if (message.role === "user") {
      return { role: "user", content: message.content, timestamp: Date.now() };
    }
    return {
      role: "assistant",
      content: [{ type: "text", text: message.content }],
      api: "openai-completions",
      provider: "openai-compatible",
      model: request.model,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
  });
  return { messages };
}

/**
 * Owns all active streaming requests. Runs entirely in the Electron main
 * process; the renderer only ever sees `ChatEvent` objects via IPC.
 */
export class ChatService {
  private activeRequests = new Map<string, AbortController>();

  constructor(
    private readonly settingsStore: SettingsStore,
    private readonly getWindow: () => BrowserWindow | null,
    private readonly loadModelsRegistry: (
      settings: { apiKey: string; baseUrl: string; model: string },
    ) => Promise<ModelsRegistry> = loadModelsRegistryForChat,
  ) {}

  async startChat(request: StartChatRequest): Promise<string> {
    const requestId = randomUUID();
    const controller = new AbortController();
    this.activeRequests.set(requestId, controller);

    void this.runChat(requestId, request, controller.signal);

    return requestId;
  }

  cancel(requestId: string): void {
    this.activeRequests.get(requestId)?.abort();
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

      const modelId = request.model || settings.model;
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

      const context = toContext(request);

      this.emit({ type: "started", requestId });

      const events = registry.models.stream(found.model, context, { signal });

      for await (const event of events as AsyncIterable<AssistantMessageEvent>) {
        this.forward(requestId, event);
      }
    } catch (error) {
      this.emit({
        type: "error",
        requestId,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.activeRequests.delete(requestId);
    }
  }

  private forward(requestId: string, event: AssistantMessageEvent): void {
    switch (event.type) {
      case "text_delta":
        this.emit({ type: "text-delta", requestId, text: event.delta });
        return;
      case "thinking_delta":
        this.emit({ type: "reasoning-delta", requestId, text: event.delta });
        return;
      case "toolcall_end":
        this.emit({
          type: "tool-call",
          requestId,
          toolName: event.toolCall.name,
          arguments: event.toolCall.arguments,
        });
        return;
      case "done":
        this.emit({
          type: "usage",
          requestId,
          inputTokens: event.message.usage.input,
          outputTokens: event.message.usage.output,
        });
        this.emit({ type: "completed", requestId });
        return;
      case "error":
        this.emit({
          type: "error",
          requestId,
          message: event.error.errorMessage ?? "Unknown streaming error",
        });
        return;
      default:
        return;
    }
  }
}
