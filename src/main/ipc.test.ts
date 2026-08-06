import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { registerIpcHandlers } from "./ipc";
import { realAgentCoreLoaders } from "./agent/test-support/real-agent-core-loaders";
import { realCodingAgentLoaders } from "./agent/test-support/real-coding-agent-loaders";

// This suite must be hermetic regardless of the machine's real ~/.pi/agent
// config, so .pi resolution is mocked here (tested separately in pi-config.test.ts).
vi.mock("./model/pi-config", () => ({
  resolvePiDefault: vi.fn(() => Promise.resolve(null)),
  listConfiguredModels: vi.fn(() => Promise.resolve([])),
}));

// In-memory fake replacing electron-store, so SettingsStore is exercised
// as in production without a real userData directory / Electron instance.
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
    app: {
      getVersion: () => "9.9.9-test",
    },
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
    dialog: {
      showOpenDialog: vi.fn(),
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
  let workspaceDir: string;
  let agentDir: string;
  let originalPiAgentDir: string | undefined;

  beforeEach(() => {
    memoryStore.clear();
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-ipc-workspace-"));
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-ipc-agent-"));
    // Isolates SessionService's `getAgentDir()`-based sessions directory
    // away from the real developer's `~/.pi/agent` (see
    // `session/service.test.ts` for the identical pattern).
    originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    memoryStore.set("workspaceDir", workspaceDir);
    registerIpcHandlers(() => null as unknown as BrowserWindow, {
      agentCoreLoaders: realAgentCoreLoaders,
      codingAgentLoaders: realCodingAgentLoaders,
    });
  });

  afterEach(() => {
    if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("persists provider settings, never leaks the raw API key back, and preserves it across a re-save without one", async () => {
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

    await invoke("settings:save", {
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
    });

    const updated = await invoke("settings:get");
    expect(updated).toEqual({
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
      invoke("chat:start", {
        conversationId: "",
        model: "gpt-4o",
        messages: [],
      }),
    ).rejects.toThrow();
  });

  it("cancels an unknown request id through the IPC boundary without throwing", async () => {
    // ChatService.cancel() is a no-op for unknown ids; verifies wiring.
    await expect(invoke("chat:cancel", "no-such-request")).resolves.toBeUndefined();
  });

  it("returns the real Electron app version, and an empty model list when nothing is configured", async () => {
    const version = await invoke("app:get-version");
    expect(version).toBe("9.9.9-test");
    expect(typeof version).toBe("string");

    const models = await invoke("model:list");
    expect(models).toEqual([]);
  });

  it("lists configured models, and reorders the resolved .pi/agent default to the front using its fully-qualified id", async () => {
    const { listConfiguredModels, resolvePiDefault } = await import("./model/pi-config");
    vi.mocked(listConfiguredModels).mockResolvedValue([
      { id: "llm7/minimax-m2.7", label: "llm7/minimax-m2.7" },
      { id: "llm7/gpt-oss:20b", label: "llm7/gpt-oss:20b" },
    ]);

    const plain = await invoke("model:list");
    expect(plain).toEqual([
      { id: "llm7/minimax-m2.7", label: "llm7/minimax-m2.7" },
      { id: "llm7/gpt-oss:20b", label: "llm7/gpt-oss:20b" },
    ]);

    // Regression: ResolvedPiDefault.model is a *bare* id, matched against
    // StoredSettings.model (also bare), while ModelInfo.id is always
    // fully-qualified ("provider/modelId"). Reordering must match against
    // `piDefault.label` (qualified), not `piDefault.model` (bare).
    vi.mocked(listConfiguredModels).mockResolvedValue([
      { id: "llm7/gpt-oss:20b", label: "llm7/gpt-oss:20b" },
      { id: "llm7/minimax-m2.7", label: "llm7/minimax-m2.7" },
    ]);
    vi.mocked(resolvePiDefault).mockResolvedValue({
      apiKey: "sk-test",
      baseUrl: "https://api.llm7.io/v1",
      model: "minimax-m2.7",
      label: "llm7/minimax-m2.7",
    });

    const reordered = await invoke("model:list");
    expect(reordered).toEqual([
      { id: "llm7/minimax-m2.7", label: "llm7/minimax-m2.7" },
      { id: "llm7/gpt-oss:20b", label: "llm7/gpt-oss:20b" },
    ]);

    vi.mocked(listConfiguredModels).mockResolvedValue([]);
    vi.mocked(resolvePiDefault).mockResolvedValue(null);
  });

  it("lists, gets, and deletes real cwd-scoped sessions through the IPC boundary", async () => {
    // Ensure currentWorkspaceDir resolved before writing directly via JsonlSessionRepo.
    expect(await invoke("workspace:get")).toEqual({ dir: workspaceDir });

    const { JsonlSessionRepo, Session } = await realAgentCoreLoaders.loadAgentCore!();
    const { NodeExecutionEnv } = await realAgentCoreLoaders.loadAgentCoreNode!();
    void Session;
    // Writes to the same `<agentDir>/sessions` root the now-fixed
    // `SessionService` reads from (issue #90 follow-up) -- previously this
    // wrote directly under `workspaceDir`, which matched the *old*,
    // pre-fix `SessionService` behavior.
    const env = new NodeExecutionEnv({ cwd: workspaceDir });
    const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: path.join(agentDir, "sessions") });
    const session = await repo.create({ cwd: workspaceDir, id: "s1" });
    await session.appendMessage({ role: "user", content: "Hello", timestamp: Date.now() });

    const sessions = await invoke("sessions:list");
    expect(sessions).toEqual([
      expect.objectContaining({ id: "s1", title: "Hello" }),
    ]);

    const record = (await invoke("sessions:get", "s1")) as { id: string; messages: unknown[] };
    expect(record.id).toBe("s1");
    expect(record.messages).toEqual([{ role: "user", content: "Hello" }]);

    await invoke("sessions:delete", "s1");
    expect(await invoke("sessions:get", "s1")).toBeNull();
    expect(await invoke("sessions:list")).toEqual([]);
  });

  it("returns the persisted workspace directory and switches it via workspace:choose", async () => {
    expect(await invoke("workspace:get")).toEqual({ dir: workspaceDir });

    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-ipc-workspace-other-"));
    try {
      const { dialog } = (await import("electron")) as unknown as {
        dialog: { showOpenDialog: ReturnType<typeof vi.fn> };
      };
      dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [otherDir] });

      const result = await invoke("workspace:choose");
      expect(result).toEqual({ dir: otherDir });
      expect(await invoke("workspace:get")).toEqual({ dir: otherDir });

      dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
      expect(await invoke("workspace:choose")).toBeNull();
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });
});
