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
// A cold `tsc -w` (`dev:main`) start does a full watch-mode compile +
// typecheck of ~1300 files (including `.d.ts` from node_modules),
// reproducibly taking 50-80s -- well past a budget tuned against a one-shot
// `tsc` build (~7s). Windows's slower filesystem/watch overhead and
// antivirus-scanned I/O make this even more likely to fire prematurely.
const DEFAULT_MAIN_BUILD_TIMEOUT_MS = 180_000;

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
  const start = Date.now();
  const deadline = start + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(MAIN_ENTRY)) return;
    await delay(300);
  }
  const elapsedSeconds = Math.round((Date.now() - start) / 1000);
  throw new Error(
    `Timed out after ${elapsedSeconds}s waiting for ${MAIN_ENTRY} to be built. ` +
      "Check the [dev:main] log output above for tsc compile errors. " +
      "If the build is just slow (e.g. a cold tsc -w start), raise the " +
      "timeout via PI_DESKTOP_MAIN_BUILD_TIMEOUT_MS (milliseconds).",
  );
}

async function main(): Promise<void> {
  const mainBuildTimeoutMs =
    Number(process.env.PI_DESKTOP_MAIN_BUILD_TIMEOUT_MS) || DEFAULT_MAIN_BUILD_TIMEOUT_MS;
  const [devServerUrl] = await Promise.all([
    startViteDevServer(),
    waitForMainBuild(mainBuildTimeoutMs),
  ]);

  const electronPath = (await import("electron")).default as unknown as string;
  const child = spawn(electronPath, ["."], {
    stdio: "inherit",
    env: { ...process.env, VITE_DEV_SERVER_URL: devServerUrl },
  });

  child.on("exit", (code) => process.exit(code ?? 0));
}

void main();
