import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createWebBridgeDesktopApi, isWebBridgeReachable } from "./ws-desktop-api";

/**
 * Minimal fake `WebSocket` -- exercises the transport boundary only (no
 * mocking of business logic, matching this repo's testing rules), letting
 * tests trigger a server push by calling `instance.emit(channel, payload)`
 * directly instead of spinning a real server.
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  emit(channel: string, payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ channel, payload }) });
  }

  close(): void {
    this.closed = true;
    this.onclose?.();
  }
}

describe("createWebBridgeDesktopApi (issue #228)", () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  });

  afterEach(() => {
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = originalWebSocket;
    globalThis.fetch = originalFetch;
  });

  it("POSTs request/response channels to /api/<channel> with a JSON args array and returns the parsed result", async () => {
    const calls: { url: string; body: unknown }[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: url.toString(), body: JSON.parse(init?.body as string) });
      return new Response(JSON.stringify({ result: { requestId: "req-123" } }), { status: 200 });
    }) as unknown as typeof fetch;

    const api = createWebBridgeDesktopApi("http://localhost:4756");
    const result = await api.startChat({ model: "fake/model", messages: [] } as never);

    expect(result).toEqual({ requestId: "req-123" });
    expect(calls[0].url).toBe("http://localhost:4756/api/chat%3Astart");
    expect(calls[0].body).toEqual({ args: [{ model: "fake/model", messages: [] }] });
  });

  it("throws the server's own error message instead of a generic HTTP failure", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 })) as unknown as typeof fetch;

    const api = createWebBridgeDesktopApi("http://localhost:4756");
    await expect(api.getVersion()).rejects.toThrow("boom");
  });

  it("delivers a pushed chat:event to the onChatEvent listener over the shared WebSocket, and unsubscribes cleanly", async () => {
    const api = createWebBridgeDesktopApi("http://localhost:4756");
    const received: unknown[] = [];
    const unsubscribe = api.onChatEvent((event) => received.push(event));

    const socket = FakeWebSocket.instances[0];
    socket.emit("chat:event", { requestId: "req-1", type: "completed" });
    socket.emit("model:list-updated", [{ id: "should-not-be-received" }]);

    expect(received).toEqual([{ requestId: "req-1", type: "completed" }]);

    unsubscribe();
    socket.emit("chat:event", { requestId: "req-2", type: "completed" });
    expect(received).toHaveLength(1);
  });
});

describe("isWebBridgeReachable", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns true when the bridge responds ok, false on a network error", async () => {
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    await expect(isWebBridgeReachable("http://localhost:4756")).resolves.toBe(true);

    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(isWebBridgeReachable("http://localhost:4756")).resolves.toBe(false);
  });
});
