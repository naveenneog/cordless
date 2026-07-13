// Narrow, audited bridge. The renderer gets nothing else from Node/Electron.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cordless", {
  platform: "desktop",
  // Returns { deviceId, token, server } for the loopback daemon, or null.
  getLocalCredential: () => ipcRenderer.invoke("cordless:get-local-credential"),
  // Starts the installed daemon (no arguments accepted from the page).
  startDaemon: () => ipcRenderer.invoke("cordless:start-daemon"),
  // Opens the CLI Releases page in the user's browser (fixed URL, no page input).
  openReleases: () => ipcRenderer.invoke("cordless:open-releases"),
  // Re-checks daemon health and (re)loads the UI or fallback.
  retry: () => ipcRenderer.invoke("cordless:retry"),
});
