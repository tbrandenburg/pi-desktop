/**
 * Waits for the Vite dev server to become reachable, then launches Electron
 * pointed at the built main process output. Used only by `npm run dev`.
 */
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const DEV_SERVER_URL = "http://localhost:5173";
const MAIN_ENTRY = "dist-main/main/index.js";

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status < 500) return;
    } catch {
      // Server not up yet; retry.
    }
    await delay(300);
  }
  throw new Error(`Timed out waiting for dev server at ${url}`);
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
  await Promise.all([
    waitForServer(DEV_SERVER_URL, 30_000),
    waitForMainBuild(30_000),
  ]);

  const electronPath = (await import("electron")).default as unknown as string;
  const child = spawn(electronPath, ["."], {
    stdio: "inherit",
    env: { ...process.env, VITE_DEV_SERVER_URL: DEV_SERVER_URL },
  });

  child.on("exit", (code) => process.exit(code ?? 0));
}

void main();
