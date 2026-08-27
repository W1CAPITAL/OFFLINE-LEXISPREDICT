const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("lexisDesktop", {
  isDesktop: true,
  version: () => ipcRenderer.invoke("desktop:version"),
  paths: () => ipcRenderer.invoke("desktop:paths"),
});
