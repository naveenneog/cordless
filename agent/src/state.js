// Persistent state for cordlessd: paths, daemon identity, config, devices, pending pairings.
// All state lives under ~/.cordless (override with CORDLESS_HOME). Writes are atomic.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

export const HOME = process.env.CORDLESS_HOME || path.join(os.homedir(), ".cordless");
const P = {
  daemon: path.join(HOME, "daemon.json"),
  config: path.join(HOME, "config.json"),
  devices: path.join(HOME, "devices.json"),
  pending: path.join(HOME, "pending-pairs.json"),
  sessions: path.join(HOME, "sessions.json"),
};

export function ensureHome() {
  fs.mkdirSync(HOME, { recursive: true });
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJSON(file, value) {
  ensureHome();
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ---- Daemon identity ----
export function loadDaemon() {
  let d = readJSON(P.daemon, null);
  if (!d || !d.daemonId) {
    d = { daemonId: crypto.randomUUID(), createdAt: new Date().toISOString() };
    writeJSON(P.daemon, d);
  }
  return d;
}

// ---- Config ----
const DEFAULT_CONFIG = {
  port: 7443,
  bindHost: "0.0.0.0",
  maxSessions: 20,
  ringBytesPerSession: 8 * 1024 * 1024,
  scrollback: 10000,
  // Reopen the sessions that were running when the daemon last stopped (fresh shells, same dirs).
  restoreSessions: true,
  // WebSocket/pairing Origin allowlist (same-origin + localhost are always allowed).
  // Add your Capacitor app origin here if you package the APK, e.g. "http://localhost".
  allowedOrigins: ["capacitor://localhost", "http://localhost", "https://localhost", "ionic://localhost"],
  profiles: {
    shell: { label: "Shell" },
    claude: { label: "Claude Code", initCommand: "claude" },
    codex: { label: "Codex", initCommand: "codex" },
  },
};

export function loadConfig() {
  const c = readJSON(P.config, null);
  if (!c) {
    writeJSON(P.config, DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG };
  }
  return { ...DEFAULT_CONFIG, ...c, profiles: { ...DEFAULT_CONFIG.profiles, ...(c.profiles || {}) } };
}

// ---- Hash helpers ----
export function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}
export function randomToken() {
  return crypto.randomBytes(32).toString("base64url");
}
export function safeEqualHex(a, b) {
  const ba = Buffer.from(String(a), "hex");
  const bb = Buffer.from(String(b), "hex");
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ---- Devices ----
export function loadDevices() {
  return readJSON(P.devices, []);
}
export function saveDevices(list) {
  writeJSON(P.devices, list);
}
export function addDevice({ deviceName, token }) {
  const list = loadDevices();
  const device = {
    deviceId: crypto.randomUUID(),
    deviceName: deviceName || "unnamed device",
    tokenHash: sha256(token),
    createdAt: new Date().toISOString(),
    lastSeenAt: null,
    revokedAt: null,
  };
  list.push(device);
  saveDevices(list);
  return device;
}
export function findActiveDevice(deviceId, token) {
  const list = loadDevices();
  const d = list.find((x) => x.deviceId === deviceId && !x.revokedAt);
  if (!d) return null;
  if (!safeEqualHex(d.tokenHash, sha256(token))) return null;
  return d;
}
export function touchDevice(deviceId) {
  const list = loadDevices();
  const d = list.find((x) => x.deviceId === deviceId);
  if (d) {
    d.lastSeenAt = new Date().toISOString();
    saveDevices(list);
  }
}
export function revokeDevice(deviceId) {
  const list = loadDevices();
  const d = list.find((x) => x.deviceId === deviceId);
  if (d && !d.revokedAt) {
    d.revokedAt = new Date().toISOString();
    saveDevices(list);
    return true;
  }
  return false;
}

// ---- Session manifest (reopen running sessions on daemon start) ----
export function loadSessionManifest() {
  return readJSON(P.sessions, []);
}
export function saveSessionManifest(list) {
  writeJSON(P.sessions, list);
}

// ---- Pending pairings (single-use, short-lived) ----
export function addPendingPair(secret, ttlMinutes = 15) {
  const list = readJSON(P.pending, []).filter((p) => new Date(p.expiresAt).getTime() > Date.now());
  list.push({
    secretHash: sha256(secret),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttlMinutes * 60_000).toISOString(),
  });
  writeJSON(P.pending, list);
}
// Consume a pending pairing if the secret matches and is unexpired. Returns true on success.
export function consumePendingPair(secret) {
  const hash = sha256(secret);
  const now = Date.now();
  const list = readJSON(P.pending, []);
  const idx = list.findIndex(
    (p) => new Date(p.expiresAt).getTime() > now && safeEqualHex(p.secretHash, hash)
  );
  if (idx === -1) return false;
  list.splice(idx, 1);
  writeJSON(P.pending, list.filter((p) => new Date(p.expiresAt).getTime() > now));
  return true;
}
