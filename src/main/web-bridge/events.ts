import { EventEmitter } from "node:events";

/**
 * Channel names pushed from main -> renderer today via
 * `win.webContents.send(channel, payload)` (see `ipc.ts`, `chat/service.ts`).
 * Kept in sync with `DesktopAgentApi`'s three `on*` subscriptions
 * (`src/shared/events.ts`).
 */
export type BridgeEventChannel = "model:list-updated" | "chat:event" | "extension-ui:request";

/**
 * A tiny main-process-only pub/sub bus (issue #228) that both the real
 * `BrowserWindow` path (via `createBridgeWindow` below) and any connected
 * web-bridge WebSocket client subscribe to for the app's 3 push/streaming
 * events. Decouples "something happened" from "how it reaches a renderer".
 */
export class BridgeEvents extends EventEmitter {
  emitBridge(channel: BridgeEventChannel, payload: unknown): void {
    this.emit(channel, payload);
  }

  onBridge(channel: BridgeEventChannel, listener: (payload: unknown) => void): () => void {
    this.on(channel, listener);
    return () => this.off(channel, listener);
  }
}

/**
 * Minimal structural shape `ipc.ts`/`ChatService` actually call on a window
 * (verified by grep: `isDestroyed()`, `setTitle()`, `webContents.send()`
 * only) -- a real Electron `BrowserWindow` satisfies this structurally, so
 * no call site needs its own type change.
 */
export interface BridgeWindowLike {
  isDestroyed(): boolean;
  setTitle(title: string): void;
  webContents: { send(channel: string, payload: unknown): void };
}

/**
 * Wraps a real `getWindow()` so every `webContents.send(...)` also reaches
 * `bridgeEvents` -- the real `BrowserWindow` path is completely unchanged
 * (issue #228 acceptance criterion: "Electron's own window continues to
 * work identically"). When no real window exists (dev:web-bridge mode,
 * no `BrowserWindow` ever created), the facade reports "not destroyed" so
 * handlers still emit to the bridge instead of silently no-op'ing.
 */
export function createBridgeWindow(
  getRealWindow: () => BridgeWindowLike | null,
  bridgeEvents: BridgeEvents,
): () => BridgeWindowLike | null {
  return () => ({
    isDestroyed: () => getRealWindow()?.isDestroyed() ?? false,
    setTitle: (title: string) => getRealWindow()?.setTitle(title),
    webContents: {
      send: (channel: string, payload: unknown) => {
        const win = getRealWindow();
        if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
        if (channel === "model:list-updated" || channel === "chat:event" || channel === "extension-ui:request") {
          bridgeEvents.emitBridge(channel, payload);
        }
      },
    },
  });
}
