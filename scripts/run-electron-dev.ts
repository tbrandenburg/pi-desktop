/**
 * Starts the Vite dev server in-process (via Vite's Node API), waits for the
 * main process build to be ready, then launches Electron pointed at the real
 * bound dev server URL. Used only by `npm run dev`.
 *
 * No port is hardcoded: Vite picks its own starting port (see
 * vite.config.mts) and auto-increments to the next free one if taken, since
 * `strictPort` is not set. The actual bound URL is read back from
 * `server.resolvedUrls` after `listen()` resolves.
 */
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "vite";

const MAIN_ENTRY = "dist-main/main/index.js";

async function startViteDevServer(): Promise<string> {
  const server = await createServer({
    configFile: "vite.config.mts",
  });
  await server.listen();

  const url = server.resolvedUrls?.local[0];
  if (!url) {
    throw new Error("Vite dev server started but no local URL was resolved");
  }

  console.log(`[run-electron-dev] Vite dev server listening at ${url}`);
  return url;
}

async function waitForMainBuild(timeoutMs: number): Promise<void> {
  const fs = await import("node:fs");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(MAIN_ENTRY)) return;
    await delay(300);
  }
  throw new Error(`Timed out waiting for ${MAIN_ENTRY} to be built`);
}

async function main(): Promise<void> {
  const [devServerUrl] = await Promise.all([
    startViteDevServer(),
    waitForMainBuild(30_000),
  ]);

  const electronPath = (await import("electron")).default as unknown as string;
  const child = spawn(electronPath, ["."], {
    stdio: "inherit",
    env: { ...process.env, VITE_DEV_SERVER_URL: devServerUrl },
  });

  child.on("exit", (code) => process.exit(code ?? 0));
}

void main();
