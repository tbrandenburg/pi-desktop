import { randomUUID } from "node:crypto";
import type {
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Message,
  Model,
  OpenAICompletionsOptions,
} from "@earendil-works/pi-ai";
import type { BrowserWindow } from "electron";
import type { ChatEvent, StartChatRequest } from "../../shared/events";
import type { SettingsStore } from "../storage/settings-store";

// pi-ai ships as ESM-only and only exposes this subpath through its package.json
// "exports" map (not a real "dist/..." filesystem path), so the API module must
// be loaded with a dynamic import rather than a static one. The subpath isn't
// resolvable under this project's classic "Node" TS moduleResolution, so the
// module shape is declared manually here instead of via `typeof import(...)`.
interface OpenAICompletionsModule {
  stream: (
    model: Model<"openai-completions">,
    context: Context,
    options?: OpenAICompletionsOptions,
  ) => AssistantMessageEventStream;
}
let openAICompletionsModule: OpenAICompletionsModule | null = null;
const openAICompletionsSpecifier = "@earendil-works/pi-ai/api/openai-completions";
async function loadOpenAICompletions(): Promise<OpenAICompletionsModule> {
  if (!openAICompletionsModule) {
    openAICompletionsModule = (await import(
      openAICompletionsSpecifier
    )) as unknown as OpenAICompletionsModule;
  }
  return openAICompletionsModule;
}

function buildModel(baseUrl: string, modelId: string): Model<"openai-completions"> {
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: "openai-compatible",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
  };
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

      const model = buildModel(settings.baseUrl, request.model || settings.model);
      const context = toContext(request);

      this.emit({ type: "started", requestId });

      const { stream: openAICompletionsStream } = await loadOpenAICompletions();
      const events = openAICompletionsStream(model, context, {
        apiKey: settings.apiKey,
        signal,
      });

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
