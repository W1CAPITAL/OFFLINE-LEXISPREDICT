// Adicione dentro de contextBridge.exposeInMainWorld("lexisOffline", { ... })
  authLogin: (payload) => ipcRenderer.invoke("lexis-auth-login", payload || {}),
  authSession: () => ipcRenderer.invoke("lexis-auth-session"),
  authLogout: () => ipcRenderer.invoke("lexis-auth-logout"),
  usersList: (payload) => ipcRenderer.invoke("lexis-users-list", payload || {}),
  usersCreate: (payload) => ipcRenderer.invoke("lexis-users-create", payload || {}),
  authBootstrapSuperadmin: (payload) => ipcRenderer.invoke("lexis-auth-bootstrap-superadmin", payload || {}),
