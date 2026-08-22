import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { createIpcHandlerRegistry } from "../ipc";
import { startWebBridgeServer, type WebBridgeServer } from "./server";
import { realAgentCoreLoaders } from "../agent/test-support/real-agent-core-loaders";
import { realCodingAgentLoaders } from "../agent/test-support/real-coding-agent-loaders";
import { invalidateModelsCache } from "../model/registry-cache";
import { clearAllStatus } from "../model/model-status";

// Same hermetic-isolation pattern as `ipc.test.ts`: this suite must not
// depend on the real machine's `~/.pi/agent` config.
vi.mock("../model/pi-config", () => ({
  resolvePiDefault: vi.fn(() => Promise.resolve(null)),
  listConfiguredModels: vi.fn(() => Promise.resolve([])),
}));

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

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getVersion: () => "9.9.9-test",
    getPath: () => "/tmp/pi-desktop-web-bridge-test-userdata",
  },
  ipcMain: { handle: () => {} },
  dialog: { showOpenDialog: vi.fn() },
}));

describe("web-bridge server (issue #228)", () => {
  let workspaceDir: string;
  let agentDir: string;
  let originalPiAgentDir: string | undefined;
  let server: WebBridgeServer;
  let baseUrl: string;

  beforeEach(async () => {
    memoryStore.clear();
    invalidateModelsCache();
    clearAllStatus();
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-web-bridge-workspace-"));
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-web-bridge-agent-"));
    originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    memoryStore.set("workspaceDir", workspaceDir);

    const registry = createIpcHandlerRegistry(() => null, {
      agentCoreLoaders: realAgentCoreLoaders,
      codingAgentLoaders: realCodingAgentLoaders,
    });
    server = await startWebBridgeServer(registry, 0);
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server.close();
    if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  async function post(channel: string, ...args: unknown[]) {
    const response = await fetch(`${baseUrl}/api/${channel}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args }),
    });
    return { status: response.status, body: (await response.json()) as { result?: unknown; error?: string } };
  }

  it("calls the exact same handler as ipcMain over plain HTTP request/response", async () => {
    const { status, body } = await post("app:get-version");
    expect(status).toBe(200);
    expect(body.result).toBe("9.9.9-test");
  });

  it("round-trips settings through the real SettingsStore behind the HTTP boundary, same as the Electron IPC path", async () => {
    const save = await post("settings:save", { apiKey: "sk-web-bridge-secret", baseUrl: "https://example.com", model: "example/model" });
    expect(save.status).toBe(200);

    const get = await post("settings:get");
    expect(get.status).toBe(200);
    expect(get.body.result).toMatchObject({ baseUrl: "https://example.com", model: "example/model" });
    // Never leaks the raw API key back over the bridge either.
    expect(JSON.stringify(get.body.result)).not.toContain("sk-web-bridge-secret");
  });

  it("returns 404 with a clear error for an unknown channel instead of a stack trace", async () => {
    const { status, body } = await post("not:a-real-channel");
    expect(status).toBe(404);
    expect(body.error).toMatch(/not:a-real-channel/);
  });

  it("rejects workspace:choose with a clear unsupported error (issue #228 non-goal: no native file picker over HTTP)", async () => {
    const { status, body } = await post("workspace:choose");
    expect(status).toBe(501);
    expect(body.error).toMatch(/no browser-tab equivalent/i);
  });

  it("pushes a chat:event over the shared WebSocket to a connected client (push/streaming side, issue #228)", async () => {
    const registry = createIpcHandlerRegistry(() => null, {
      agentCoreLoaders: realAgentCoreLoaders,
      codingAgentLoaders: realCodingAgentLoaders,
    });
    const wsServer = await startWebBridgeServer(registry, 0);
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${wsServer.port}/ws`);
      const received = new Promise<{ channel: string; payload: unknown }>((resolve, reject) => {
        socket.once("message", (data) => resolve(JSON.parse(data.toString())));
        socket.once("error", reject);
      });
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("error", reject);
      });

      registry.bridgeEvents.emitBridge("chat:event", { requestId: "req-1", type: "completed" });

      const message = await received;
      expect(message.channel).toBe("chat:event");
      expect(message.payload).toEqual({ requestId: "req-1", type: "completed" });
      socket.close();
    } finally {
      await wsServer.close();
    }
  });

  it("falls back to an OS-assigned port when the requested port is already taken, instead of crashing startup", async () => {
    const occupied = net.createServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1", () => resolve());
    });
    const occupiedPort = (occupied.address() as net.AddressInfo).port;

    const registry = createIpcHandlerRegistry(() => null, {
      agentCoreLoaders: realAgentCoreLoaders,
      codingAgentLoaders: realCodingAgentLoaders,
    });
    const fallbackServer = await startWebBridgeServer(registry, occupiedPort);
    try {
      expect(fallbackServer.port).not.toBe(occupiedPort);
      const response = await fetch(`http://127.0.0.1:${fallbackServer.port}/api/app:get-version`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ args: [] }),
      });
      expect(response.status).toBe(200);
    } finally {
      await fallbackServer.close();
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });
});
