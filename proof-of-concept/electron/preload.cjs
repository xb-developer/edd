const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("edd", {
  pickFiles: () => ipcRenderer.invoke("pick-import-files"),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  openViewer: () => ipcRenderer.invoke("viewer:open"),
  closeViewer: () => ipcRenderer.invoke("viewer:close"),
  isViewerOpen: () => ipcRenderer.invoke("viewer:isOpen"),
  selectInViewer: (guid) => ipcRenderer.send("viewer:select", guid),
  onViewerStateChange: (cb) => {
    const listener = (_event, open) => cb(open);
    ipcRenderer.on("viewer:state", listener);
    return () => ipcRenderer.removeListener("viewer:state", listener);
  },
  onViewerSelection: (cb) => {
    const listener = (_event, guid) => cb(guid);
    ipcRenderer.on("viewer:selected", listener);
    return () => ipcRenderer.removeListener("viewer:selected", listener);
  },
});
