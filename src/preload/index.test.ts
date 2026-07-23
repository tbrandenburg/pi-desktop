import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatEvent } from "../shared/events";

// Fakes the two Electron primitives the preload script is allowed to touch,
// so this test exercises the real preload module end-to-end: it verifies
// contextBridge.exposeInMainWorld is called with the exact channel names
// expected by src/main/ipc.ts, and that onChatEvent's subscribe/unsubscribe
// closure actually adds/removes the "chat:event" listener.
const exposed = new Map<string, unknown>();
const rendererListeners = new Map<string, (...args: unknown[]) => void>();

vi.mock("electron", () => {
  return {
    contextBridge: {
      exposeInMainWorld: (name: string, api: unknown) => {
        exposed.set(name, api);
      },
    },
    ipcRenderer: {
      invoke: vi.fn((channel: string, ...args: unknown[]) =>
        Promise.resolve({ channel, args }),
      ),
      on: (channel: string, listener: (...args: unknown[]) => void) => {
        rendererListeners.set(channel, listener);
      },
      removeListener: (channel: string, listener: (...args: unknown[]) => void) => {
        if (rendererListeners.get(channel) === listener) {
          rendererListeners.delete(channel);
        }
      },
    },
  };
});

describe("preload bridge integration", () => {
  beforeEach(async () => {
    exposed.clear();
    rendererListeners.clear();
    vi.resetModules();
    await import("./index");
  });

  it("exposes desktopApi on the main world with channel names matching the main-process IPC handlers", async () => {
    const { ipcRenderer } = (await import("electron")) as unknown as {
      ipcRenderer: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    const api = exposed.get("desktopApi") as {
      listModels: () => Promise<unknown>;
      startChat: (r: unknown) => Promise<unknown>;
      cancelChat: (id: string) => Promise<unknown>;
      saveProviderSettings: (s: unknown) => Promise<unknown>;
      getProviderSettings: () => Promise<unknown>;
    };
    expect(api).toBeDefined();

    await api.listModels();
    await api.startChat({ conversationId: "c1", model: "gpt-4o", messages: [] });
    await api.cancelChat("req-1");
    await api.saveProviderSettings({ baseUrl: "https://api.openai.com/v1", model: "gpt-4o" });
    await api.getProviderSettings();

    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(1, "llm:list-models");
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(2, "llm:start-chat", {
      conversationId: "c1",
      model: "gpt-4o",
      messages: [],
    });
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(3, "llm:cancel-chat", "req-1");
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(4, "settings:save", {
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o",
    });
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(5, "settings:get");
  });

  it("exposes session channels matching the main-process session IPC handlers", async () => {
    const { ipcRenderer } = (await import("electron")) as unknown as {
      ipcRenderer: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    const api = exposed.get("desktopApi") as {
      listSessions: () => Promise<unknown>;
      getSession: (id: string) => Promise<unknown>;
      saveSession: (s: unknown) => Promise<unknown>;
      deleteSession: (id: string) => Promise<unknown>;
    };

    (ipcRenderer.invoke as ReturnType<typeof vi.fn>).mockClear();
    await api.listSessions();
    await api.getSession("s1");
    await api.saveSession({ id: "s1", title: "hi", model: "gpt-4o", updatedAt: 1, messages: [] });
    await api.deleteSession("s1");

    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(1, "sessions:list");
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(2, "sessions:get", "s1");
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(3, "sessions:save", {
      id: "s1",
      title: "hi",
      model: "gpt-4o",
      updatedAt: 1,
      messages: [],
    });
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(4, "sessions:delete", "s1");
  });

  it("subscribes onChatEvent to the chat:event channel and forwards decoded events, then unsubscribes cleanly", async () => {
    const api = exposed.get("desktopApi") as {
      onChatEvent: (listener: (event: ChatEvent) => void) => () => void;
    };
    const received: ChatEvent[] = [];
    const unsubscribe = api.onChatEvent((event) => received.push(event));

    expect(rendererListeners.has("chat:event")).toBe(true);

    const handler = rendererListeners.get("chat:event");
    const event: ChatEvent = { type: "text-delta", requestId: "req-1", text: "hi" };
    handler?.({}, event);
    expect(received).toEqual([event]);

    unsubscribe();
    expect(rendererListeners.has("chat:event")).toBe(false);
  });
});
