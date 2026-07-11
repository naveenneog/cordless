// A loopback WebSocket client of the local cordless daemon, used by the CLI dashboard and commands.
// It authenticates with the daemon's loopback-scoped credential (~/.cordless/desktop-credential.json),
// so the same machine's owner can drive their own daemon without a phone-style pairing step.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { WebSocket } from "ws";
import { HOME, loadConfig } from "../state.js";
import { startDaemonDetached } from "../service.js";

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

// Ensure a daemon is reachable; start it detached if needed. Returns { health, started }.
export async function ensureDaemon({ startIfDown = true, waitMs = 10000 } = {}) {
  let h = await health();
  if (h) return { health: h, started: false };
  if (!startIfDown) return { health: null, started: false };
  startDaemonDetached();
  const end = Date.now() + waitMs;
  while (Date.now() < end) {
    await sleep(250);
    h = await health();
    if (h) return { health: h, started: true };
  }
  return { health: null, started: true };
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

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}
