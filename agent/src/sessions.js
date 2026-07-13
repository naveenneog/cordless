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
import { loadSessionManifest, saveSessionManifest, saveSessionHistory, loadSessionHistory, clearSessionHistory, listSessionHistoryIds, loadGroups, saveGroups } from "./state.js";
import { validateProfile, profileExecutable, resolveExecutable, expandHome } from "./profiles.js";
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

// Normalize a user-supplied tab title: NFC, trimmed, control/bidi chars stripped, capped to 80 code
// points and 256 UTF-8 bytes. An empty result falls back to the session's generated default title.
function normalizeTitle(raw, fallback) {
  let t = (typeof raw === "string" ? raw : "").normalize("NFC");
  // Strip C0/C1 controls, DEL, and bidi override/isolate controls; collapse any inner whitespace runs.
  t = t.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").replace(/\s+/g, " ").trim();
  if (!t) return fallback;
  const cps = [...t];
  if (cps.length > 80) t = cps.slice(0, 80).join("").trim();
  while (Buffer.byteLength(t, "utf8") > 256) t = [...t].slice(0, -1).join("");
  return t || fallback;
}

// Tab-group colors (Chrome-mobile-style) and group-name normalization (<=40 code points).
export const GROUP_COLORS = ["blue", "green", "yellow", "red", "purple", "gray"];
function normalizeGroupName(raw) {
  let t = (typeof raw === "string" ? raw : "").normalize("NFC");
  t = t.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").replace(/\s+/g, " ").trim();
  const cps = [...t];
  if (cps.length > 40) t = cps.slice(0, 40).join("").trim();
  return t;
}

class Session {
  constructor(mgr, { id, profile, profileCfg, cwd, cols, rows, title, groupId, groupOrder }) {
    this.mgr = mgr;
    this.id = id || crypto.randomUUID();
    this.generation = crypto.randomUUID();
    this.profile = profile;
    this.attentionPreset = (profileCfg && profileCfg.attentionPreset) || null;
    this.cwd = validCwd(cwd);
    this.cols = cols;
    this.rows = rows;
    this._defaultTitle = `${(profileCfg && profileCfg.label) || profile} \u00b7 ${path.basename(this.cwd) || this.cwd}`;
    this.title = title || this._defaultTitle;
    this.metaRevision = 0; // monotonic session-metadata revision (bumped on rename); clients ignore stale
    this.groupId = groupId || null; // tab group membership (null = ungrouped)
    this.groupOrder = typeof groupOrder === "number" ? groupOrder : 0;
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
    this._historyDirty = false; // has output arrived since the last persisted-history write?
    this._historySavedAt = 0;
    this._restoredHistory = null; // frozen plain-text scrollback from before a restart (shown above live)

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

    const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", ...(profileCfg.env || {}) };
    // A profile with `command` is spawned directly (Sol's model); otherwise spawn the shell and, for
    // legacy agent profiles (claude/codex), type their `initCommand` once it's ready. Resolve the
    // command to a full path first — node-pty on Windows won't find a bare name via PATHEXT itself.
    const spawnCmd = profileCfg.command ? resolveExecutable(profileCfg.command, env) || profileCfg.command : resolveShell(mgr.cfg);
    const spawnArgs = profileCfg.command ? (profileCfg.args || []) : [];
    this.pty = pty.spawn(spawnCmd, spawnArgs, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: this.cwd,
      env,
    });
    this.pty.onData((d) => this._onData(d));
    this.pty.onExit((e) => this._onExit(e));

    if (!profileCfg.command && profileCfg.initCommand) {
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
            this._historyDirty = true; // periodic manager flush will persist the scrollback
            resolve();
          });
        })
    );
  }

  // ---- attention detection (see attention.js) ----

  // A coding-agent session (claude/codex by name, or any profile with attentionPreset "agent" such as
  // the built-in copilot). Drives the "finished" heuristic + the finished-on-exit badge.
  _isAgent() {
    return this.attentionPreset === "agent" || this.profile === "claude" || this.profile === "codex";
  }

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
    // Defer (without marking checked) while the user's keypress grace or a bell hold is active, so the
    // prompt check actually runs on a later tick instead of being skipped for this whole quiet cycle.
    if (Date.now() - this._lastInputAt < THRESHOLDS.INPUT_GRACE_MS) return;
    if (this._bellUntil > Date.now()) return;
    this._quietChecked = true;
    this._queueOp(() => {
      if (this.state !== "running") return;
      if (Date.now() - this._lastOutputAt < THRESHOLDS.PROMPT_QUIET_MS) return; // new output arrived
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
        this._isAgent() &&
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
        // Prepend the restored (pre-restart) scrollback above the live screen so a reopened session
        // shows its history on attach. It rides inside the single reset frame (a second reset would
        // wipe it), then the serialized live screen follows.
        const snap = Buffer.from(this._restoredHistoryText() + this._serialize.serialize(), "utf8");
        sub.deliver(
          out.output(this.id, latestSeq, snap.toString("base64"), { replay: true, reset: true }),
          snap.length
        );
        sub.mode = "reset";
      } else if (this._restoredHistory && this._restoredHistory.length) {
        // Restored but the fresh PTY hasn't emitted output yet — still show the history.
        const snap = Buffer.from(this._restoredHistoryText(), "utf8");
        sub.deliver(out.output(this.id, 0, snap.toString("base64"), { replay: true, reset: true }), snap.length);
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
    // An exited session is never reopened on the next daemon start, so its persisted history is moot;
    // drop the on-disk file (the live term buffer is still readable via `output` while it's listed).
    // BUT not during a daemon shutdown: those running sessions ARE restored next start, and on a
    // graceful stop (POSIX SIGTERM) shutdown() kills the PTY, so clearing here would wipe the history
    // we just saved for the restore.
    if (!this.mgr._shuttingDown) {
      this._historyDirty = false;
      clearSessionHistory(this.id);
    }
    // An agent session that did real work and then exited is "finished"; a bare shell exit is not.
    if (this._isAgent() && this._hadMeaningfulActivity) {
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
      titleRevision: this.metaRevision,
      groupId: this.groupId,
      groupOrder: this.groupOrder,
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

  // Rename the tab. An empty title restores the generated default. Bumps the monotonic metaRevision,
  // persists the manifest, and returns { title, revision }. The manager broadcasts session.updated.
  rename(rawTitle) {
    this.title = normalizeTitle(rawTitle, this._defaultTitle);
    this.metaRevision++;
    this.mgr._persistManifest();
    return { title: this.title, revision: this.metaRevision };
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

  // Live buffer as plain lines with control chars stripped and trailing blank lines removed.
  _liveLines() {
    let lines = this._bufferLines().map((l) => l.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ""));
    let end = lines.length;
    while (end > 0 && !lines[end - 1].trim()) end--;
    return lines.slice(0, end);
  }

  _restoredBanner() {
    return "\u2500\u2500 cordless: session reopened after system restart \u2500\u2500";
  }

  // Restored (pre-restart) history shown above the live output, as one string, or "".
  _restoredHistoryText() {
    if (!this._restoredHistory || !this._restoredHistory.length) return "";
    return this._restoredHistory.join("\r\n") + "\r\n\x1b[2m" + this._restoredBanner() + "\x1b[0m\r\n";
  }

  // Last `n` non-empty logical lines as a single string (restored history counts as the oldest lines,
  // so a reopened session's `output` shows what it was doing before the restart). Drained via the queue.
  readTail(n = 50) {
    return this._queueOp(() => {
      let lines = this._liveLines();
      if (this._restoredHistory && this._restoredHistory.length) {
        lines = [...this._restoredHistory, this._restoredBanner(), ...lines];
      }
      return lines.slice(Math.max(0, lines.length - n)).join("\n");
    });
  }

  // Case-insensitive substring search over restored history + the retained buffer. Returns [{ line, text }].
  readSearch(query, limit = 200) {
    return this._queueOp(() => {
      if (!query) return [];
      const q = String(query).toLowerCase();
      const restored = this._restoredHistory && this._restoredHistory.length ? [...this._restoredHistory, this._restoredBanner()] : [];
      const lines = [...restored, ...this._liveLines()];
      const matches = [];
      for (let y = 0; y < lines.length && matches.length < limit; y++) {
        if (lines[y].toLowerCase().includes(q)) matches.push({ line: y, text: lines[y].slice(0, 200) });
      }
      return matches;
    });
  }

  // ---- persisted history (normalized plain-text scrollback, survives a daemon restart) ----

  _historyCfg() {
    return this.mgr.cfg.history || {};
  }

  // Cap lines to maxLines / maxBytes, keeping the newest (whichever limit hits first).
  _capHistoryLines(lines) {
    const h = this._historyCfg();
    const maxLines = h.maxLines || 2000;
    const maxBytes = h.maxBytes || 512 * 1024;
    lines = lines.slice(Math.max(0, lines.length - maxLines)).map((l) => l.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ""));
    let bytes = lines.reduce((n, l) => n + Buffer.byteLength(l, "utf8") + 1, 0);
    while (lines.length && bytes > maxBytes) {
      bytes -= Buffer.byteLength(lines.shift(), "utf8") + 1;
    }
    return lines;
  }

  // The record we persist: restored (pre-restart) history followed by the current live buffer, capped.
  // Merging means history chains across multiple restarts instead of being lost on the second one.
  _captureHistoryRecord() {
    const merged = this._capHistoryLines([...(this._restoredHistory || []), ...this._liveLines()]);
    return { version: 1, sessionId: this.id, generation: this.generation, capturedAt: new Date().toISOString(), lines: merged };
  }

  // Persist the scrollback if it changed since the last write. Called on a periodic manager sweep
  // (every few seconds) so history survives a hard kill / reboot — not just a clean shutdown — while
  // staying bounded to at most one write per session per sweep.
  flushHistoryIfDirty() {
    if (this._historyCfg().persist === false) return;
    if (!this._historyDirty) return;
    this._saveHistoryNow();
  }

  _saveHistoryNow() {
    if (this._historyCfg().persist === false) return;
    try {
      saveSessionHistory(this.id, this._captureHistoryRecord());
      this._historyDirty = false;
      this._historySavedAt = Date.now();
    } catch (err) {
      console.error(`[session ${this.id}] history save failed`, err?.message || err);
    }
  }

  // On restore, keep the previous plain-text scrollback as frozen context shown *above* the live
  // session (in `output`/`search` and the attach snapshot). We deliberately do NOT write it into the
  // fresh terminal, because a reopened shell (e.g. PowerShell) clears the screen on startup and would
  // wipe it. `_restoredHistory` also chains forward via `_captureHistoryRecord`.
  seedRestoredHistory(record) {
    if (!record || !Array.isArray(record.lines) || !record.lines.length) return;
    this._restoredHistory = this._capHistoryLines(record.lines.map((l) => String(l)));
  }
}

export class SessionManager {
  constructor(cfg) {
    this.cfg = cfg;
    this.sessions = new Map();
    this._onEvent = null; // (frame, { notify, session }) => void  — set by the server
    this._attTimer = null;
    this._shuttingDown = false; // set during shutdown() so _onExit keeps history for the restore
    this.groups = loadGroups(); // { groupId: { id, name, color, order, revision, createdAt, updatedAt } }
  }

  // Start the single manager-level attention loop. `onEvent` receives a session.activity frame plus
  // metadata (notify=true on transitions into waiting/bell/finished/exited) so the server can
  // broadcast it and (optionally) fire notifications. One timer for all sessions — never one per PTY.
  startEventLoop(onEvent) {
    this._onEvent = onEvent;
    if (this._attTimer) clearInterval(this._attTimer);
    let ticks = 0;
    this._attTimer = setInterval(() => {
      for (const s of this.sessions.values()) {
        if (s.state === "running") s.evaluateQuiet();
      }
      // Every ~3s, persist any session whose scrollback changed, so history survives a reboot / hard
      // kill (not just a clean shutdown). Bounded to one write per session per sweep.
      if (++ticks % 3 === 0) {
        for (const s of this.sessions.values()) {
          if (s.state === "running") s.flushHistoryIfDirty();
        }
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

  // Rename a session and broadcast the change to every connected client (session.updated).
  rename(sessionId, rawTitle) {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error("unknown session");
    const res = s.rename(rawTitle);
    this._emitUpdated(s, { title: res.title });
    return res;
  }

  // Broadcast a session-metadata change to all clients (reuses the startEventLoop broadcast channel).
  _emitUpdated(session, changes) {
    if (!this._onEvent) return;
    try {
      this._onEvent(out.sessionUpdated(session.id, session.metaRevision, changes), {});
    } catch {
      /* never let a listener break the session */
    }
  }

  // ---- session groups (Chrome-mobile-style tab groups) ----
  listGroups() {
    return Object.values(this.groups).sort((a, b) => (a.order || 0) - (b.order || 0) || (a.createdAt || "").localeCompare(b.createdAt || ""));
  }

  _saveGroups() {
    try {
      saveGroups(this.groups);
    } catch {
      /* ignore */
    }
  }

  _emitGroups() {
    if (!this._onEvent) return;
    try {
      this._onEvent(out.groupsUpdated(this.listGroups()), {});
    } catch {
      /* ignore */
    }
  }

  createGroup({ name, color } = {}) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const g = {
      id,
      name: normalizeGroupName(name) || "Group",
      color: GROUP_COLORS.includes(color) ? color : "gray",
      order: Object.keys(this.groups).length,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.groups[id] = g;
    this._saveGroups();
    this._emitGroups();
    return g;
  }

  renameGroup(id, name) {
    const g = this.groups[id];
    if (!g) throw new Error("unknown group");
    const n = normalizeGroupName(name);
    if (n) g.name = n;
    g.revision++;
    g.updatedAt = new Date().toISOString();
    this._saveGroups();
    this._emitGroups();
    return g;
  }

  setGroupColor(id, color) {
    const g = this.groups[id];
    if (!g) throw new Error("unknown group");
    if (!GROUP_COLORS.includes(color)) throw new Error("invalid color");
    g.color = color;
    g.revision++;
    g.updatedAt = new Date().toISOString();
    this._saveGroups();
    this._emitGroups();
    return g;
  }

  reorderGroup(id, order) {
    const g = this.groups[id];
    if (!g) throw new Error("unknown group");
    g.order = order | 0;
    g.revision++;
    g.updatedAt = new Date().toISOString();
    this._saveGroups();
    this._emitGroups();
    return g;
  }

  // Deleting a group never kills its sessions — they become ungrouped.
  deleteGroup(id) {
    if (!this.groups[id]) throw new Error("unknown group");
    delete this.groups[id];
    for (const s of this.sessions.values()) {
      if (s.groupId === id) {
        s.groupId = null;
        s.groupOrder = 0;
        this._emitUpdated(s, { groupId: null });
      }
    }
    this._persistManifest();
    this._saveGroups();
    this._emitGroups();
    return true;
  }

  assignSession(sessionId, groupId, groupOrder) {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error("unknown session");
    if (groupId != null && !this.groups[groupId]) throw new Error("unknown group");
    s.groupId = groupId || null;
    if (typeof groupOrder === "number") s.groupOrder = groupOrder;
    this._persistManifest();
    this._emitUpdated(s, { groupId: s.groupId, groupOrder: s.groupOrder });
    return { sessionId, groupId: s.groupId, groupOrder: s.groupOrder };
  }

  // Drop assignments that point at groups which no longer exist (e.g. deleted while the daemon was off).
  _pruneGroupAssignments() {
    for (const s of this.sessions.values()) {
      if (s.groupId && !this.groups[s.groupId]) {
        s.groupId = null;
        s.groupOrder = 0;
      }
    }
  }

  // ---- persisted-history admin (used by the `history.clear` / `history.list` ops) ----
  // Clear on-disk history. With an id, clear just that one; otherwise clear every persisted file.
  // Cancels any pending debounced save so a live session doesn't immediately re-write it.
  clearHistory(sessionId) {
    if (sessionId) {
      const s = this.sessions.get(sessionId);
      if (s) s._historyDirty = false; // don't let the periodic sweep immediately re-write it
      return clearSessionHistory(sessionId) ? 1 : 0;
    }
    for (const s of this.sessions.values()) s._historyDirty = false;
    let n = 0;
    for (const id of listSessionHistoryIds()) if (clearSessionHistory(id)) n++;
    return n;
  }

  // Ids that currently have a persisted history file, annotated with whether the session is live.
  historyStatus() {
    return listSessionHistoryIds().map((id) => {
      const s = this.sessions.get(id);
      return { sessionId: id, live: !!s, title: s?.title || null, state: s?.state || "gone" };
    });
  }

  create({ profile, cwd, cols, rows, title }) {
    const running = [...this.sessions.values()].filter((s) => s.state === "running").length;
    if (running >= this.cfg.maxSessions) {
      throw new Error(`session limit reached (${this.cfg.maxSessions})`);
    }
    const profileCfg = this.cfg.profiles[profile];
    if (!profileCfg) throw new Error(`unknown profile: ${profile}`);
    const { ok, errors } = validateProfile(profile, profileCfg);
    if (!ok) throw new Error(`profile "${profile}" is misconfigured: ${errors.join("; ")}`);
    // Fail a launch clearly if the profile's executable isn't on the daemon's PATH (autostart PATH
    // often differs from the interactive shell). A bare shell has no executable and is always fine.
    const exe = profileExecutable(profileCfg);
    if (exe && !resolveExecutable(exe, process.env)) {
      throw new Error(`profile "${profile}" unavailable: "${exe}" was not found in the daemon PATH. Run \`cordless doctor\`.`);
    }
    // Precedence: explicit `cordless new` option > profile value > daemon default.
    const effectiveCwd = cwd || (profileCfg.cwd ? expandHome(profileCfg.cwd) : undefined);
    const effectiveTitle = title || profileCfg.title || undefined;
    const s = new Session(this, {
      profile,
      profileCfg,
      cwd: effectiveCwd,
      cols: cols || 100,
      rows: rows || 30,
      title: effectiveTitle,
    });
    this.sessions.set(s.id, s);
    this._persistManifest();
    return s;
  }

  _remove(id) {
    this.sessions.delete(id);
    clearSessionHistory(id); // a permanently-killed session keeps no persisted history
    this._persistManifest();
  }

  // Persist the set of currently-running sessions so they can be reopened after a daemon
  // restart / reboot (fresh shells in the same dirs — like a browser reopening tabs).
  _persistManifest() {
    if (this.cfg.restoreSessions === false) return;
    const running = [...this.sessions.values()]
      .filter((s) => s.state === "running")
      .map((s) => ({ sessionId: s.id, profile: s.profile, cwd: s.cwd, title: s.title, cols: s.cols, rows: s.rows, groupId: s.groupId, groupOrder: s.groupOrder }));
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
    const persistHistory = (this.cfg.history || {}).persist !== false;
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
          groupId: e.groupId || null,
          groupOrder: e.groupOrder || 0,
        });
        // Keep the previous plain-text scrollback as frozen context shown above the reopened session
        // (output/search/attach). We do NOT write it into the fresh terminal — a reopened shell
        // clears its screen on startup and would wipe it.
        if (persistHistory) {
          try {
            const hist = loadSessionHistory(e.sessionId);
            if (hist) s.seedRestoredHistory(hist);
          } catch {
            /* ignore a corrupt history file */
          }
        }
        this.sessions.set(s.id, s);
        n++;
      } catch (err) {
        console.error("  session restore failed:", e.sessionId, err?.message || err);
      }
    }
    if (n) console.log(`  restored ${n} session(s) from last run`);
    // Garbage-collect history files for sessions that no longer exist (e.g. ones that had exited).
    const live = new Set(this.sessions.keys());
    for (const id of listSessionHistoryIds()) if (!live.has(id)) clearSessionHistory(id);
    this._pruneGroupAssignments(); // drop assignments to groups deleted while the daemon was off
    this._persistManifest();
  }

  shutdown() {
    this._shuttingDown = true; // keep each running session's history when its PTY exit fires below
    this.stopEventLoop();
    for (const s of this.sessions.values()) {
      try {
        if (s.state === "running") {
          s._saveHistoryNow(); // final synchronous capture so a reopen shows the latest output
          s.pty.kill();
        }
      } catch {
        /* ignore */
      }
    }
  }
}
