// Narrow, audited bridge. The renderer gets nothing else from Node/Electron.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cordless", {
  platform: "desktop",
  // Returns { deviceId, token, server } for the loopback daemon, or null.
  getLocalCredential: () => ipcRenderer.invoke("cordless:get-local-credential"),
  // Starts the installed daemon (no arguments accepted from the page).
  startDaemon: () => ipcRenderer.invoke("cordless:start-daemon"),
  // Re-checks daemon health and (re)loads the UI or fallback.
  retry: () => ipcRenderer.invoke("cordless:retry"),
});
