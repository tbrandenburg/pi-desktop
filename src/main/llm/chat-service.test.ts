import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BrowserWindow } from "electron";
import { ChatService, type OpenAICompletionsModule } from "./chat-service";
import type { SettingsStore } from "../storage/settings-store";
import type { ChatEvent, StartChatRequest } from "../../shared/events";

// The real loader uses an indirect `new Function("...", "return import(...)")`
// call so tsc's CommonJS output can never downlevel it into a require() (see
// the comment on `nativeDynamicImport` in chat-service.ts for why that
// matters). That trick deliberately hides the import from static analysis,
// which also makes it invisible to vi.mock's module interception -- so
// ChatService takes the loader as an injectable constructor dependency
// instead, and tests provide a fake loader directly rather than mocking the
// "@earendil-works/pi-ai/api/openai-completions" module.
function makeLoader(stream: OpenAICompletionsModule["stream"]) {
  return async (): Promise<OpenAICompletionsModule> => ({ stream });
}

function makeFakeWindow(sent: ChatEvent[]) {
  return {
    isDestroyed: () => false,
    webContents: {
      send: (_channel: string, event: ChatEvent) => {
        sent.push(event);
      },
    },
  } as unknown as BrowserWindow;
}

function makeRequest(): StartChatRequest {
  return {
    conversationId: "conv-1",
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "hello" }],
  };
}

describe("ChatService integration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("streams pi-ai events end-to-end and translates them into the correct ChatEvent sequence", async () => {
    const stream = vi.fn().mockReturnValue(
      (async function* () {
        yield { type: "text_delta", delta: "Hel" };
        yield { type: "text_delta", delta: "lo" };
        yield { type: "thinking_delta", delta: "pondering" };
        yield {
          type: "toolcall_end",
          toolCall: { name: "search", arguments: { q: "x" } },
        };
        yield {
          type: "done",
          message: { usage: { input: 12, output: 34 } },
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      })() as any,
    );

    const settingsStore = {
      get: vi.fn().mockResolvedValue({
        apiKey: "sk-test",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
      }),
    } as unknown as SettingsStore;

    const sent: ChatEvent[] = [];
    const service = new ChatService(
      settingsStore,
      () => makeFakeWindow(sent),
      makeLoader(stream),
    );

    await service.startChat(makeRequest());
    // allow the fire-and-forget async stream loop to fully drain
    await vi.waitFor(() => expect(sent.some((e) => e.type === "completed")).toBe(true));

    expect(sent.map((e) => e.type)).toEqual([
      "started",
      "text-delta",
      "text-delta",
      "reasoning-delta",
      "tool-call",
      "usage",
      "completed",
    ]);
    const usageEvent = sent.find((e) => e.type === "usage");
    expect(usageEvent).toMatchObject({ inputTokens: 12, outputTokens: 34 });
  });

  it("emits a single error event and never calls the provider when no API key is configured", async () => {
    const stream = vi.fn();

    const settingsStore = {
      get: vi.fn().mockResolvedValue({
        apiKey: "",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
      }),
    } as unknown as SettingsStore;

    const sent: ChatEvent[] = [];
    const service = new ChatService(
      settingsStore,
      () => makeFakeWindow(sent),
      makeLoader(stream),
    );

    await service.startChat(makeRequest());
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));

    expect(sent).toEqual([
      {
        type: "error",
        requestId: expect.any(String),
        message: "No API key configured. Open settings and add a provider API key first.",
      },
    ]);
    expect(stream).not.toHaveBeenCalled();
  });

  it("aborts the underlying stream on cancel and surfaces the failure as an error event", async () => {
    const stream = vi
      .fn()
      .mockImplementation((_model: unknown, _context: unknown, options: { signal?: AbortSignal }) => {
        return (async function* () {
          await new Promise((_resolve, reject) => {
            const signal = options?.signal;
            if (signal?.aborted) {
              reject(new Error("Aborted"));
              return;
            }
            signal?.addEventListener("abort", () => reject(new Error("Aborted")));
          });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        })() as any;
      });

    const settingsStore = {
      get: vi.fn().mockResolvedValue({
        apiKey: "sk-test",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
      }),
    } as unknown as SettingsStore;

    const sent: ChatEvent[] = [];
    const service = new ChatService(
      settingsStore,
      () => makeFakeWindow(sent),
      makeLoader(stream),
    );

    const requestId = await service.startChat(makeRequest());
    service.cancel(requestId);

    await vi.waitFor(() => expect(sent.some((e) => e.type === "error")).toBe(true));
    const errorEvent = sent.find((e) => e.type === "error");
    expect(errorEvent).toMatchObject({ requestId, message: "Aborted" });

    // cancelling again must be a no-op, not throw, once the request has finished
    expect(() => service.cancel(requestId)).not.toThrow();
  });

  it("translates a native provider error event into a ChatEvent error without throwing", async () => {
    const stream = vi.fn().mockReturnValue(
      (async function* () {
        yield { type: "text_delta", delta: "partial" };
        yield {
          type: "error",
          error: { errorMessage: "rate limit exceeded" },
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      })() as any,
    );

    const settingsStore = {
      get: vi.fn().mockResolvedValue({
        apiKey: "sk-test",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
      }),
    } as unknown as SettingsStore;

    const sent: ChatEvent[] = [];
    const service = new ChatService(
      settingsStore,
      () => makeFakeWindow(sent),
      makeLoader(stream),
    );

    await service.startChat(makeRequest());
    await vi.waitFor(() => expect(sent.some((e) => e.type === "error")).toBe(true));

    expect(sent.map((e) => e.type)).toEqual(["started", "text-delta", "error"]);
    const errorEvent = sent.find((e) => e.type === "error");
    expect(errorEvent).toMatchObject({ message: "rate limit exceeded" });
    // no "completed" event should follow a mid-stream provider error
    expect(sent.some((e) => e.type === "completed")).toBe(false);
  });
});
