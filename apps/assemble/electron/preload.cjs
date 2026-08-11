const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("assemble", {
  pickFiles: () => ipcRenderer.invoke("pick-pdf-files"),
  pickBundleFile: () => ipcRenderer.invoke("pick-bundle-file"),
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
});
