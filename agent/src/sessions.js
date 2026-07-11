// PTY session manager for cordlessd.
//
// Design (validated with GPT-5.6 Sol):
//  - @xterm/headless Terminal.write() is async/buffered, so ALL terminal writes and snapshots go
//    through ONE per-session op queue. A batch's sequence number is assigned inside the write
//    callback (after the bytes are parsed), then it is added to the replay ring and broadcast.
//    This guarantees the replay ring, the sequence counter, and serialize() are always consistent.
//  - Reconnect: flush the pending batch, then enqueue the attach op behind all writes; inside it we
//    either replay ring chunks (incremental) or send a serialized snapshot (reset), then subscribe.
//  - PTY output is treated as raw bytes (never utf8-decoded on the server) and shipped base64.
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import pty from "./pty-loader.js";
import xtermHeadless from "@xterm/headless";
import addonSerialize from "@xterm/addon-serialize";
import { out } from "./protocol.js";
import { loadSessionManifest, saveSessionManifest } from "./state.js";
import {
  THRESHOLDS,
  hasBell,
  isMeaningfulOutput,
  altScreenAfter,
  isShellPrompt,
  looksLikePrompt,
} from "./attention.js";

const { Terminal } = xtermHeadless;
const { SerializeAddon } = addonSerialize;

const BATCH_MS = 16;
const BATCH_BYTES = 32 * 1024;

function resolveShell(cfg) {
  if (cfg.shell) return cfg.shell;
  if (process.platform === "win32") {
    for (const c of ["pwsh.exe", "powershell.exe"]) {
      // pwsh may not be present; fall through to powershell.exe which always is on Win10+.
      if (c === "powershell.exe") return c;
      const inPath = (process.env.PATH || "")
        .split(path.delimiter)
        .some((d) => {
          try {
            return fs.existsSync(path.join(d, c));
          } catch {
            return false;
          }
        });
      if (inPath) return c;
    }
    return "powershell.exe";
  }
  // Unix: use $SHELL only if it actually exists, else a known-present shell. Spawning a missing
  // path is what makes node-pty throw "posix_spawnp failed".
  for (const c of [process.env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"]) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return "/bin/sh";
}

function validCwd(cwd) {
  try {
    if (cwd && fs.statSync(cwd).isDirectory()) return cwd;
  } catch {
    /* ignore */
  }
  return os.homedir();
}

class Session {
  constructor(mgr, { id, profile, profileCfg, cwd, cols, rows, title }) {
    this.mgr = mgr;
    this.id = id || crypto.randomUUID();
    this.generation = crypto.randomUUID();
    this.profile = profile;
    this.cwd = validCwd(cwd);
    this.cols = cols;
    this.rows = rows;
    this.title = title || `${profileCfg.label || profile} · ${path.basename(this.cwd) || this.cwd}`;
    this.createdAt = new Date().toISOString();
    this.lastActivityAt = this.createdAt;
    this.state = "running";
    this.exitCode = null;
    this.signal = null;

    this.subscribers = new Set();

    // replay ring
    this._nextSeq = 0;
    this._ring = [];
    this._ringBytes = 0;
    this._maxRingBytes = mgr.cfg.ringBytesPerSession;

    // batching
    this._pending = [];
    this._pendingBytes = 0;
    this._flushTimer = null;

    // terminal op queue (serializes writes + snapshots)
    this._ops = Promise.resolve();

    // ---- attention state (see attention.js) ----
    this.activity = "working"; // working | idle | exited
    this.attention = null; // prompt | bell | finished | null
    this.attentionSince = null; // ISO time the current attention began
    this.attentionConfidence = null; // explicit | high | heuristic | null
    this.attentionRevision = 0; // bumped on every state change; clients ignore stale revisions
    this._lastOutputAt = Date.now();
    this._lastInputAt = 0;
    this._hadMeaningfulActivity = false; // did the session produce real output this cycle?
    this._alternateScreen = false; // suppress prompt heuristics while a full-screen TUI is up
    this._quietChecked = false; // has this quiet cycle already been prompt-evaluated?
    this._bellUntil = 0;
    this._createdAtMs = Date.now(); // startup grace: ignore spawn-time bells

    // headless mirror for snapshots
    this.term = new Terminal({
      cols,
      rows,
      scrollback: mgr.cfg.scrollback,
      allowProposedApi: true,
    });
    this._serialize = new SerializeAddon();
    this.term.loadAddon(this._serialize);

    const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" };
    this.pty = pty.spawn(resolveShell(mgr.cfg), [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: this.cwd,
      env,
    });
    this.pty.onData((d) => this._onData(d));
    this.pty.onExit((e) => this._onExit(e));

    if (profileCfg.initCommand) {
      setTimeout(() => {
        if (this.state === "running") this.pty.write(`${profileCfg.initCommand}\r`);
      }, 500);
    }
  }

  // ---- terminal op queue ----
  _queueOp(op) {
    const result = this._ops.then(op, op);
    this._ops = result.catch((err) => console.error(`[session ${this.id}] op failed`, err));
    return result;
  }

  // ---- output batching ----
  _onData(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    this._pending.push(buf);
    this._pendingBytes += buf.length;
    this.lastActivityAt = new Date().toISOString();
    if (this._pendingBytes >= BATCH_BYTES) this._flush();
    else if (!this._flushTimer) this._flushTimer = setTimeout(() => this._flush(), BATCH_MS);
  }

  _flush() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    if (!this._pending.length) return;
    const batch = Buffer.concat(this._pending, this._pendingBytes);
    this._pending = [];
    this._pendingBytes = 0;
    this._queueOp(
      () =>
        new Promise((resolve) => {
          this.term.write(batch, () => {
            const seq = this._nextSeq++;
            this._pushRing(seq, batch);
            this._broadcast(seq, batch);
            this._noteOutput(batch); // update attention state after the term buffer reflects the batch
            resolve();
          });
        })
    );
  }

  // ---- attention detection (see attention.js) ----

  // Called after each output batch is written to the headless terminal.
  _noteOutput(buf) {
    this._lastOutputAt = Date.now();
    this._quietChecked = false;
    this._alternateScreen = altScreenAfter(buf, this._alternateScreen);
    if (isMeaningfulOutput(buf)) this._hadMeaningfulActivity = true;
    // BEL is an explicit attention signal — but ignore invalid-key beeps right after a keypress and
    // shell/agent startup beeps in the session's first few seconds.
    if (
      hasBell(buf) &&
      Date.now() - this._lastInputAt > THRESHOLDS.BELL_INPUT_GUARD_MS &&
      Date.now() - this._createdAtMs > THRESHOLDS.STARTUP_GRACE_MS
    ) {
      this._bellUntil = Date.now() + THRESHOLDS.BELL_HOLD_MS;
      this._setAttention("bell", "explicit");
    }
    this._setActivity("working");
  }

  // Last `n` logical lines of the live buffer (cursor line last), as trimmed plain text.
  _tailLines(n) {
    const lines = [];
    try {
      const b = this.term.buffer.active;
      const cy = b.baseY + b.cursorY;
      for (let y = Math.max(0, cy - (n - 1)); y <= cy; y++) {
        const line = b.getLine(y);
        if (line) lines.push(line.translateToString(true));
      }
    } catch {
      /* headless buffer not ready */
    }
    return lines;
  }

  // Evaluated once per second by the manager for running sessions.
  evaluateQuiet() {
    if (this.state !== "running") return;
    const quietFor = Date.now() - this._lastOutputAt;
    if (quietFor < THRESHOLDS.PROMPT_QUIET_MS) return; // still actively producing output
    // A quiet session that was working becomes idle (bell/prompt attention is preserved).
    if (quietFor >= THRESHOLDS.IDLE_AFTER_MS && this.activity === "working") this._setActivity("idle");
    if (this._quietChecked) return;
    this._quietChecked = true;
    this._queueOp(() => {
      if (this.state !== "running") return;
      if (Date.now() - this._lastOutputAt < THRESHOLDS.PROMPT_QUIET_MS) return; // new output arrived
      if (Date.now() - this._lastInputAt < THRESHOLDS.INPUT_GRACE_MS) return; // user just typed
      if (this._bellUntil > Date.now()) return; // hold the bell badge
      const tail = this._tailLines(6);
      const res = looksLikePrompt(tail, { alternateScreen: this._alternateScreen });
      if (res.match) {
        this._setAttention("prompt", res.confidence);
        return;
      }
      // Heuristic "finished" for coding agents: back at a shell prompt after real activity.
      const finishedEnabled = this.mgr.cfg.attentionFinished !== false;
      if (
        finishedEnabled &&
        (this.profile === "claude" || this.profile === "codex") &&
        this._hadMeaningfulActivity &&
        !this._alternateScreen &&
        Date.now() - this._lastOutputAt >= THRESHOLDS.FINISHED_QUIET_MS
      ) {
        const last = tail.map((s) => s.replace(/\s+$/, "")).filter(Boolean).pop() || "";
        if (isShellPrompt(last)) {
          this._hadMeaningfulActivity = false; // at most one "finished" per activity cycle
          this._setAttention("finished", "heuristic");
        }
      }
    });
  }

  _setActivity(a) {
    if (this.activity === a) return;
    this.activity = a;
    this._emit(false);
  }

  _setAttention(reason, confidence) {
    if (this.attention === reason) return;
    this.attention = reason;
    this.attentionConfidence = reason ? confidence : null;
    this.attentionSince = reason ? new Date().toISOString() : null;
    // A transition INTO waiting/bell/finished is notification-worthy.
    this._emit(reason === "prompt" || reason === "bell" || reason === "finished");
  }

  _clearAttention() {
    this._setAttention(null, null);
  }

  // "Mark handled" — dismiss the current attention badge from a client.
  markHandled() {
    this._bellUntil = 0;
    this._clearAttention();
  }

  _emit(notify) {
    this.attentionRevision++;
    this.mgr._emitAttention(this, notify);
  }

  _pushRing(seq, buf) {
    this._ring.push({ seq, buf });
    this._ringBytes += buf.length;
    while (this._ringBytes > this._maxRingBytes && this._ring.length > 1) {
      const evicted = this._ring.shift();
      this._ringBytes -= evicted.buf.length;
    }
  }

  _broadcast(seq, buf) {
    const b64 = buf.toString("base64");
    for (const sub of this.subscribers) {
      sub.deliver(out.output(this.id, seq, b64, { replay: false, reset: false }), buf.length);
    }
  }

  // ---- attach / reconnect-with-replay ----
  attach(sub, fromSeq) {
    this._flush(); // ensure any pending batch is queued before we snapshot
    return this._queueOp(() => {
      const latestSeq = this._nextSeq - 1;
      const earliest = this._ring.length ? this._ring[0].seq : latestSeq + 1;
      const canIncremental =
        fromSeq != null && fromSeq <= latestSeq && earliest <= fromSeq + 1;

      if (canIncremental) {
        for (const chunk of this._ring) {
          if (chunk.seq > fromSeq) {
            sub.deliver(
              out.output(this.id, chunk.seq, chunk.buf.toString("base64"), {
                replay: true,
                reset: false,
              }),
              chunk.buf.length
            );
          }
        }
        sub.mode = "incremental";
      } else if (latestSeq >= 0) {
        const snap = Buffer.from(this._serialize.serialize(), "utf8");
        sub.deliver(
          out.output(this.id, latestSeq, snap.toString("base64"), { replay: true, reset: true }),
          snap.length
        );
        sub.mode = "reset";
      } else {
        sub.mode = "fresh";
      }
      sub.initAck(latestSeq);
      this.subscribers.add(sub);
      return latestSeq;
    });
  }

  detach(sub) {
    this.subscribers.delete(sub);
  }

  input(data) {
    if (this.state !== "running") return;
    this._lastInputAt = Date.now();
    // Sending input answers a prompt / dismisses a bell / acknowledges "finished".
    if (this.attention) this.markHandled();
    this._setActivity("working");
    // data is base64 of utf8 keystrokes
    this.pty.write(Buffer.from(data, "base64").toString("utf8"));
  }

  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    try {
      this.term.resize(cols, rows);
    } catch {
      /* ignore */
    }
    if (this.state === "running") {
      try {
        this.pty.resize(cols, rows);
      } catch {
        /* pty may have exited */
      }
    }
  }

  kill(mode = "graceful") {
    if (this.state !== "running") {
      // already exited — drop it entirely
      this.mgr._remove(this.id);
      return;
    }
    try {
      if (process.platform === "win32") {
        this.pty.kill();
      } else {
        this.pty.kill(mode === "force" ? "SIGKILL" : "SIGTERM");
        if (mode === "graceful") {
          setTimeout(() => {
            if (this.state === "running") {
              try {
                this.pty.kill("SIGKILL");
              } catch {
                /* ignore */
              }
            }
          }, 5000);
        }
      }
    } catch {
      /* ignore */
    }
  }

  _onExit({ exitCode, signal }) {
    this._flush();
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    this.state = "exited";
    this.exitCode = exitCode ?? null;
    this.signal = signal ?? null;
    this.activity = "exited";
    // An agent session that did real work and then exited is "finished"; a bare shell exit is not.
    if ((this.profile === "claude" || this.profile === "codex") && this._hadMeaningfulActivity) {
      this.attention = "finished";
      this.attentionConfidence = "high";
      this.attentionSince = new Date().toISOString();
    }
    this.attentionRevision++;
    this.mgr._emitAttention(this, true);
    const frame = out.exit(this.id, this.exitCode, this.signal);
    for (const sub of this.subscribers) sub.deliver(frame, 0);
    this.mgr._persistManifest();
  }

  summary() {
    return {
      sessionId: this.id,
      generation: this.generation,
      title: this.title,
      profile: this.profile,
      cwd: this.cwd,
      state: this.state,
      cols: this.cols,
      rows: this.rows,
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
      latestSeq: this._nextSeq - 1,
      attachedDevices: this.subscribers.size,
      exitCode: this.exitCode,
      activity: this.activity,
      attention: this.attention,
      attentionSince: this.attentionSince,
      attentionConfidence: this.attentionConfidence,
      attentionRevision: this.attentionRevision,
      lastLine: this._lastLinePreview(),
    };
  }

  // A sanitized preview of the last non-empty terminal line (for list/detail previews).
  _lastLinePreview() {
    const last = this._tailLines(3)
      .map((s) => s.replace(/\s+$/, ""))
      .filter(Boolean)
      .pop() || "";
    return last.length > 120 ? last.slice(0, 119) + "\u2026" : last;
  }

  // ---- scrollback read / search (visible screen + retained scrollback) ----

  // All buffer rows (scrollback + screen) as plain trimmed-right text.
  _bufferLines() {
    const lines = [];
    try {
      const b = this.term.buffer.active;
      for (let y = 0; y < b.length; y++) {
        const line = b.getLine(y);
        lines.push(line ? line.translateToString(true) : "");
      }
    } catch {
      /* buffer not ready */
    }
    return lines;
  }

  // Last `n` non-empty logical lines as a single string. Drained through the op queue for accuracy.
  readTail(n = 50) {
    return this._queueOp(() => {
      const lines = this._bufferLines();
      let end = lines.length;
      while (end > 0 && !lines[end - 1].trim()) end--;
      return lines.slice(Math.max(0, end - n), end).join("\n");
    });
  }

  // Case-insensitive substring search over the retained buffer. Returns [{ line, text }].
  readSearch(query, limit = 200) {
    return this._queueOp(() => {
      if (!query) return [];
      const q = String(query).toLowerCase();
      const lines = this._bufferLines();
      const matches = [];
      for (let y = 0; y < lines.length && matches.length < limit; y++) {
        if (lines[y].toLowerCase().includes(q)) matches.push({ line: y, text: lines[y].slice(0, 200) });
      }
      return matches;
    });
  }
}

export class SessionManager {
  constructor(cfg) {
    this.cfg = cfg;
    this.sessions = new Map();
    this._onEvent = null; // (frame, { notify, session }) => void  — set by the server
    this._attTimer = null;
  }

  // Start the single manager-level attention loop. `onEvent` receives a session.activity frame plus
  // metadata (notify=true on transitions into waiting/bell/finished/exited) so the server can
  // broadcast it and (optionally) fire notifications. One timer for all sessions — never one per PTY.
  startEventLoop(onEvent) {
    this._onEvent = onEvent;
    if (this._attTimer) clearInterval(this._attTimer);
    this._attTimer = setInterval(() => {
      for (const s of this.sessions.values()) {
        if (s.state === "running") s.evaluateQuiet();
      }
    }, 1000);
    this._attTimer.unref?.();
  }

  stopEventLoop() {
    if (this._attTimer) clearInterval(this._attTimer);
    this._attTimer = null;
    this._onEvent = null;
  }

  _emitAttention(session, notify) {
    if (!this._onEvent) return;
    try {
      this._onEvent(
        out.activity({
          sessionId: session.id,
          activity: session.activity,
          attention: session.attention,
          attentionSince: session.attentionSince,
          attentionConfidence: session.attentionConfidence,
          attentionRevision: session.attentionRevision,
        }),
        { notify, session }
      );
    } catch {
      /* never let a listener break the session */
    }
  }

  list() {
    return [...this.sessions.values()].map((s) => s.summary());
  }

  get(id) {
    return this.sessions.get(id);
  }

  create({ profile, cwd, cols, rows, title }) {
    const running = [...this.sessions.values()].filter((s) => s.state === "running").length;
    if (running >= this.cfg.maxSessions) {
      throw new Error(`session limit reached (${this.cfg.maxSessions})`);
    }
    const profileCfg = this.cfg.profiles[profile];
    if (!profileCfg) throw new Error(`unknown profile: ${profile}`);
    const s = new Session(this, {
      profile,
      profileCfg,
      cwd,
      cols: cols || 100,
      rows: rows || 30,
      title,
    });
    this.sessions.set(s.id, s);
    this._persistManifest();
    return s;
  }

  _remove(id) {
    this.sessions.delete(id);
    this._persistManifest();
  }

  // Persist the set of currently-running sessions so they can be reopened after a daemon
  // restart / reboot (fresh shells in the same dirs — like a browser reopening tabs).
  _persistManifest() {
    if (this.cfg.restoreSessions === false) return;
    const running = [...this.sessions.values()]
      .filter((s) => s.state === "running")
      .map((s) => ({ sessionId: s.id, profile: s.profile, cwd: s.cwd, title: s.title, cols: s.cols, rows: s.rows }));
    try {
      saveSessionManifest(running);
    } catch {
      /* ignore */
    }
  }

  // On startup, relaunch the sessions that were running, preserving their ids (so mobile tabs
  // re-match) but with a fresh generation (so clients reset replay state).
  restore() {
    if (this.cfg.restoreSessions === false) return;
    let manifest = [];
    try {
      manifest = loadSessionManifest();
    } catch {
      /* ignore */
    }
    let n = 0;
    for (const e of manifest) {
      if (!e || !this.cfg.profiles[e.profile]) continue;
      if (this.sessions.size >= this.cfg.maxSessions) break;
      try {
        const s = new Session(this, {
          id: e.sessionId,
          profile: e.profile,
          profileCfg: this.cfg.profiles[e.profile],
          cwd: e.cwd,
          cols: e.cols || 100,
          rows: e.rows || 30,
          title: e.title,
        });
        this.sessions.set(s.id, s);
        n++;
      } catch (err) {
        console.error("  session restore failed:", e.sessionId, err?.message || err);
      }
    }
    if (n) console.log(`  restored ${n} session(s) from last run`);
    this._persistManifest();
  }

  shutdown() {
    this.stopEventLoop();
    for (const s of this.sessions.values()) {
      try {
        if (s.state === "running") s.pty.kill();
      } catch {
        /* ignore */
      }
    }
  }
}
