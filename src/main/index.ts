// Electron app-bootstrap glue (low logic density). Intentionally excluded
// from unit-test coverage/mutation targets - verified via real packaged-app
// CDP checks (scripts/cdp-drive.ts) instead. See AGENTS.md lessons #16/#17
// and issue #70.
import { BrowserWindow, app } from "electron";
import { registerIpcHandlers } from "./ipc";
import { createMainWindow } from "./windows";
import { resolveLaunchDirectoryArg } from "./cli-args";
import { SettingsStore } from "./settings/store";
import { startWebBridgeServer } from "./web-bridge/server";

let mainWindow: BrowserWindow | null = null;

function getWindow(): BrowserWindow | null {
  return mainWindow;
}

app.whenReady().then(async () => {
  // Issue #164: `pi-desktop <dir>` (e.g. `pi-desktop .`) seeds the workspace
  // dir from the launch cwd -- unlike the persisted-settings default, the
  // launch cwd of an explicit CLI invocation IS meaningful (see cli-args.ts).
  const launchDir = resolveLaunchDirectoryArg(process.argv, app.isPackaged, process.cwd());
  let initialWorkspaceDir: string | undefined;
  if (launchDir) {
    const settingsStore = new SettingsStore();
    await settingsStore.setWorkspaceDir(launchDir);
    initialWorkspaceDir = launchDir;
  }

  const registry = registerIpcHandlers(getWindow, { initialWorkspaceDir });

  // Issue #228: opt-in, dev/PoC-grade local web bridge so a plain browser
  // tab (no `ipcRenderer`) can reach the same real backend a `BrowserWindow`
  // does. Never starts unless explicitly enabled -- and never in a packaged
  // build, matching the issue's "no change to production" acceptance
  // criterion, even if the env var were somehow set there.
  if (!app.isPackaged && process.env.PI_DESKTOP_WEB_BRIDGE === "1") {
    const port = Number(process.env.PI_DESKTOP_WEB_BRIDGE_PORT) || 4756;
    const bridge = await startWebBridgeServer(registry, port);
    console.log(`[web-bridge] listening on http://127.0.0.1:${bridge.port}`);
  }

  if (process.env.PI_DESKTOP_WEB_BRIDGE_HEADLESS !== "1") {
    mainWindow = createMainWindow();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
