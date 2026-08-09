// Electron app-bootstrap glue (low logic density). Intentionally excluded
// from unit-test coverage/mutation targets - verified via real packaged-app
// CDP checks (scripts/cdp-drive.ts) instead. See AGENTS.md lessons #16/#17
// and issue #70.
import { BrowserWindow, app } from "electron";
import { registerIpcHandlers } from "./ipc";
import { createMainWindow } from "./windows";
import { resolveLaunchDirectoryArg } from "./cli-args";
import { SettingsStore } from "./settings/store";

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

  registerIpcHandlers(getWindow, { initialWorkspaceDir });
  mainWindow = createMainWindow();

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
