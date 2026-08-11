import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";

const CLIENT_URL = process.env.EDD_CLIENT_URL ?? "http://localhost:5183";
// fileURLToPath (not URL#pathname) is required here: pathname stays
// percent-encoded, so a space in the project path ("EDD Platform") would
// otherwise turn into a literal "%20" in the preload path and Electron
// would silently fail to load it — the window still opens, it just never
// gets window.edd.
const PRELOAD_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "preload.cjs");

let mainWindow: BrowserWindow | null = null;
let viewerWindow: BrowserWindow | null = null;
// Held here (not just relayed) so a viewer window opened after the user has
// already selected something syncs to the right document immediately,
// instead of starting blank until the next selection change.
let lastSelectedGuid: string | null = null;

// A second launch would start its own in-process server (see server.ts,
// once packaged) or, in dev, a second tsx-watch server racing the first —
// both reading and writing matters.json independently with no coordination
// between them. Whichever one writes last silently drops any matter the
// other one created or deleted in between. Refusing the second launch
// outright (rather than just deduplicating windows) is what actually
// prevents that class of bug, not just its visible symptom.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL(CLIENT_URL);
  mainWindow = win;
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
    // An orphaned viewer window with no main window to dock back into isn't
    // useful — close it too rather than leave it stranded.
    viewerWindow?.close();
  });
}

function openViewerWindow() {
  if (viewerWindow) {
    viewerWindow.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 760,
    height: 900,
    title: "EDD Workbench — Viewer",
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL(`${CLIENT_URL}?viewer=1`);
  // The viewer is a companion window, not an independent one — on a single
  // screen it's meant to float above the main window at all times, not
  // just whenever it happens to have focus. Without this, clicking "Next"
  // in the main window (which keeps the main window focused, by design —
  // see the moveTop() call below) let ordinary z-order rules put the main
  // window back in front, hiding the viewer right when its content changes.
  win.setAlwaysOnTop(true);
  viewerWindow = win;
  win.webContents.once("did-finish-load", () => {
    win.webContents.send("viewer:selected", lastSelectedGuid);
  });
  win.on("closed", () => {
    if (viewerWindow === win) viewerWindow = null;
    mainWindow?.webContents.send("viewer:state", false);
  });
  mainWindow?.webContents.send("viewer:state", true);
}

ipcMain.handle("pick-import-files", async () => {
  const result = await dialog.showOpenDialog({
    title: "Import documents",
    properties: ["openFile", "multiSelections"],
  });
  if (result.canceled) return [];
  return result.filePaths;
});

ipcMain.handle("viewer:open", () => {
  openViewerWindow();
});

ipcMain.handle("viewer:close", () => {
  viewerWindow?.close();
});

ipcMain.handle("viewer:isOpen", () => !!viewerWindow);

// Sender is the main window telling us what's selected; recipient is the
// viewer window (if one is open). Always record it, even with no viewer
// open yet, so a later "open viewer" starts in sync rather than blank.
ipcMain.on("viewer:select", (_event, guid: string | null) => {
  lastSelectedGuid = guid;
  viewerWindow?.webContents.send("viewer:selected", guid);
  // moveTop() (not focus()) — brings it back to the front of the z-order
  // without stealing keyboard focus from the main window, so Prev/Next or
  // arrow-key navigation there keeps working without the user needing to
  // click back into the main window after every document change.
  viewerWindow?.moveTop();
});

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
