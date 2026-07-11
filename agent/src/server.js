// cordlessd HTTP + WebSocket server.
//  - GET  /                 -> serves the web client (public/)
//  - GET  /v1/health        -> liveness + daemon identity
//  - POST /v1/pair          -> exchange a single-use pairing secret for a per-device token
//  - WS   /v1/ws            -> authenticated session protocol
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import {
  loadConfig,
  loadDaemon,
  ensureHome,
  addDevice,
  consumePendingPair,
  randomToken,
  ensureDesktopCredential,
} from "./state.js";
import { ClientMessage, out } from "./protocol.js";
import { SessionManager } from "./sessions.js";
import { isBlocked, recordFail, recordSuccess, authenticate } from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const MAX_WS_BUFFER = 4 * 1024 * 1024;
const NO_ACK_MS = 30_000;
const HELLO_TIMEOUT_MS = 10_000;

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

// Content-Security-Policy: scripts are same-origin bundles only (no inline script -> strong XSS
// defense); ws:/wss: allowed for the terminal socket; framing denied.
const CSP =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "font-src 'self' data:; " +
  "connect-src 'self' ws: wss:; " +
  "base-uri 'none'; " +
  "form-action 'self'; " +
  "frame-ancestors 'none'";

function secHeaders(extra = {}) {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
    ...extra,
  };
}

// Reject cross-origin browser requests (CSRF / DNS-rebinding). Native apps / CLI omit Origin.
function originAllowed(req, cfg) {
  const origin = req.headers.origin;
  if (!origin) return true; // native app / curl / non-browser
  try {
    const o = new URL(origin);
    if (o.host === (req.headers.host || "")) return true; // same host we served from
    if (o.hostname === "localhost" || o.hostname === "127.0.0.1") return true;
    return (cfg.allowedOrigins || []).includes(origin);
  } catch {
    return false;
  }
}

// CORS for allow-listed cross-origin app clients (e.g. the Capacitor APK at http://localhost, or a
// browser reaching the agent at a different origin). Scoped to the Origin allowlist above.
function corsHeaders(req, cfg) {
  const origin = req.headers.origin;
  if (origin && originAllowed(req, cfg)) {
    const h = {
      "Access-Control-Allow-Origin": origin,
      Vary: "Origin",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "600",
    };
    // Private Network Access: Chromium/WebView preflights reaching a LAN/Tailscale/loopback
    // address require this on the response (allowed origins only).
    if (req.headers["access-control-request-private-network"] === "true") {
      h["Access-Control-Allow-Private-Network"] = "true";
    }
    return h;
  }
  return {};
}

// One subscriber per (connection, session). Owns flow control for that stream.
class Subscriber {
  constructor(ws, sessionId) {
    this.ws = ws;
    this.sessionId = sessionId;
    this.lastSentSeq = -1;
    this.lastAckSeq = -1;
    this.lastAckAt = Date.now();
    this.mode = "fresh";
    this.alive = true;
  }
  deliver(frame, payloadBytes) {
    if (!this.alive || this.ws.readyState !== this.ws.OPEN) return false;
    const text = JSON.stringify(frame);
    if (this.ws.bufferedAmount + text.length > MAX_WS_BUFFER) {
      this._drop(1013, "client too slow");
      return false;
    }
    if (frame.type === "session.output" && typeof frame.seq === "number") {
      this.lastSentSeq = frame.seq;
    }
    this.ws.send(text, (err) => {
      if (err) this._drop();
    });
    return true;
  }
  initAck(latestSeq) {
    this.lastSentSeq = latestSeq;
    this.lastAckSeq = latestSeq;
    this.lastAckAt = Date.now();
  }
  onAck(seq) {
    if (seq > this.lastAckSeq) this.lastAckSeq = seq;
    this.lastAckAt = Date.now();
  }
  isStale(now) {
    return this.lastSentSeq > this.lastAckSeq && now - this.lastAckAt > NO_ACK_MS;
  }
  _drop(code, reason) {
    this.alive = false;
    try {
      if (code) this.ws.close(code, reason);
      else this.ws.terminate();
    } catch {
      /* ignore */
    }
  }
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  let rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  let filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    // SPA fallback
    filePath = path.join(PUBLIC_DIR, "index.html");
    if (!fs.existsSync(filePath)) {
      res.writeHead(404).end("cordless client not built — run `npm run build` in client/");
      return;
    }
  }
  const ext = path.extname(filePath).toLowerCase();
  const headers = secHeaders({
    "content-type": CONTENT_TYPES[ext] || "application/octet-stream",
    "Content-Security-Policy": CSP,
  });
  if (ext === ".html") headers["Cache-Control"] = "no-store";
  else if (rel.startsWith("assets/")) headers["Cache-Control"] = "public, max-age=31536000, immutable";
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > limit) req.destroy();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

export async function runServer() {
  ensureHome();
  const cfg = loadConfig();
  const daemon = loadDaemon();
  const mgr = new SessionManager(cfg);
  mgr.restore();
  ensureDesktopCredential(cfg.port); // local credential for the desktop app (auto-pair on loopback)
  const connections = new Set();

  const server = http.createServer(async (req, res) => {
    const ip = req.socket.remoteAddress || "?";
    const cors = corsHeaders(req, cfg);

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(originAllowed(req, cfg) ? 204 : 403, secHeaders({ ...cors, "Cache-Control": "no-store" }));
      res.end();
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/v1/health")) {
      res.writeHead(200, secHeaders({ ...cors, "content-type": "application/json", "Cache-Control": "no-store" }));
      res.end(JSON.stringify({ ok: true, daemonId: daemon.daemonId, protocol: 1 }));
      return;
    }
    if (req.method === "POST" && req.url?.startsWith("/v1/pair")) {
      if (!originAllowed(req, cfg)) {
        res.writeHead(403, secHeaders({ "content-type": "application/json", "Cache-Control": "no-store" }));
        res.end(JSON.stringify({ ok: false, error: "forbidden origin" }));
        return;
      }
      if (isBlocked(ip)) {
        res.writeHead(429, secHeaders({ ...cors, "content-type": "application/json", "Cache-Control": "no-store" }));
        res.end(JSON.stringify({ ok: false, error: "too many attempts" }));
        return;
      }
      let data;
      try {
        data = JSON.parse((await readBody(req)) || "{}");
      } catch {
        res.writeHead(400, secHeaders({ ...cors, "content-type": "application/json", "Cache-Control": "no-store" }));
        res.end('{"ok":false,"error":"bad json"}');
        return;
      }
      const secret = String(data.pairSecret || "");
      if (secret && consumePendingPair(secret)) {
        const token = randomToken();
        const device = addDevice({ deviceName: data.deviceName, token });
        recordSuccess(ip);
        res.writeHead(200, secHeaders({ ...cors, "content-type": "application/json", "Cache-Control": "no-store" }));
        res.end(
          JSON.stringify({ ok: true, deviceId: device.deviceId, token, daemonId: daemon.daemonId })
        );
      } else {
        recordFail(ip);
        res.writeHead(401, secHeaders({ ...cors, "content-type": "application/json", "Cache-Control": "no-store" }));
        res.end(JSON.stringify({ ok: false, error: "invalid or expired pairing code" }));
      }
      return;
    }
    if (req.method === "GET") return serveStatic(req, res);
    res.writeHead(405).end("method not allowed");
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = (req.url || "").split("?")[0];
    if (url !== "/v1/ws") {
      socket.destroy();
      return;
    }
    if (!originAllowed(req, cfg)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws, req));
  });

  function handleConnection(ws, req) {
    const ip = req.socket.remoteAddress || "?";
    const conn = { ws, ip, authed: false, device: null, subscribers: new Map() };
    connections.add(conn);

    const helloTimer = setTimeout(() => {
      if (!conn.authed) {
        try {
          ws.close(4401, "auth timeout");
        } catch {
          /* ignore */
        }
      }
    }, HELLO_TIMEOUT_MS);

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const parsed = ClientMessage.safeParse(msg);
      if (!parsed.success) {
        safeSend(ws, out.error(msg?.type || "error", msg?.requestId, "bad_request", "invalid message"));
        return;
      }
      const m = parsed.data;

      if (!conn.authed) {
        if (m.type !== "hello") {
          ws.close(4401, "unauthenticated");
          return;
        }
        if (isBlocked(ip)) {
          safeSend(ws, out.error("hello.result", m.requestId, "blocked", "too many attempts"));
          ws.close(4401, "blocked");
          return;
        }
        const device = authenticate(m.deviceId, m.token, ip);
        if (!device) {
          recordFail(ip);
          safeSend(ws, out.error("hello.result", m.requestId, "unauthorized", "invalid device or token"));
          ws.close(4401, "unauthorized");
          return;
        }
        recordSuccess(ip);
        conn.authed = true;
        conn.device = device;
        clearTimeout(helloTimer);
        safeSend(
          ws,
          out.helloResult(m.requestId, { connectionId: `${device.deviceId}:${Date.now()}`, daemonId: daemon.daemonId })
        );
        return;
      }

      handleAuthed(conn, m);
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      for (const [sessionId, sub] of conn.subscribers) {
        const sess = mgr.get(sessionId);
        if (sess) sess.detach(sub);
      }
      conn.subscribers.clear();
      connections.delete(conn);
    });

    ws.on("error", () => {
      /* close handler cleans up */
    });
  }

  async function handleAuthed(conn, m) {
    const ws = conn.ws;
    switch (m.type) {
      case "session.list":
        safeSend(ws, out.sessionList(m.requestId, mgr.list()));
        break;

      case "session.create": {
        try {
          const s = mgr.create({
            profile: m.profile,
            cwd: m.cwd,
            cols: m.cols,
            rows: m.rows,
            title: m.title,
          });
          safeSend(ws, out.result("session.create.result", m.requestId, { sessionId: s.id }));
        } catch (err) {
          safeSend(ws, out.error("session.create.result", m.requestId, "create_failed", String(err.message || err)));
        }
        break;
      }

      case "session.attach": {
        const sess = mgr.get(m.sessionId);
        if (!sess) {
          safeSend(ws, out.error("session.attach.result", m.requestId, "no_session", "unknown session"));
          break;
        }
        const existing = conn.subscribers.get(m.sessionId);
        if (existing) sess.detach(existing);
        const sub = new Subscriber(ws, m.sessionId);
        conn.subscribers.set(m.sessionId, sub);
        const latestSeq = await sess.attach(sub, m.fromSeq ?? null);
        safeSend(
          ws,
          out.result("session.attach.result", m.requestId, {
            sessionId: m.sessionId,
            replayMode: sub.mode,
            latestSeq,
          })
        );
        break;
      }

      case "session.input": {
        const sess = mgr.get(m.sessionId);
        if (sess) sess.input(m.data);
        if (m.requestId) safeSend(ws, out.result("session.input.result", m.requestId, {}));
        break;
      }

      case "session.resize": {
        const sess = mgr.get(m.sessionId);
        if (sess) sess.resize(m.cols, m.rows);
        if (m.requestId) safeSend(ws, out.result("session.resize.result", m.requestId, {}));
        break;
      }

      case "session.detach": {
        const sess = mgr.get(m.sessionId);
        const sub = conn.subscribers.get(m.sessionId);
        if (sess && sub) sess.detach(sub);
        conn.subscribers.delete(m.sessionId);
        if (m.requestId) safeSend(ws, out.result("session.detach.result", m.requestId, {}));
        break;
      }

      case "session.kill": {
        const sess = mgr.get(m.sessionId);
        if (sess) sess.kill(m.mode || "graceful");
        if (m.requestId) safeSend(ws, out.result("session.kill.result", m.requestId, {}));
        break;
      }

      case "session.ack": {
        const sub = conn.subscribers.get(m.sessionId);
        if (sub) sub.onAck(m.seq);
        break;
      }
    }
  }

  // Periodic staleness sweep: drop connections whose phone stopped acking.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const conn of connections) {
      for (const sub of conn.subscribers.values()) {
        if (sub.isStale(now)) {
          try {
            conn.ws.close(1013, "no ack");
          } catch {
            /* ignore */
          }
          break;
        }
      }
    }
  }, 5000);

  function shutdown() {
    clearInterval(sweep);
    mgr.shutdown();
    for (const conn of connections) {
      try {
        conn.ws.close(1001, "server shutdown");
      } catch {
        /* ignore */
      }
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise((resolve) => server.listen(cfg.port, cfg.bindHost, resolve));
  console.log(`cordlessd listening on http://${cfg.bindHost}:${cfg.port}  (daemon ${daemon.daemonId})`);
  console.log(`  client:  ${fs.existsSync(path.join(PUBLIC_DIR, "index.html")) ? "served from public/" : "NOT BUILT — run `npm run build` in client/"}`);
  console.log(`  pair a device:  cordless pair`);
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    console.warn("  ! WARNING: running as root. Run cordlessd as your normal user — a paired device has full shell access.");
  }
  if (cfg.bindHost === "0.0.0.0" || cfg.bindHost === "::") {
    console.warn("  ! NOTE: bound to all interfaces. Access is gated by per-device tokens, but for remote use");
    console.warn("          prefer Tailscale + an ACL limiting :" + cfg.port + " to your own devices, and keep this");
    console.warn("          port off the public internet. Set bindHost in ~/.cordless/config.json to restrict.");
  }
}

function safeSend(ws, frame) {
  if (ws.readyState === ws.OPEN) {
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      /* ignore */
    }
  }
}
