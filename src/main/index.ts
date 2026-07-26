// Electron app-bootstrap glue (low logic density). Intentionally excluded
// from unit-test coverage/mutation targets - verified via real packaged-app
// CDP checks (scripts/cdp-drive.ts) instead. See AGENTS.md lessons #16/#17
// and issue #70.
import { BrowserWindow, app } from "electron";
import { registerIpcHandlers } from "./ipc";
import { createMainWindow } from "./windows";

let mainWindow: BrowserWindow | null = null;

function getWindow(): BrowserWindow | null {
  return mainWindow;
}

app.whenReady().then(() => {
  registerIpcHandlers(getWindow);
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
