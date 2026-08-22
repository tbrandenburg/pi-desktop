import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { IpcHandlerRegistry } from "../ipc";

/**
 * Issue #228: a small, dev/PoC-grade local bridge exposing the exact same
 * `IpcHandlerRegistry` handlers Electron's own `ipcMain` uses, over plain
 * HTTP (request/response) and one shared WebSocket (push/streaming) --
 * so a plain browser tab pointed at the Vite dev server can talk to the
 * real backend instead of silently falling back to the fake bridge.
 *
 * Localhost-bound only, opt-in via `PI_DESKTOP_WEB_BRIDGE=1`
 * (`main/index.ts`), never started in a packaged/production build. Not a
 * scalable/multi-user/hosted transport -- see the issue's "Non-goals".
 */
export interface WebBridgeServer {
  port: number;
  close(): Promise<void>;
}

/** `dialog.showOpenDialog` has no browser equivalent (issue #228 non-goal) -- fail clearly instead of no-op. */
const UNSUPPORTED_CHANNELS = new Set(["workspace:choose"]);

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(json);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Starts the bridge on `port` (0 = OS-assigned, used by tests). Every
 * `POST /api/<channel>` body is `{ "args": [...] }`; the response is
 * `{ "result": ... }` on success or `{ "error": "..." }` (4xx/5xx) on
 * failure -- callers never see a handler's internal exception shape.
 */
export function startWebBridgeServer(registry: IpcHandlerRegistry, port = 4756): Promise<WebBridgeServer> {
  const server = http.createServer((req, res) => {
    void handleRequest(req, res);
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/api/")) {
      sendJson(res, 404, { error: `Unknown path: ${url.pathname}` });
      return;
    }
    const channel = decodeURIComponent(url.pathname.slice("/api/".length));
    if (UNSUPPORTED_CHANNELS.has(channel)) {
      sendJson(res, 501, { error: `"${channel}" has no browser-tab equivalent over the web bridge (issue #228 non-goal): no native file picker is available.` });
      return;
    }
    const fn = registry.handlers[channel];
    if (!fn) {
      sendJson(res, 404, { error: `No handler registered for channel "${channel}"` });
      return;
    }
    try {
      const body = (await readJsonBody(req)) as { args?: unknown[] };
      const args = Array.isArray(body.args) ? body.args : [];
      const result = await fn(undefined, ...args);
      sendJson(res, 200, { result: result ?? null });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  const wss = new WebSocketServer({ server, path: "/ws" });
  const clients = new Set<WebSocket>();
  wss.on("connection", (socket) => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
  });
  const unsubscribers = (["model:list-updated", "chat:event", "extension-ui:request"] as const).map((channel) =>
    registry.bridgeEvents.onBridge(channel, (payload) => {
      const message = JSON.stringify({ channel, payload });
      for (const client of clients) {
        if (client.readyState === client.OPEN) client.send(message);
      }
    }),
  );

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const boundPort = typeof address === "object" && address ? address.port : port;
      resolve({
        port: boundPort,
        close: () =>
          new Promise((resolveClose) => {
            for (const unsubscribe of unsubscribers) unsubscribe();
            for (const client of clients) client.terminate();
            wss.close(() => server.close(() => resolveClose()));
          }),
      });
    });
  });
}
