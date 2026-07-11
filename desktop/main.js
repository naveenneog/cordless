// cordless Desktop — a hardened Electron shell for the LOCAL cordless daemon.
//
// Design (approved with Sol): the window loads the daemon's own served client at
// http://127.0.0.1:<port> (same-origin — zero CORS/CSP changes, exact same UI the
// daemon serves). QR/pairing-code stays the default auth; the desktop only adds an
// explicit, opt-in "Connect to this computer" button, backed by the loopback-scoped
// credential exposed through a narrow preload bridge.
//
// Security posture:
//  - contextIsolation on, nodeIntegration off, sandbox on, webSecurity on.
//  - Renderer gets ONLY { platform, getLocalCredential, startDaemon, retry } via preload.
//  - No fs/shell/openExternal/process exposed. startDaemon takes NOTHING from the renderer.
//  - Navigation is pinned to the trusted loopback origin (or the packaged fallback page).
//  - All new windows, webviews and permission requests are denied.
const { app, BrowserWindow, ipcMain, session } = require("electron");
const path = require("node:path");
const http = require("node:http");
const { execFile } = require("node:child_process");
const { DEFAULT_PORT, readJSON, validateLocalServer, cordlessHome, resolveOrigin, sanitizeCredential } = require("./lib/resolve");

const HOME = cordlessHome();
const CRED_FILE = path.join(HOME, "desktop-credential.json");
const FALLBACK_FILE = path.join(__dirname, "fallback.html");

let win = null;
let currentOrigin = null; // the trusted loopback origin once resolved
function daemonHealthy(origin) {
  return new Promise((resolve) => {
    const req = http.get(origin + "/v1/health", (res) => {
      let body = "";
      res.on("data", (d) => {
        body += d;
        if (body.length > 4096) req.destroy();
      });
      res.on("end", () => {
        try {
          const j = JSON.parse(body);
          resolve(res.statusCode === 200 && j && j.ok === true && typeof j.daemonId === "string");
        } catch {
          resolve(false);
        }
      });
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

// Only the credential's own fields, validated, ever reach the renderer.
function loadCredentialForRenderer() {
  return sanitizeCredential(readJSON(CRED_FILE), currentOrigin);
}

// Resolve the installed cordless CLI to an absolute path (never from the renderer).
function resolveCordlessCli() {
  return new Promise((resolve) => {
    const finder = process.platform === "win32" ? "where" : "which";
    execFile(finder, ["cordless"], { timeout: 4000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const first = String(stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      resolve(first || null);
    });
  });
}

async function startDaemon() {
  const cli = await resolveCordlessCli();
  if (!cli) return { ok: false, error: "cordless CLI not found on PATH" };
  return new Promise((resolve) => {
    // No renderer input; fixed argv; no shell.
    const child = execFile(cli, ["start"], { detached: true, stdio: "ignore", windowsHide: true }, () => {});
    child.on("error", (e) => resolve({ ok: false, error: e.message }));
    child.unref();
    // Give it a moment, then report; the renderer/main will re-health-check on retry.
    setTimeout(() => resolve({ ok: true }), 600);
  });
}

// Guard: an IPC call is only honoured from our own trusted pages.
function senderIsTrusted(event) {
  const url = event.senderFrame?.url || "";
  if (url.startsWith("file://") && url.includes("fallback.html")) return true;
  try {
    return currentOrigin && new URL(url).origin === currentOrigin;
  } catch {
    return false;
  }
}

async function decideAndLoad() {
  currentOrigin = resolveOrigin(HOME, DEFAULT_PORT);
  const healthy = await daemonHealthy(currentOrigin);
  if (healthy) {
    await win.loadURL(currentOrigin);
  } else {
    await win.loadFile(FALLBACK_FILE);
  }
}

function hardenWindow(w) {
  w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  w.webContents.on("will-navigate", (event, target) => {
    // Allow only the trusted loopback origin or the packaged fallback file.
    if (target.startsWith("file://") && target.includes("fallback.html")) return;
    try {
      if (new URL(target).origin !== currentOrigin) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
  w.webContents.on("will-attach-webview", (event) => event.preventDefault());
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: "#0b0e14",
    title: "cordless",
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });
  hardenWindow(win);
  win.on("closed", () => {
    win = null;
  });
  return decideAndLoad();
}

app.whenReady().then(() => {
  // Deny every permission request (camera/mic/geolocation/etc.).
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));

  ipcMain.handle("cordless:get-local-credential", (event) => {
    if (!senderIsTrusted(event)) return null;
    return loadCredentialForRenderer();
  });
  ipcMain.handle("cordless:start-daemon", async (event) => {
    if (!senderIsTrusted(event)) return { ok: false, error: "untrusted sender" };
    return startDaemon();
  });
  ipcMain.handle("cordless:retry", async (event) => {
    if (!senderIsTrusted(event)) return { ok: false };
    await decideAndLoad();
    return { ok: true };
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
