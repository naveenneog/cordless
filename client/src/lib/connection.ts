import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Creds, getServerBase, wsUrl } from "./storage";
import type { OutputFrame, ExitFrame, SessionSummary, SessionState } from "./protocol";

type ConnState = "closed" | "connecting" | "authenticating" | "ready";

const BACKOFF = [0, 1000, 2000, 5000, 10000, 20000];
const ACK_INTERVAL = 250;
const RESIZE_DEBOUNCE = 90;
const LIST_POLL = 4000;
const WATCHDOG_MS = 15000;
const HOT_BACKGROUND = 3; // active + up to N background sessions stay attached/streaming
const MAX_QUEUED_BYTES = 1024 * 1024; // detach a noisy background tab past this
const REQUEST_TIMEOUT = 12000;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}
function strToB64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function latin1ToB64(s: string): string {
  let bin = "";
  for (let i = 0; i < s.length; i++) bin += String.fromCharCode(s.charCodeAt(i) & 0xff);
  return btoa(bin);
}

interface Tab {
  sessionId: string;
  title: string;
  profile: string;
  state: SessionState;
  exitCode: number | null;
  term: Terminal;
  fit: FitAddon;
  pane: HTMLDivElement | null;
  opened: boolean;
  appliedSeq: number; // last seq parsed into xterm (what we ack)
  highestReceivedSeq: number;
  applyChain: Promise<void>;
  queuedBytes: number;
  attachedEpoch: number | null;
  pendingAck: boolean;
  ackTimer: ReturnType<typeof setTimeout> | null;
  unread: boolean;
  desiredCols: number;
  desiredRows: number;
}

export interface TabView {
  sessionId: string;
  title: string;
  profile: string;
  state: SessionState;
  exitCode: number | null;
  unread: boolean;
  active: boolean;
}

const TERM_THEME = {
  background: "#0b0e14",
  foreground: "#c7d0e0",
  cursor: "#7aa2f7",
  selectionBackground: "#2a3555",
  black: "#15161e",
  red: "#f7768e",
  green: "#9ece6a",
  yellow: "#e0af68",
  blue: "#7aa2f7",
  magenta: "#bb9af7",
  cyan: "#7dcfff",
  white: "#a9b1d6",
  brightBlack: "#414868",
  brightRed: "#f7768e",
  brightGreen: "#9ece6a",
  brightYellow: "#e0af68",
  brightBlue: "#7aa2f7",
  brightMagenta: "#bb9af7",
  brightCyan: "#7dcfff",
  brightWhite: "#c0caf5",
};

let ridSeq = 0;
const rid = () => "c" + ++ridSeq;

export class Connection {
  state: ConnState = "closed";
  lastError = "";
  private ws: WebSocket | null = null;
  private epoch = 0;
  private creds: Creds;
  private base: string;
  private backoffIdx = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private listTimer: ReturnType<typeof setInterval> | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFrameAt = 0;
  private helloResolved = false;

  activeId: string | null = null;
  tabs = new Map<string, Tab>();
  ctrlLatch = false;
  altLatch = false;
  private mru: string[] = []; // most-recently-active first
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void; epoch: number; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<() => void>();
  private stopped = false;

  constructor(creds: Creds) {
    this.creds = creds;
    this.base = getServerBase();
    window.addEventListener("online", this.onOnline);
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("resize", this.onViewportChange);
    window.visualViewport?.addEventListener("resize", this.onViewportChange);
  }

  // ---- pub/sub for React ----
  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const fn of this.listeners) fn();
  }

  getTabsView(): TabView[] {
    return [...this.tabs.values()].map((t) => ({
      sessionId: t.sessionId,
      title: t.title,
      profile: t.profile,
      state: t.state,
      exitCode: t.exitCode,
      unread: t.unread,
      active: t.sessionId === this.activeId,
    }));
  }

  // ---- lifecycle ----
  start() {
    this.stopped = false;
    this.connect();
  }

  private connect() {
    if (this.stopped) return;
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) return;
    this.clearReconnect();
    this.state = "connecting";
    this.helloResolved = false;
    this.epoch += 1;
    const epoch = this.epoch;
    this.emit();

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl(this.base));
    } catch (e: any) {
      this.lastError = String(e?.message || e);
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      if (epoch !== this.epoch) {
        try { ws.close(); } catch {}
        return;
      }
      this.state = "authenticating";
      this.lastFrameAt = Date.now();
      this.emit();
      this.rawSend({ type: "hello", requestId: rid(), deviceId: this.creds.deviceId, token: this.creds.token });
    };

    ws.onmessage = (ev) => {
      if (epoch !== this.epoch) return;
      this.lastFrameAt = Date.now();
      let m: any;
      try { m = JSON.parse(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data)); } catch { return; }
      this.onMessage(m, epoch);
    };

    ws.onclose = () => {
      if (epoch !== this.epoch) return;
      this.onClose(epoch);
    };
    ws.onerror = () => { /* onclose will follow */ };
  }

  private onClose(epoch: number) {
    this.state = "closed";
    this.ws = null;
    this.stopWatchdog();
    this.stopListPoll();
    // reject in-flight requests for this epoch
    for (const [id, p] of [...this.pending]) {
      if (p.epoch === epoch) {
        clearTimeout(p.timer);
        p.reject(new Error("connection closed"));
        this.pending.delete(id);
      }
    }
    // detach tabs (keep lastSeq/appliedSeq!)
    for (const t of this.tabs.values()) {
      t.attachedEpoch = null;
      if (t.ackTimer) { clearTimeout(t.ackTimer); t.ackTimer = null; }
      t.pendingAck = false;
    }
    this.emit();
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    this.clearReconnect();
    const delay = BACKOFF[Math.min(this.backoffIdx, BACKOFF.length - 1)] + (this.backoffIdx >= BACKOFF.length ? Math.random() * 5000 : 0);
    this.backoffIdx += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
  private clearReconnect() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  private onOnline = () => {
    this.backoffIdx = 0;
    if (this.state === "closed") this.connect();
  };
  private onVisibility = () => {
    if (document.visibilityState === "visible") {
      this.backoffIdx = 0;
      if (this.state === "closed") this.connect();
    } else {
      // flush acks immediately before backgrounding
      for (const t of this.tabs.values()) if (t.pendingAck) this.flushAck(t, this.epoch);
    }
  };

  // ---- messaging ----
  private rawSend(obj: any): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify(obj)); return true; } catch { return false; }
    }
    return false;
  }

  private request(obj: any): Promise<any> {
    const requestId = obj.requestId || rid();
    obj.requestId = requestId;
    const epoch = this.epoch;
    return new Promise((resolve, reject) => {
      if (!this.rawSend(obj)) { reject(new Error("not connected")); return; }
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("request timeout: " + obj.type));
      }, REQUEST_TIMEOUT);
      this.pending.set(requestId, { resolve, reject, epoch, timer });
    });
  }

  private resolveRequest(m: any) {
    const p = this.pending.get(m.requestId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(m.requestId);
    if (m.ok === false) p.reject(new Error(m.error?.message || "request failed"));
    else p.resolve(m);
  }

  private async onMessage(m: any, epoch: number) {
    switch (m.type) {
      case "hello.result":
        if (m.ok) {
          this.helloResolved = true;
          this.state = "ready";
          this.backoffIdx = 0;
          this.lastError = "";
          this.emit();
          this.startWatchdog();
          this.startListPoll();
          await this.onReady(epoch);
        } else {
          this.lastError = m.error?.message || "auth failed";
          this.emit();
          try { this.ws?.close(); } catch {}
        }
        break;
      case "session.output":
        this.onOutput(m as OutputFrame, epoch);
        break;
      case "session.exit":
        this.onExit(m as ExitFrame);
        break;
      case "session.list.result":
        this.onList(m.sessions as SessionSummary[]);
        this.resolveRequest(m);
        break;
      default:
        if (m.requestId) this.resolveRequest(m);
    }
  }

  // After (re)connect + auth: re-attach the hot set (active first), resend sizes.
  private async onReady(epoch: number) {
    const hot = this.hotSet();
    const ordered = this.activeId ? [this.activeId, ...hot.filter((id) => id !== this.activeId)] : hot;
    for (const id of ordered) {
      const t = this.tabs.get(id);
      if (!t || epoch !== this.epoch) continue;
      await t.applyChain.catch(() => {}); // drain queued writes so appliedSeq is accurate
      if (epoch !== this.epoch) return;
      await this.attachTab(t, epoch);
    }
  }

  private hotSet(): string[] {
    const ids = [...this.mru];
    if (this.activeId && !ids.includes(this.activeId)) ids.unshift(this.activeId);
    return ids.slice(0, 1 + HOT_BACKGROUND);
  }

  private async attachTab(t: Tab, epoch: number) {
    try {
      const res = await this.request({
        type: "session.attach",
        sessionId: t.sessionId,
        fromSeq: t.appliedSeq >= 0 ? t.appliedSeq : null,
      });
      if (epoch !== this.epoch) return;
      t.attachedEpoch = epoch;
      // resend desired size after attach
      if (t.desiredCols && t.desiredRows) {
        this.rawSend({ type: "session.resize", sessionId: t.sessionId, cols: t.desiredCols, rows: t.desiredRows });
      }
      void res;
    } catch {
      /* will retry on next reconnect */
    }
  }

  private detachTab(t: Tab) {
    if (t.attachedEpoch !== null) {
      this.rawSend({ type: "session.detach", sessionId: t.sessionId });
      t.attachedEpoch = null;
    }
  }

  private reconcileHotSet() {
    const keep = new Set(this.hotSet());
    for (const t of this.tabs.values()) {
      if (t.sessionId === this.activeId) continue;
      if (!keep.has(t.sessionId) && t.attachedEpoch !== null) this.detachTab(t);
    }
    // attach any hot member not attached
    if (this.state === "ready") {
      for (const id of keep) {
        const t = this.tabs.get(id);
        if (t && t.attachedEpoch === null) void this.attachTab(t, this.epoch);
      }
    }
  }

  // ---- output application (serialized per tab; reset ordered behind writes) ----
  private onOutput(frame: OutputFrame, epoch: number) {
    const t = this.tabs.get(frame.sessionId);
    if (!t) return;
    if (!frame.reset && frame.seq <= t.appliedSeq) return; // duplicate
    t.highestReceivedSeq = Math.max(t.highestReceivedSeq, frame.seq);
    if (t.sessionId !== this.activeId && !t.unread) { t.unread = true; this.emit(); }

    const bytes = b64ToBytes(frame.data);
    t.queuedBytes += bytes.length;

    t.applyChain = t.applyChain.then(
      () =>
        new Promise<void>((resolve) => {
          if (epoch !== this.epoch) { t.queuedBytes -= bytes.length; resolve(); return; }
          if (frame.reset) t.term.reset();
          t.term.write(bytes, () => {
            t.queuedBytes -= bytes.length;
            if (epoch === this.epoch) {
              t.appliedSeq = frame.seq;
              this.scheduleAck(t, epoch);
            }
            resolve();
          });
        })
    );

    // protect the UI: drop a noisy *background* tab
    if (t.sessionId !== this.activeId && t.queuedBytes > MAX_QUEUED_BYTES && t.attachedEpoch !== null) {
      this.detachTab(t);
    }
  }

  private scheduleAck(t: Tab, epoch: number) {
    t.pendingAck = true;
    if (t.ackTimer) return;
    t.ackTimer = setTimeout(() => {
      t.ackTimer = null;
      if (epoch === this.epoch) this.flushAck(t, epoch);
    }, ACK_INTERVAL);
  }
  private flushAck(t: Tab, epoch: number) {
    if (epoch !== this.epoch || t.attachedEpoch !== epoch) { t.pendingAck = false; return; }
    if (!t.pendingAck) return;
    t.pendingAck = false;
    this.rawSend({ type: "session.ack", sessionId: t.sessionId, seq: t.appliedSeq });
  }

  private onExit(frame: ExitFrame) {
    const t = this.tabs.get(frame.sessionId);
    if (!t) return;
    t.state = "exited";
    t.exitCode = frame.exitCode;
    this.emit();
  }

  private onList(sessions: SessionSummary[]) {
    const seen = new Set<string>();
    for (const s of sessions) {
      seen.add(s.sessionId);
      let t = this.tabs.get(s.sessionId);
      if (!t) {
        t = this.createTabShell(s);
        this.tabs.set(s.sessionId, t);
      }
      t.title = s.title;
      t.state = s.state;
      t.exitCode = s.exitCode;
      // cheap unread for ALL sessions (even detached): server latestSeq advanced past what we applied
      if (s.sessionId !== this.activeId && s.latestSeq > t.appliedSeq) {
        if (!t.unread) t.unread = true;
      }
    }
    // auto-select the most recently active session if nothing is active (e.g. after reload)
    if (!this.activeId && sessions.length) {
      const recent = [...sessions].sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1))[0];
      this.setActive(recent.sessionId);
    } else {
      this.emit();
    }
  }

  // ---- terminals ----
  private createTabShell(s: SessionSummary): Tab {
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 14,
      scrollback: 5000,
      theme: TERM_THEME,
      allowProposedApi: false,
      macOptionIsMeta: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    try { term.loadAddon(new WebLinksAddon()); } catch {}

    const tab: Tab = {
      sessionId: s.sessionId,
      title: s.title,
      profile: s.profile,
      state: s.state,
      exitCode: s.exitCode,
      term,
      fit,
      pane: null,
      opened: false,
      appliedSeq: -1,
      highestReceivedSeq: -1,
      applyChain: Promise.resolve(),
      queuedBytes: 0,
      attachedEpoch: null,
      pendingAck: false,
      ackTimer: null,
      unread: false,
      desiredCols: s.cols || 80,
      desiredRows: s.rows || 24,
    };

    term.onData((d) => this.sendData(tab, d));
    term.onBinary((d) => this.sendInput(tab, latin1ToB64(d)));
    return tab;
  }

  private sendInput(t: Tab, dataB64: string) {
    if (this.state !== "ready" || t.attachedEpoch !== this.epoch) return; // never queue input across disconnect
    this.rawSend({ type: "session.input", sessionId: t.sessionId, data: dataB64 });
  }

  // Typed input path: apply latched Ctrl/Alt modifiers, then send.
  private sendData(t: Tab, d: string) {
    this.sendInput(t, strToB64(this.consumeModifiers(d)));
  }

  private consumeModifiers(d: string): string {
    if (this.ctrlLatch && d.length === 1) {
      const up = d.toUpperCase().charCodeAt(0);
      if (up >= 63 && up <= 95) d = String.fromCharCode(up & 0x1f);
      this.ctrlLatch = false;
      this.emit();
    }
    if (this.altLatch && d) {
      d = "\x1b" + d;
      this.altLatch = false;
      this.emit();
    }
    return d;
  }

  getActiveTab(): Tab | null {
    return this.activeId ? this.tabs.get(this.activeId) || null : null;
  }

  // Touch keybar: send a literal control sequence (Esc, Tab, arrows, Ctrl-C, ...) to the active pty.
  pressSpecial(seq: string) {
    const t = this.getActiveTab();
    if (t) this.sendInput(t, strToB64(seq));
    const el = t?.pane;
    if (el) t!.term.focus();
  }

  sendText(text: string) {
    const t = this.getActiveTab();
    if (t) this.sendInput(t, strToB64(text));
  }

  toggleCtrl() {
    this.ctrlLatch = !this.ctrlLatch;
    if (this.ctrlLatch) this.altLatch = this.altLatch; // no-op, keep independent
    this.emit();
  }
  toggleAlt() {
    this.altLatch = !this.altLatch;
    this.emit();
  }

  // React calls this when a pane div mounts.
  mountPane(sessionId: string, el: HTMLDivElement) {
    const t = this.tabs.get(sessionId);
    if (!t) return;
    t.pane = el;
    if (!t.opened) {
      t.term.open(el);
      t.opened = true;
    }
    if (sessionId === this.activeId) this.activatePane(t);
  }

  private activatePane(t: Tab) {
    requestAnimationFrame(() => {
      const el = t.pane;
      if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
      try { t.fit.fit(); } catch {}
      this.applyResize(t);
      t.term.focus();
    });
  }

  private applyResize(t: Tab) {
    const cols = clamp(t.term.cols, 2, 300);
    const rows = clamp(t.term.rows, 1, 120);
    if (cols === t.desiredCols && rows === t.desiredRows) return;
    t.desiredCols = cols;
    t.desiredRows = rows;
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      if (t.attachedEpoch === this.epoch) {
        this.rawSend({ type: "session.resize", sessionId: t.sessionId, cols, rows });
      }
    }, RESIZE_DEBOUNCE);
  }

  private onViewportChange = () => {
    const t = this.activeId ? this.tabs.get(this.activeId) : null;
    if (!t) return;
    requestAnimationFrame(() => {
      const el = t.pane;
      if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
      try { t.fit.fit(); } catch {}
      this.applyResize(t);
    });
  };

  // ---- public actions ----
  refit(sessionId: string) {
    const t = this.tabs.get(sessionId);
    if (t && t.opened) this.activatePane(t);
  }

  setActive(sessionId: string) {
    if (this.activeId === sessionId) return;
    this.activeId = sessionId;
    this.mru = [sessionId, ...this.mru.filter((id) => id !== sessionId)];
    const t = this.tabs.get(sessionId);
    if (t) {
      t.unread = false;
      if (t.attachedEpoch === null && this.state === "ready") void this.attachTab(t, this.epoch);
      if (t.opened) this.activatePane(t);
    }
    this.reconcileHotSet();
    this.emit();
  }

  async createSession(profile: string, opts: { cwd?: string; title?: string } = {}) {
    const t = this.activeId ? this.tabs.get(this.activeId) : null;
    const cols = t?.desiredCols || 80;
    const rows = t?.desiredRows || 24;
    const res = await this.request({ type: "session.create", profile, cwd: opts.cwd, cols, rows, title: opts.title });
    const sessionId = res.sessionId as string;
    // proactively fetch list so the tab appears with correct metadata
    await this.refreshList();
    this.setActive(sessionId);
    return sessionId;
  }

  async killSession(sessionId: string) {
    await this.request({ type: "session.kill", sessionId, mode: "graceful" }).catch(() => {});
    const t = this.tabs.get(sessionId);
    if (t) {
      this.closeTabLocal(sessionId);
    }
  }

  // Remove a tab locally (detach + dispose). Does not kill the remote session.
  closeTab(sessionId: string) {
    this.detachTabById(sessionId);
    this.closeTabLocal(sessionId);
  }
  private detachTabById(sessionId: string) {
    const t = this.tabs.get(sessionId);
    if (t) this.detachTab(t);
  }
  private closeTabLocal(sessionId: string) {
    const t = this.tabs.get(sessionId);
    if (!t) return;
    if (t.ackTimer) clearTimeout(t.ackTimer);
    try { t.term.dispose(); } catch {}
    this.tabs.delete(sessionId);
    this.mru = this.mru.filter((id) => id !== sessionId);
    if (this.activeId === sessionId) {
      this.activeId = this.mru[0] || (this.tabs.keys().next().value ?? null);
      if (this.activeId) this.setActive(this.activeId);
    }
    this.reconcileHotSet();
    this.emit();
  }

  refreshList() {
    return this.request({ type: "session.list" }).catch(() => {});
  }

  // ---- watchdog + poll ----
  private startWatchdog() {
    this.stopWatchdog();
    this.watchdogTimer = setInterval(() => {
      if (Date.now() - this.lastFrameAt > WATCHDOG_MS) {
        try { this.ws?.close(); } catch {}
      }
    }, 5000);
  }
  private stopWatchdog() {
    if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = null; }
  }
  private startListPoll() {
    this.stopListPoll();
    void this.refreshList();
    this.listTimer = setInterval(() => { if (this.state === "ready") void this.refreshList(); }, LIST_POLL);
  }
  private stopListPoll() {
    if (this.listTimer) { clearInterval(this.listTimer); this.listTimer = null; }
  }

  destroy() {
    this.stopped = true;
    this.clearReconnect();
    this.stopWatchdog();
    this.stopListPoll();
    window.removeEventListener("online", this.onOnline);
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("resize", this.onViewportChange);
    window.visualViewport?.removeEventListener("resize", this.onViewportChange);
    try { this.ws?.close(); } catch {}
  }
}
