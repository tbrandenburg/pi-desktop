import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { registerIpcHandlers } from "./ipc";

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

  it("returns the curated model list on llm:list-models", async () => {
    const models = await invoke("llm:list-models");
    expect(models).toEqual([
      { id: "gpt-4o-mini", label: "GPT-4o mini" },
      { id: "gpt-4o", label: "GPT-4o" },
      { id: "gpt-4.1-mini", label: "GPT-4.1 mini" },
    ]);
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
