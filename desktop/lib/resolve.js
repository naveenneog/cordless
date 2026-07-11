// Pure, Electron-free helpers so the security-critical parsing is unit-testable.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const DEFAULT_PORT = 7443;

function readJSON(file, maxBytes = 64 * 1024) {
  try {
    const stat = fs.statSync(file);
    if (stat.size > maxBytes) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Only loopback http, no credentials-in-URL, no path. Returns a normalized origin.
function validateLocalServer(raw, defaultPort = DEFAULT_PORT) {
  const url = new URL(raw);
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "127.0.0.1" && url.hostname !== "::1" && url.hostname !== "[::1]") ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("invalid local daemon server");
  }
  return `http://127.0.0.1:${url.port || defaultPort}`;
}

function cordlessHome() {
  return process.env.CORDLESS_HOME || path.join(os.homedir(), ".cordless");
}

// Port precedence: credential.server -> config.port -> default.
function resolveOrigin(home = cordlessHome(), defaultPort = DEFAULT_PORT) {
  const cred = readJSON(path.join(home, "desktop-credential.json"));
  if (cred && typeof cred.server === "string") {
    try {
      return validateLocalServer(cred.server, defaultPort);
    } catch {
      /* fall through */
    }
  }
  const cfg = readJSON(path.join(home, "config.json"));
  const port = cfg && Number.isInteger(cfg.port) ? cfg.port : defaultPort;
  return `http://127.0.0.1:${port}`;
}

// Return only validated credential fields for the renderer, or null.
function sanitizeCredential(cred, fallbackOrigin, defaultPort = DEFAULT_PORT) {
  if (!cred || typeof cred !== "object") return null;
  const { deviceId, token, server } = cred;
  if (typeof deviceId !== "string" || typeof token !== "string") return null;
  if (deviceId.length < 1 || deviceId.length > 200) return null;
  if (token.length < 1 || token.length > 4096) return null;
  let safeServer = fallbackOrigin;
  if (typeof server === "string") {
    try {
      safeServer = validateLocalServer(server, defaultPort);
    } catch {
      /* keep fallback */
    }
  }
  return { deviceId, token, server: safeServer };
}

module.exports = { DEFAULT_PORT, readJSON, validateLocalServer, cordlessHome, resolveOrigin, sanitizeCredential };
