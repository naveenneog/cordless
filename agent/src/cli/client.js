// A loopback WebSocket client of the local cordless daemon, used by the CLI dashboard and commands.
// It authenticates with the daemon's loopback-scoped credential (~/.cordless/desktop-credential.json),
// so the same machine's owner can drive their own daemon without a phone-style pairing step.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { WebSocket } from "ws";
import { HOME, loadConfig } from "../state.js";
import { startDaemonDetached, runningPid } from "../service.js";
import { VERSION } from "../version.js";

const CRED_FILE = path.join(HOME, "desktop-credential.json");

export function loadLocalCredential() {
  try {
    return JSON.parse(fs.readFileSync(CRED_FILE, "utf8"));
  } catch {
    return null;
  }
}

export function daemonBaseUrl() {
  const cred = loadLocalCredential();
  if (cred && typeof cred.server === "string") return cred.server.replace(/\/$/, "");
  return `http://127.0.0.1:${loadConfig().port}`;
}

// GET /v1/health -> daemon info object, or null if unreachable.
export function health(base = daemonBaseUrl(), timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(base + "/v1/health", (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => {
        try {
          const j = JSON.parse(b);
          resolve(res.statusCode === 200 && j && j.ok ? j : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(null);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ensure a daemon of THIS version is reachable; start it if needed. If a stale/older daemon is
// already running on the port (version skew — e.g. an autostart from a previous install), replace it,
// otherwise a newer client would send messages the older daemon rejects ("invalid message").
// Returns { health, started, replaced?, stale? }.
export async function ensureDaemon({ startIfDown = true, waitMs = 10000 } = {}) {
  let h = await health();
  let replaced = false;
  if (h && h.version !== VERSION) {
    const pid = runningPid();
    if (pid) {
      try {
        process.kill(pid);
      } catch {
        /* ignore */
      }
      const until = Date.now() + 5000;
      while (Date.now() < until && (await health())) await sleep(200);
      replaced = true;
    }
    h = await health();
    if (h && h.version !== VERSION) {
      // Could not replace it (not ours / no pid file). Surface it rather than misbehave.
      return { health: h, started: false, stale: true };
    }
    if (!h) h = null; // fall through to (re)start below
  }
  if (h) return { health: h, started: false, replaced };
  if (!startIfDown) return { health: null, started: false, replaced };
  startDaemonDetached();
  const end = Date.now() + waitMs;
  while (Date.now() < end) {
    await sleep(250);
    h = await health();
    if (h) return { health: h, started: true, replaced };
  }
  return { health: null, started: true, replaced };
}

// Thin RPC/stream client. connect() resolves after a successful hello.
export class DaemonClient {
  constructor() {
    this.ws = null;
    this.base = daemonBaseUrl();
    this.reqId = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.onClose = null;
    this._authed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const cred = loadLocalCredential();
      if (!cred || !cred.deviceId || !cred.token) {
        return reject(new Error("no local credential (is the daemon installed/started?)"));
      }
      const ws = new WebSocket(this.base.replace(/^http/, "ws") + "/v1/ws");
      this.ws = ws;
      ws.on("message", (raw) => this._onMessage(raw));
      ws.on("close", () => {
        for (const p of this.pending.values()) p.reject(new Error("disconnected"));
        this.pending.clear();
        if (this.onClose) this.onClose();
      });
      ws.on("error", (e) => {
        if (!this._authed) reject(e);
      });
      ws.on("open", async () => {
        try {
          const r = await this._rpc("hello", { deviceId: cred.deviceId, token: cred.token });
          if (!r.ok) return reject(new Error("authentication failed"));
          this._authed = true;
          resolve(this);
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  _onMessage(raw) {
    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (m.requestId && this.pending.has(m.requestId)) {
      const p = this.pending.get(m.requestId);
      this.pending.delete(m.requestId);
      p.resolve(m);
      return;
    }
    const h = this.handlers.get(m.type);
    if (h) h(m);
  }

  _rpc(type, extra = {}, timeoutMs = 8000) {
    const requestId = "c" + ++this.reqId;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      try {
        this.ws.send(JSON.stringify({ type, requestId, ...extra }));
      } catch (e) {
        this.pending.delete(requestId);
        return reject(e);
      }
      setTimeout(() => {
        if (this.pending.has(requestId)) {
          this.pending.delete(requestId);
          reject(new Error(type + " timed out"));
        }
      }, timeoutMs);
    });
  }

  on(type, fn) {
    this.handlers.set(type, fn);
  }
  off(type) {
    this.handlers.delete(type);
  }
  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  listSessions() {
    return this._rpc("session.list").then((m) => m.sessions || []);
  }
  createSession(profile, opts = {}) {
    return this._rpc("session.create", { profile, ...opts }).then((m) => {
      if (!m.ok) throw new Error(m.error?.message || "create failed");
      return m.sessionId;
    });
  }
  killSession(sessionId, mode = "graceful") {
    return this._rpc("session.kill", { sessionId, mode });
  }
  renameSession(sessionId, title) {
    return this._rpc("session.rename", { sessionId, title }).then((m) => ({ title: m.title, revision: m.revision }));
  }
  pairingCreate(opts = {}) {
    return this._rpc("pairing.create", opts);
  }
  pairingCancel(pairingId) {
    return this._rpc("pairing.cancel", { pairingId });
  }
  tail(sessionId, lines = 50) {
    return this._rpc("session.tail", { sessionId, lines }).then((m) => m.text || "");
  }
  search(sessionId, query, limit = 200) {
    return this._rpc("session.search", { sessionId, query, limit }).then((m) => m.matches || []);
  }
  historyClear(sessionId) {
    return this._rpc("history.clear", sessionId ? { sessionId } : {}).then((m) => m.cleared || 0);
  }
  historyList() {
    return this._rpc("history.list").then((m) => m.items || []);
  }
  profiles() {
    return this._rpc("profiles.list").then((m) => m.profiles || []);
  }
  listGroups() {
    return this._rpc("group.list").then((m) => m.groups || []);
  }
  createGroup(name, color) {
    return this._rpc("group.create", { name, color }).then((m) => {
      if (!m.ok) throw new Error(m.error?.message || "group.create failed");
      return m.group;
    });
  }
  renameGroup(groupId, name) {
    return this._rpc("group.rename", { groupId, name }).then((m) => {
      if (!m.ok) throw new Error(m.error?.message || "group.rename failed");
      return m.group;
    });
  }
  setGroupColor(groupId, color) {
    return this._rpc("group.color", { groupId, color }).then((m) => {
      if (!m.ok) throw new Error(m.error?.message || "group.color failed");
      return m.group;
    });
  }
  reorderGroup(groupId, order) {
    return this._rpc("group.reorder", { groupId, order }).then((m) => {
      if (!m.ok) throw new Error(m.error?.message || "group.reorder failed");
      return m.group;
    });
  }
  deleteGroup(groupId) {
    return this._rpc("group.delete", { groupId }).then((m) => {
      if (!m.ok) throw new Error(m.error?.message || "group.delete failed");
      return m;
    });
  }
  assignSession(sessionId, groupId, groupOrder) {
    return this._rpc("group.assign", { sessionId, groupId: groupId ?? null, groupOrder }).then((m) => {
      if (!m.ok) throw new Error(m.error?.message || "group.assign failed");
      return m;
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}
