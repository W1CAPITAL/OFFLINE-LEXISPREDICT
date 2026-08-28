const { contextBridge, ipcRenderer } = require("electron");

const APP_VERSION = "5.1.9";

contextBridge.exposeInMainWorld("lexisOffline", {
  isElectron: true,
  version: APP_VERSION,
  fetchText: (url) => ipcRenderer.invoke("lexis-fetch-text", url),
  fetchJson: (url, opts) => ipcRenderer.invoke("lexis-fetch-json", url, opts || {}),
  datajud: (cnj) => ipcRenderer.invoke("lexis-datajud", cnj),
  djen: (cnj, opts) => ipcRenderer.invoke("lexis-djen", cnj, opts || {}),
  loadDb: () => ipcRenderer.invoke("lexis-db-load"),
  saveDb: (data) => ipcRenderer.invoke("lexis-db-save", data),
  exportCsvFile: (csv, name) => ipcRenderer.invoke("lexis-export-csv", csv, name || "lexis-carteira.csv"),
  aiChat: (payload) => ipcRenderer.invoke("lexis-ai-chat", payload || {}),
  secretsStatus: () => ipcRenderer.invoke("lexis-secrets-status"),
  sheetsPush: (payload) => ipcRenderer.invoke("lexis-sheets-push", payload || {}),
  openExternal: (url) => ipcRenderer.invoke("lexis-open-external", url),
  getPaths: () => ipcRenderer.invoke("lexis-paths"),
  authLogin: (payload) => ipcRenderer.invoke("lexis-auth-login", payload || {}),
  authSession: () => ipcRenderer.invoke("lexis-auth-session"),
  authLogout: () => ipcRenderer.invoke("lexis-auth-logout"),
  usersList: (payload) => ipcRenderer.invoke("lexis-users-list", payload || {}),
  usersCreate: (payload) => ipcRenderer.invoke("lexis-users-create", payload || {}),
  authBootstrapSuperadmin: (payload) => ipcRenderer.invoke("lexis-auth-bootstrap-superadmin", payload || {}),
});

contextBridge.exposeInMainWorld("lexisDesktop", {
  isDesktop: true,
  version: APP_VERSION,
  platform: process.platform,
  mode: "offline",
});
