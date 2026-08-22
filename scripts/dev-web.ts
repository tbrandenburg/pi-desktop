/**
 * Entry point for `npm run dev:web` (issue #228's opt-in local web bridge).
 *
 * The web-bridge port must be known to *three* independent places before
 * anything starts: the main process (`PI_DESKTOP_WEB_BRIDGE_PORT`), the
 * renderer's CSP `connect-src` (`vite.config.mts`'s `VITE_WEB_BRIDGE_URL`),
 * and the renderer's own bridge client (`VITE_WEB_BRIDGE_URL` baked in by
 * Vite at dev-server start). Hardcoding the same port number independently
 * in each place (as a plain npm script previously did) silently breaks the
 * moment one of them is edited without the others.
 *
 * This script resolves the port *once*, the same way Vite resolves its own
 * dev-server port (try the preferred port, fall back to an OS-assigned free
 * port if it's taken -- see `server.port`/`strictPort` docs), then passes
 * that single resolved value to every consumer via env vars.
 */
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";

const DEFAULT_PORT = 4756;

/** Resolves to `preferredPort` if free, otherwise an OS-assigned free port (mirrors Vite's own `server.port` fallback). */
async function resolveFreePort(preferredPort: number, host = "127.0.0.1"): Promise<number> {
  const tryListen = (port: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once("error", (error: NodeJS.ErrnoException) => {
        probe.close();
        reject(error);
      });
      probe.listen(port, host, () => {
        const address = probe.address();
        const boundPort = typeof address === "object" && address ? address.port : port;
        probe.close(() => resolve(boundPort));
      });
    });

  try {
    return await tryListen(preferredPort);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    console.log(`[dev:web] port ${preferredPort} is in use; picking a free port instead`);
    return tryListen(0);
  }
}

async function main(): Promise<void> {
  const preferredPort = Number(process.env.PI_DESKTOP_WEB_BRIDGE_PORT) || DEFAULT_PORT;
  const port = await resolveFreePort(preferredPort);
  const bridgeUrl = `http://localhost:${port}`;
  console.log(`[dev:web] web bridge will listen at ${bridgeUrl}`);

  // Invokes the local `concurrently` binary directly (no shell): with
  // `shell: true`, Node just space-joins the args array on POSIX instead of
  // preserving each array element as one argv token, which silently splits
  // the single "tsx scripts/run-electron-dev.ts" command string into three
  // separate top-level commands for `concurrently` to (mis)run.
  const concurrentlyBin = path.join(process.cwd(), "node_modules", ".bin", "concurrently");
  const child = spawn(concurrentlyBin, ["-k", "npm:dev:main", "tsx scripts/run-electron-dev.ts"], {
    stdio: "inherit",
    env: {
      ...process.env,
      PI_DESKTOP_WEB_BRIDGE: "1",
      PI_DESKTOP_WEB_BRIDGE_HEADLESS: "1",
      PI_DESKTOP_WEB_BRIDGE_PORT: String(port),
      VITE_WEB_BRIDGE_URL: bridgeUrl,
    },
  });

  child.on("exit", (code) => process.exit(code ?? 0));
}

void main();
