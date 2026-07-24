import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { registerIpcHandlers } from "./ipc";

// This suite must be hermetic regardless of what the machine's real
// ~/.pi/agent config happens to contain, so .pi resolution is mocked and
// tested separately in pi-config.test.ts.
vi.mock("./llm/pi-config", () => ({
  resolvePiDefault: vi.fn(() => Promise.resolve(null)),
  listConfiguredModels: vi.fn(() => Promise.resolve([])),
}));

// In-memory fake replacing electron-store, so SettingsStore is exercised
// exactly as in production while avoiding any dependency on a real
// userData directory / Electron app instance.
const memoryStore = new Map<string, unknown>();
vi.mock("electron-store", () => {
  return {
    default: class FakeStore {
      private defaults: Record<string, unknown>;
      constructor(options: { defaults: Record<string, unknown> }) {
        this.defaults = options.defaults;
      }
      get(key: string) {
        return memoryStore.has(key) ? memoryStore.get(key) : this.defaults[key];
      }
      set(key: string, value: unknown) {
        memoryStore.set(key, value);
      }
    },
  };
});

vi.mock("electron", () => {
  const handlers = new Map<
    string,
    (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
  >();
  return {
    ipcMain: {
      handle: (
        channel: string,
        listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
      ) => {
        handlers.set(channel, listener);
      },
      // test-only accessor, not part of the real electron API
      __handlers: handlers,
    },
  };
});

async function invoke(channel: string, ...args: unknown[]) {
  const { ipcMain } = (await import("electron")) as unknown as {
    ipcMain: {
      __handlers: Map<
        string,
        (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
      >;
    };
  };
  const handler = ipcMain.__handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler({} as IpcMainInvokeEvent, ...args);
}

describe("IPC settings round-trip integration", () => {
  beforeEach(() => {
    memoryStore.clear();
    registerIpcHandlers(() => null as unknown as BrowserWindow);
  });

  it("persists provider settings and never leaks the raw API key back to the renderer", async () => {
    await invoke("settings:save", {
      apiKey: "sk-super-secret",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o",
    });

    const summary = await invoke("settings:get");

    expect(summary).toEqual({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o",
      hasApiKey: true,
    });
    expect(JSON.stringify(summary)).not.toContain("sk-super-secret");
  });

  it("preserves the previously stored API key when settings are re-saved without one", async () => {
    await invoke("settings:save", {
      apiKey: "sk-original",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o",
    });

    await invoke("settings:save", {
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
    });

    const summary = await invoke("settings:get");
    expect(summary).toEqual({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      hasApiKey: true,
    });
  });

  it("rejects malformed IPC payloads at the schema boundary instead of reaching storage", async () => {
    await expect(
      invoke("settings:save", {
        apiKey: "sk-test",
        baseUrl: "not-a-valid-url",
        model: "gpt-4o",
      }),
    ).rejects.toThrow();

    await expect(
      invoke("llm:start-chat", {
        conversationId: "",
        model: "gpt-4o",
        messages: [],
      }),
    ).rejects.toThrow();
  });

  it("returns an empty model list when nothing is configured, rather than a fake placeholder model", async () => {
    const models = await invoke("llm:list-models");
    expect(models).toEqual([]);
  });

  it("returns models sourced from configured .pi providers, with the resolved default first", async () => {
    const { listConfiguredModels } = await import("./llm/pi-config");
    vi.mocked(listConfiguredModels).mockResolvedValue([
      { id: "llm7/minimax-m2.7", label: "llm7/minimax-m2.7" },
      { id: "llm7/gpt-oss:20b", label: "llm7/gpt-oss:20b" },
    ]);

    const models = await invoke("llm:list-models");

    expect(models).toEqual([
      { id: "llm7/minimax-m2.7", label: "llm7/minimax-m2.7" },
      { id: "llm7/gpt-oss:20b", label: "llm7/gpt-oss:20b" },
    ]);

    vi.mocked(listConfiguredModels).mockResolvedValue([]);
  });

  it("cancels an unknown request id through the IPC boundary without throwing", async () => {
    // ChatService.cancel() is a no-op for unknown/completed request ids; this
    // verifies the llm:cancel-chat handler wires through to it correctly
    // instead of only testing ChatService directly (see chat-service.test.ts).
    await expect(invoke("llm:cancel-chat", "no-such-request")).resolves.toBeUndefined();
  });

  it("saves, lists, gets, and deletes sessions through the IPC boundary", async () => {
    await invoke("sessions:save", {
      id: "s1",
      title: "Hello",
      model: "gpt-4o",
      updatedAt: 1,
      messages: [{ role: "user", content: "Hello" }],
    });

    expect(await invoke("sessions:list")).toEqual([
      { id: "s1", title: "Hello", model: "gpt-4o", updatedAt: 1 },
    ]);
    expect(await invoke("sessions:get", "s1")).toEqual({
      id: "s1",
      title: "Hello",
      model: "gpt-4o",
      updatedAt: 1,
      messages: [{ role: "user", content: "Hello" }],
    });

    await invoke("sessions:delete", "s1");
    expect(await invoke("sessions:get", "s1")).toBeNull();
    expect(await invoke("sessions:list")).toEqual([]);
  });

  it("rejects a malformed session payload at the schema boundary", async () => {
    await expect(
      invoke("sessions:save", { id: "", title: "x", model: "gpt-4o", updatedAt: 1, messages: [] }),
    ).rejects.toThrow();
  });
});
