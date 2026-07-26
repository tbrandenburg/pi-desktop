import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BrowserWindow } from "electron";
import type { MutableModels } from "@earendil-works/pi-ai";
import { ChatService } from "./service";
import type { ModelsRegistry } from "../model/registry";
import type { SettingsStore } from "../settings/store";
import type { ChatEvent, StartChatRequest } from "../../shared/events";
import type { AgentRuntime, AgentRuntimeRunArgs } from "../agent/runtime";

// AgentRuntime wraps AgentHarness, which cannot run under Vitest's vm-based
// pool (see AGENTS.md / agent-core.ts doc comments). ChatService takes it as
// an injectable constructor dependency, so tests provide a fake runtime that
// exercises the exact same `emit` callback contract instead of a real
// harness -- this proves ChatService's own wiring (settings/model resolution,
// error paths, cancellation forwarding) without needing a real provider.
function makeRegistryLoader() {
  const model = {
    id: "gpt-4o-mini",
    name: "gpt-4o-mini",
    api: "openai-completions",
    provider: "app-settings",
    baseUrl: "https://api.openai.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
  };
  const provider = { id: "app-settings", getModels: () => [model] };
  const models = {
    getProvider: (id: string) => (id === "app-settings" ? provider : undefined),
    getProviders: () => [provider],
  } as unknown as MutableModels;
  return async (): Promise<ModelsRegistry> => ({ models });
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
    model: "app-settings/gpt-4o-mini",
    messages: [{ role: "user", content: "hello" }],
  };
}

function makeFakeRuntime(run: (args: AgentRuntimeRunArgs) => Promise<void>): AgentRuntime {
  return { run } as unknown as AgentRuntime;
}

describe("ChatService integration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("delegates a configured request to AgentRuntime.run with the resolved model + cwd", async () => {
    const run = vi.fn(async ({ requestId, emit }: AgentRuntimeRunArgs) => {
      emit({ type: "started", requestId });
      emit({ type: "text-delta", requestId, text: "Hello" });
      emit({ type: "usage", requestId, inputTokens: 12, outputTokens: 34 });
      emit({ type: "completed", requestId });
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
      makeRegistryLoader(),
      () => "/tmp/pi-desktop-workspace",
      makeFakeRuntime(run),
    );

    await service.startChat(makeRequest());
    await vi.waitFor(() => expect(sent.some((e) => e.type === "completed")).toBe(true));

    expect(sent.map((e) => e.type)).toEqual(["started", "text-delta", "usage", "completed"]);
    expect(run).toHaveBeenCalledTimes(1);
    const runArgs = run.mock.calls[0][0] as AgentRuntimeRunArgs;
    expect(runArgs.model.id).toBe("gpt-4o-mini");
    expect(runArgs.cwd).toBe("/tmp/pi-desktop-workspace");
  });

  it("emits a single error event and never calls AgentRuntime when no API key is configured", async () => {
    const run = vi.fn();

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
      makeRegistryLoader(),
      () => "/tmp/pi-desktop-workspace",
      makeFakeRuntime(run),
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
    expect(run).not.toHaveBeenCalled();
  });

  it("aborts AgentRuntime.run's signal on cancel", async () => {
    let capturedSignal: AbortSignal | undefined;
    const run = vi.fn(({ requestId, signal, emit }: AgentRuntimeRunArgs) => {
      capturedSignal = signal;
      return new Promise<void>((resolve) => {
        const onAbort = () => {
          emit({ type: "error", requestId, message: "Aborted" });
          resolve();
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
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
      makeRegistryLoader(),
      () => "/tmp/pi-desktop-workspace",
      makeFakeRuntime(run),
    );

    const requestId = await service.startChat(makeRequest());
    service.cancel(requestId);

    await vi.waitFor(() => expect(sent.some((e) => e.type === "error")).toBe(true));
    expect(capturedSignal?.aborted).toBe(true);
    const errorEvent = sent.find((e) => e.type === "error");
    expect(errorEvent).toMatchObject({ requestId, message: "Aborted" });

    // cancelling again must be a no-op, not throw, once the request has finished
    expect(() => service.cancel(requestId)).not.toThrow();
  });

  it("emits a single error event and never calls AgentRuntime when no model is selected", async () => {
    const run = vi.fn();

    const settingsStore = {
      get: vi.fn().mockResolvedValue({
        apiKey: "sk-test",
        baseUrl: "https://api.openai.com/v1",
        model: "",
      }),
    } as unknown as SettingsStore;

    const sent: ChatEvent[] = [];
    const service = new ChatService(
      settingsStore,
      () => makeFakeWindow(sent),
      makeRegistryLoader(),
      () => "/tmp/pi-desktop-workspace",
      makeFakeRuntime(run),
    );

    await service.startChat({ ...makeRequest(), model: "" });
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));

    expect(sent).toEqual([
      {
        type: "error",
        requestId: expect.any(String),
        message: "No model selected. Choose a model before sending a message.",
      },
    ]);
    expect(run).not.toHaveBeenCalled();
  });

  it("emits a single error event and never calls AgentRuntime when the resolved model is not configured", async () => {
    const run = vi.fn();

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
      makeRegistryLoader(),
      () => "/tmp/pi-desktop-workspace",
      makeFakeRuntime(run),
    );

    await service.startChat({ ...makeRequest(), model: "unknown-provider/does-not-exist" });
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));

    expect(sent).toEqual([
      {
        type: "error",
        requestId: expect.any(String),
        message:
          'Model "unknown-provider/does-not-exist" is not configured. Open settings and select a configured model.',
      },
    ]);
    expect(run).not.toHaveBeenCalled();
  });

  it("falls back to the qualified settings.model when request.model is empty", async () => {
    const run = vi.fn(async ({ requestId, emit }: AgentRuntimeRunArgs) => {
      emit({ type: "completed", requestId });
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
      makeRegistryLoader(),
      () => "/tmp/pi-desktop-workspace",
      makeFakeRuntime(run),
    );

    await service.startChat({ ...makeRequest(), model: "" });
    await vi.waitFor(() => expect(sent.some((e) => e.type === "completed")).toBe(true));

    expect(run).toHaveBeenCalledTimes(1);
    const runArgs = run.mock.calls[0][0] as AgentRuntimeRunArgs;
    expect(runArgs.model.id).toBe("gpt-4o-mini");
  });

  it("translates an AgentRuntime.run rejection into a ChatEvent error without throwing", async () => {
    const run = vi.fn(async ({ requestId, emit }: AgentRuntimeRunArgs) => {
      emit({ type: "started", requestId });
      throw new Error("rate limit exceeded");
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
      makeRegistryLoader(),
      () => "/tmp/pi-desktop-workspace",
      makeFakeRuntime(run),
    );

    await service.startChat(makeRequest());
    await vi.waitFor(() => expect(sent.some((e) => e.type === "error")).toBe(true));

    expect(sent.map((e) => e.type)).toEqual(["started", "error"]);
    const errorEvent = sent.find((e) => e.type === "error");
    expect(errorEvent).toMatchObject({ message: "rate limit exceeded" });
    expect(sent.some((e) => e.type === "completed")).toBe(false);
  });
});
