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
