import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { fileURLToPath } from "node:url";

const CLIENT_URL = process.env.ASSEMBLE_CLIENT_URL ?? "http://localhost:5273";

function createWindow() {
  // fileURLToPath, not raw `.pathname` — this project's own path
  // ("XBundle Platform") has a space in it, and URL.pathname leaves that
  // percent-encoded ("XBundle%20Platform"), producing a preload path that
  // doesn't exist on disk. fileURLToPath decodes it correctly (and handles
  // the Windows drive-letter prefix too, so the old regex hack is gone).
  const preloadPath = fileURLToPath(new URL("./preload.cjs", import.meta.url));
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL(CLIENT_URL);

  // Opt-in startup self-check (ASSEMBLE_DEBUG=1) — verifies the preload
  // bridge actually attached and the app actually mounted, logged loudly to
  // the terminal instead of silently failing. Ported from Stratum/Create's
  // own main.ts after a real incident here: a preload path bug
  // (URL-encoded space in this project's own folder name) meant
  // window.assemble was silently undefined and every native-picker button
  // just didn't render — nothing crashed, nothing logged, so it went
  // unnoticed until specifically investigated by hand.
  if (process.env.ASSEMBLE_DEBUG) {
    win.webContents.on("console-message", (event) => {
      console.log("[renderer]", event.message);
    });
    win.webContents.once("did-finish-load", async () => {
      const check = await win.webContents.executeJavaScript(
        "({hasAssemble: !!window.assemble, assembleKeys: window.assemble ? Object.keys(window.assemble) : null, hasWorkspace: !!document.querySelector('.assemble-workspace'), title: document.title})"
      );
      console.log("SMOKE-CHECK:", JSON.stringify(check));
    });
  }
}

ipcMain.handle("pick-pdf-files", async () => {
  const result = await dialog.showOpenDialog({
    title: "Select documents to import",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths;
});

ipcMain.handle("pick-bundle-file", async () => {
  const result = await dialog.showOpenDialog({
    title: "Select a built bundle to open",
    properties: ["openFile"],
    filters: [{ name: "PDF bundle", extensions: ["pdf"] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle("pick-folder", async () => {
  const result = await dialog.showOpenDialog({
    title: "Choose a folder to save this bundle's split-out documents",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
