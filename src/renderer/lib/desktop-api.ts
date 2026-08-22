import { createFakeDesktopApi } from "./fake-desktop-api";
import { createWebBridgeDesktopApi } from "./ws-desktop-api";
import type { DesktopAgentApi } from "../../shared/events";

/**
 * Issue #228: opt-in web-bridge URL, injected at Vite build/dev time (e.g.
 * `.env.local`: `VITE_WEB_BRIDGE_URL=http://localhost:4756`). Only takes
 * effect in a plain browser tab that has no `window.desktopApi` (the real
 * preload bridge always wins inside Electron) -- lets `npm run dev:web`
 * point a normal browser tab at the real backend instead of the fake one.
 */
const WEB_BRIDGE_URL = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_WEB_BRIDGE_URL;

let webBridgeApi: DesktopAgentApi | null = null;

export function desktopApi() {
  if (!window.desktopApi) {
    if (WEB_BRIDGE_URL) {
      webBridgeApi ??= createWebBridgeDesktopApi(WEB_BRIDGE_URL);
      window.desktopApi = webBridgeApi;
    } else {
      window.desktopApi = createFakeDesktopApi();
    }
  }
  return window.desktopApi;
}
