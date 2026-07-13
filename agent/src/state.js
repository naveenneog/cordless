// Persistent state for cordlessd: paths, daemon identity, config, devices, pending pairings.
// All state lives under ~/.cordless (override with CORDLESS_HOME). Writes are atomic.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import zlib from "node:zlib";
import crypto from "node:crypto";

export const HOME = process.env.CORDLESS_HOME || path.join(os.homedir(), ".cordless");
const P = {
  daemon: path.join(HOME, "daemon.json"),
  config: path.join(HOME, "config.json"),
  devices: path.join(HOME, "devices.json"),
  pending: path.join(HOME, "pending-pairs.json"),
  sessions: path.join(HOME, "sessions.json"),
  workspaces: path.join(HOME, "workspaces.json"),
  history: path.join(HOME, "history"),
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
  // Persist a capped, normalized (plain-text, no escapes) scrollback per session so that after a
  // daemon restart / reboot a reopened session shows its previous output. See agent/src/sessions.js.
  history: {
    persist: true,
    maxLines: 2000,
    maxBytes: 512 * 1024, // whichever limit is hit first
  },
  // WebSocket/pairing Origin allowlist (same-origin + localhost are always allowed).
  // Add your Capacitor app origin here if you package the APK, e.g. "http://localhost".
  allowedOrigins: ["capacitor://localhost", "http://localhost", "https://localhost", "ionic://localhost"],
  profiles: {
    shell: { label: "Shell" },
    claude: { label: "Claude Code", initCommand: "claude" },
    codex: { label: "Codex", initCommand: "codex" },
  },
  // Optional outbound notifications when a session needs attention. Disabled by default; no cloud
  // owned by cordless. See agent/src/notifier.js. Topic/webhookUrl/token are secrets.
  notifications: {
    enabled: false,
    provider: "ntfy", // "ntfy" | "webhook"
    url: "https://ntfy.sh", // ntfy server base (ntfy.sh or self-hosted)
    topic: "", // ntfy topic (required for ntfy)
    webhookUrl: "", // required when provider is "webhook"
    token: null, // optional bearer token
    events: ["prompt", "bell", "finished"], // which attention transitions notify
    quietHours: null, // e.g. { start: "22:00", end: "07:00" } (local time)
    includePreview: false, // include the last terminal line (may leak code/secrets)
  },
};

export function loadConfig() {
  const c = readJSON(P.config, null);
  if (!c) {
    writeJSON(P.config, DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG };
  }
  return {
    ...DEFAULT_CONFIG,
    ...c,
    profiles: { ...DEFAULT_CONFIG.profiles, ...(c.profiles || {}) },
    notifications: { ...DEFAULT_CONFIG.notifications, ...(c.notifications || {}) },
    history: { ...DEFAULT_CONFIG.history, ...(c.history || {}) },
  };
}

// Names of the profiles that ship with cordless (to distinguish user/override profiles for display).
export const BUILTIN_PROFILE_NAMES = Object.keys(DEFAULT_CONFIG.profiles);

// The raw `profiles` map exactly as the user wrote it in config.json (before the built-in merge).
export function loadRawUserProfiles() {
  const c = readJSON(P.config, null);
  return (c && c.profiles) || {};
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
export function addDevice({ deviceName, token, scope }) {
  const list = loadDevices();
  const device = {
    deviceId: crypto.randomUUID(),
    deviceName: deviceName || "unnamed device",
    tokenHash: sha256(token),
    scope: scope || "device",
    createdAt: new Date().toISOString(),
    lastSeenAt: null,
    revokedAt: null,
  };
  list.push(device);
  saveDevices(list);
  return device;
}
export function findDeviceById(deviceId) {
  return loadDevices().find((x) => x.deviceId === deviceId && !x.revokedAt) || null;
}

// A loopback-scoped credential the local desktop app auto-connects with (no QR pairing).
// The plaintext token lives only in this 0600 file; the daemon stores just its hash.
export function ensureDesktopCredential(port) {
  const file = path.join(HOME, "desktop-credential.json");
  const existing = readJSON(file, null);
  if (existing && existing.deviceId && existing.token && findDeviceById(existing.deviceId)) {
    if (existing.port !== port) {
      existing.port = port;
      existing.server = `http://127.0.0.1:${port}`;
      writeJSON(file, existing);
    }
    return existing;
  }
  const token = randomToken();
  const device = addDevice({ deviceName: "cordless Desktop (local)", token, scope: "loopback" });
  const cred = { deviceId: device.deviceId, token, port, server: `http://127.0.0.1:${port}` };
  ensureHome();
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(cred, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* windows */
  }
  return cred;
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

// ---- Per-session persisted history (normalized plain-text scrollback, gzipped) ----
// Files live under ~/.cordless/history/<sessionId>.json.gz. They may contain secrets, so they are
// written user-only (0o600) into a 0o700 dir. A record is { version, sessionId, generation,
// capturedAt, lines: string[] }.
function historyFile(sessionId) {
  return path.join(P.history, `${sessionId}.json.gz`);
}
function ensureHistoryDir() {
  fs.mkdirSync(P.history, { recursive: true });
  try {
    fs.chmodSync(P.history, 0o700);
  } catch {
    /* best-effort on Windows */
  }
}
export function saveSessionHistory(sessionId, record) {
  ensureHistoryDir();
  const file = historyFile(sessionId);
  const tmp = `${file}.tmp-${process.pid}`;
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(record), "utf8"));
  fs.writeFileSync(tmp, gz, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
export function loadSessionHistory(sessionId) {
  try {
    const gz = fs.readFileSync(historyFile(sessionId));
    return JSON.parse(zlib.gunzipSync(gz).toString("utf8"));
  } catch {
    return null;
  }
}
export function clearSessionHistory(sessionId) {
  try {
    fs.rmSync(historyFile(sessionId), { force: true });
    return true;
  } catch {
    return false;
  }
}
// All session ids that currently have a persisted history file.
export function listSessionHistoryIds() {
  try {
    return fs
      .readdirSync(P.history)
      .filter((f) => f.endsWith(".json.gz"))
      .map((f) => f.slice(0, -".json.gz".length));
  } catch {
    return [];
  }
}

// ---- Workspaces (named session templates) ----
// A workspace is { name, sessions: [{ profile, cwd, title }], savedAt }. Stored as a name->ws map.
export function loadWorkspaces() {
  return readJSON(P.workspaces, {});
}
export function getWorkspace(name) {
  return loadWorkspaces()[name] || null;
}
export function saveWorkspace(name, ws) {
  const all = loadWorkspaces();
  all[name] = { ...ws, name, savedAt: new Date().toISOString() };
  writeJSON(P.workspaces, all);
  return all[name];
}
export function deleteWorkspace(name) {
  const all = loadWorkspaces();
  if (!(name in all)) return false;
  delete all[name];
  writeJSON(P.workspaces, all);
  return true;
}

// ---- Pending pairings (single-use, short-lived) ----
const MAX_PENDING = 5;

// Mint a pending pairing. `source` is "cli" or "app" (for per-source caps). Returns { id, expiresAt }.
export function addPendingPair(secret, ttlMinutes = 15, source = "cli") {
  const now = Date.now();
  const list = readJSON(P.pending, [])
    .filter((p) => new Date(p.expiresAt).getTime() > now)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  // Bound outstanding secrets; drop the oldest when at capacity.
  while (list.length >= MAX_PENDING) list.shift();
  const rec = {
    id: crypto.randomUUID(),
    secretHash: sha256(secret),
    source,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMinutes * 60_000).toISOString(),
  };
  list.push(rec);
  writeJSON(P.pending, list);
  return { id: rec.id, expiresAt: rec.expiresAt };
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
// Non-secret metadata for active pending pairings (never exposes the hash/secret).
export function listPendingPairs() {
  const now = Date.now();
  return readJSON(P.pending, [])
    .filter((p) => new Date(p.expiresAt).getTime() > now)
    .map((p) => ({ id: p.id, source: p.source || "cli", createdAt: p.createdAt, expiresAt: p.expiresAt }));
}
export function countActivePendingPairs(source) {
  const now = Date.now();
  return readJSON(P.pending, []).filter(
    (p) => new Date(p.expiresAt).getTime() > now && (!source || (p.source || "cli") === source)
  ).length;
}
export function cancelPendingPairById(id) {
  const now = Date.now();
  const list = readJSON(P.pending, []);
  writeJSON(P.pending, list.filter((p) => p.id !== id && new Date(p.expiresAt).getTime() > now));
}
