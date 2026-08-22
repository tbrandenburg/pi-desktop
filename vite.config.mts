import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * Issue #228: `index.html`'s CSP (`default-src 'self'`) has no `connect-src`
 * for the opt-in local web-bridge origin, so a plain browser tab's
 * `fetch`/`WebSocket` calls to it are silently blocked -- this widens the
 * CSP by exactly the one bridge origin, and only for the dev server
 * (`apply: "serve"`), never `vite build`/the packaged production app, and
 * only when `VITE_WEB_BRIDGE_URL` is actually set (`npm run dev:web-bridge`).
 */
function webBridgeCspPlugin(): Plugin {
  return {
    name: "pi-desktop-web-bridge-csp",
    apply: "serve",
    transformIndexHtml(html) {
      const bridgeUrl = process.env.VITE_WEB_BRIDGE_URL;
      if (!bridgeUrl) return html;
      const wsUrl = bridgeUrl.replace(/^http/, "ws");
      return html.replace(
        /(content="default-src 'self';)/,
        `$1 connect-src 'self' ${bridgeUrl} ${wsUrl};`,
      );
    },
  };
}

export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [tailwindcss(), react(), webBridgeCspPlugin()],
  build: {
    outDir: "../../dist-renderer",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
});
