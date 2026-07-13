import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Creds, getServerBase, wsUrl } from "./storage";
import type { OutputFrame, ExitFrame, SessionSummary, SessionState, SessionGroup } from "./protocol";

type ConnState = "closed" | "connecting" | "authenticating" | "ready";

const BACKOFF = [0, 1000, 2000, 5000, 10000, 20000];
const ACK_INTERVAL = 250;
const RESIZE_DEBOUNCE = 90;
const LIST_POLL = 4000;
const WATCHDOG_MS = 15000;
const CONNECT_TIMEOUT = 12000;
const HOT_BACKGROUND = 3; // active + up to N background sessions stay attached/streaming
const MAX_QUEUED_BYTES = 1024 * 1024; // suppress a noisy background tab past this
const REQUEST_TIMEOUT = 12000;
const BG_CLOSE_MS = 500;
const COLS_MIN = 20, COLS_MAX = 300, ROWS_MIN = 5, ROWS_MAX = 120;
const FONT_MIN = 10, FONT_MAX = 24, FONT_DEFAULT = 14;

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
  cwd: string;
  groupId: string | null;
  generation: string | null;
  state: SessionState;
  exitCode: number | null;
  term: Terminal;
  fit: FitAddon;
  pane: HTMLDivElement | null;
  opened: boolean;
  appliedSeq: number; // last seq parsed into xterm (what we ack)
  highestReceivedSeq: number; // admission gate
  applyChain: Promise<void>;
  queuedBytes: number;
  attachedEpoch: number | null;
  attachingEpoch: number | null;
  attachGeneration: number;
  streamSuppressed: boolean;
  pendingAck: boolean;
  ackTimer: ReturnType<typeof setTimeout> | null;
  ackEpoch: number | null;
  resizeTimer: ReturnType<typeof setTimeout> | null;
  resizeGeneration: number;
  unread: boolean;
  desiredCols: number;
  desiredRows: number;
}

export interface TabView {
  sessionId: string;
  title: string;
  profile: string;
  cwd: string;
  groupId: string | null;
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
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private backgroundCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFrameAt = 0;
  fontSize = FONT_DEFAULT;
  private paneObserver: ResizeObserver | null = null;
  private fitRaf = 0;

  activeId: string | null = null;
  tabs = new Map<string, Tab>();
  groups: SessionGroup[] = []; // tab groups (from group.list + groups.updated)
  private locallyClosed = new Set<string>();
  ctrlLatch = false;
  altLatch = false;
  private mru: string[] = []; // most-recently-active first
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void; epoch: number; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<() => void>();
  private stopped = false;

  constructor(creds: Creds) {
    this.creds = creds;
    this.base = getServerBase();
    this.fontSize = clamp(Math.round(Number(localStorage.getItem("cordless.fontSize")) || FONT_DEFAULT), FONT_MIN, FONT_MAX);
    if (typeof ResizeObserver !== "undefined") {
      this.paneObserver = new ResizeObserver(() => this.scheduleFit());
    }
    window.addEventListener("online", this.onOnline);
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("pagehide", this.onPageHide);
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
      cwd: t.cwd,
      groupId: t.groupId,
      state: t.state,
      exitCode: t.exitCode,
      unread: t.unread,
      active: t.sessionId === this.activeId,
    }));
  }

  getGroups(): SessionGroup[] {
    return [...this.groups].sort((a, b) => (a.order || 0) - (b.order || 0));
  }

  getSessionDetail(sessionId: string) {
    const t = this.tabs.get(sessionId);
    if (!t) return null;
    return {
      sessionId: t.sessionId,
      title: t.title,
      cwd: t.cwd,
      profile: t.profile,
      groupId: t.groupId,
      state: t.state,
      exitCode: t.exitCode,
      host: this.base,
    };
  }

  // ---- font zoom (per-device) ----
  adjustFont(delta: number) {
    this.setFontSize(this.fontSize + delta);
  }
  resetFont() {
    this.setFontSize(FONT_DEFAULT);
  }
  setFontSize(px: number) {
    const v = clamp(Math.round(px), FONT_MIN, FONT_MAX);
    if (v !== this.fontSize) {
      this.fontSize = v;
      try { localStorage.setItem("cordless.fontSize", String(v)); } catch {}
      for (const t of this.tabs.values()) {
        try { t.term.options.fontSize = v; } catch {}
      }
      this.emit();
    }
    this.scheduleFit();
  }

  // Coalesced fit of the active pane (called by the ResizeObserver and viewport/font changes).
  private scheduleFit() {
    cancelAnimationFrame(this.fitRaf);
    this.fitRaf = requestAnimationFrame(() => {
      const t = this.getActiveTab();
      const el = t?.pane;
      if (!t || !el || el.clientWidth === 0 || el.clientHeight === 0 || document.visibilityState !== "visible") return;
      try { t.fit.fit(); } catch {}
      try { t.term.refresh(0, t.term.rows - 1); } catch {}
      this.applyResize(t);
    });
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

    // one timer covering both open and authentication
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => {
      if (epoch === this.epoch && this.state !== "ready") {
        this.lastError = "connection timeout";
        try { ws.close(); } catch {}
      }
    }, CONNECT_TIMEOUT);

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
      void this.onMessage(m, epoch);
    };

    ws.onclose = () => {
      if (epoch !== this.epoch) return;
      this.onClose(epoch);
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  private onClose(epoch: number) {
    this.state = "closed";
    this.ws = null;
    if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
    this.stopWatchdog();
    this.stopListPoll();
    for (const [id, p] of [...this.pending]) {
      if (p.epoch === epoch) {
        clearTimeout(p.timer);
        p.reject(new Error("connection closed"));
        this.pending.delete(id);
      }
    }
    // detach tabs (keep appliedSeq!)
    for (const t of this.tabs.values()) {
      t.attachedEpoch = null;
      t.attachingEpoch = null;
      if (t.ackTimer) { clearTimeout(t.ackTimer); t.ackTimer = null; }
      t.ackEpoch = null;
      t.pendingAck = false;
    }
    this.emit();
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    this.clearReconnect();
    const delay =
      this.backoffIdx < BACKOFF.length ? BACKOFF[this.backoffIdx] : 30000 + Math.random() * 5000;
    this.backoffIdx += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
  private clearReconnect() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  private onOnline = () => {
    this.backoffIdx = 0;
    if (this.state === "closed" || !this.ws || this.ws.readyState >= WebSocket.CLOSING) this.connect();
  };
  private onVisibility = () => {
    if (document.visibilityState === "visible") {
      if (this.backgroundCloseTimer) { clearTimeout(this.backgroundCloseTimer); this.backgroundCloseTimer = null; }
      this.backoffIdx = 0;
      if (this.state === "closed" || !this.ws || this.ws.readyState >= WebSocket.CLOSING) this.connect();
      return;
    }
    // hidden: flush acks, then close shortly (Android may freeze JS while the socket looks open)
    for (const t of this.tabs.values()) if (t.pendingAck) this.flushAck(t, this.epoch);
    if (this.backgroundCloseTimer) clearTimeout(this.backgroundCloseTimer);
    this.backgroundCloseTimer = setTimeout(() => {
      this.backgroundCloseTimer = null;
      try { this.ws?.close(1000, "app backgrounded"); } catch {}
    }, BG_CLOSE_MS);
  };
  private onPageHide = () => {
    for (const t of this.tabs.values()) if (t.pendingAck) this.flushAck(t, this.epoch);
    try { this.ws?.close(1000, "pagehide"); } catch {}
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
          if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
          this.state = "ready";
          this.backoffIdx = 0;
          this.lastError = "";
          this.emit();
          this.startWatchdog();
          this.startListPoll();
          void this.request({ type: "group.list" }).catch(() => {});
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
      case "group.list.result":
        this.groups = (m.groups as SessionGroup[]) || [];
        this.emit();
        this.resolveRequest(m);
        break;
      case "groups.updated":
        this.groups = (m.groups as SessionGroup[]) || [];
        this.emit();
        break;
      case "session.updated": {
        const t = this.tabs.get(m.sessionId);
        if (t && m.changes) {
          if (typeof m.changes.title === "string") t.title = m.changes.title;
          if ("groupId" in m.changes) t.groupId = m.changes.groupId ?? null;
          this.emit();
        }
        break;
      }
      default:
        if (m.requestId) this.resolveRequest(m);
    }
  }

  // After (re)connect + auth: re-attach the hot set (active first).
  private async onReady(epoch: number) {
    const hot = this.hotSet();
    const ordered = this.activeId ? [this.activeId, ...hot.filter((id) => id !== this.activeId)] : hot;
    for (const id of ordered) {
      const t = this.tabs.get(id);
      if (!t || epoch !== this.epoch) continue;
      await this.attachTab(t, epoch);
    }
  }

  private hotSet(): string[] {
    const ids = this.mru.filter((id) => {
      const t = this.tabs.get(id);
      return t && (!t.streamSuppressed || id === this.activeId);
    });
    if (this.activeId && !ids.includes(this.activeId)) ids.unshift(this.activeId);
    return ids.slice(0, 1 + HOT_BACKGROUND);
  }

  private async attachTab(t: Tab, epoch: number) {
    if (epoch !== this.epoch || this.state !== "ready" || t.attachedEpoch === epoch || t.attachingEpoch === epoch) return;
    const generation = ++t.attachGeneration;
    t.attachingEpoch = epoch;

    // drain queued writes so appliedSeq is accurate, then reset per-stream state so the
    // server's replay-from-appliedSeq is not rejected as duplicates.
    await t.applyChain.catch(() => {});
    if (epoch !== this.epoch || generation !== t.attachGeneration) {
      if (t.attachingEpoch === epoch) t.attachingEpoch = null;
      return;
    }
    if (t.ackTimer) { clearTimeout(t.ackTimer); t.ackTimer = null; }
    t.ackEpoch = null;
    t.pendingAck = false;
    t.highestReceivedSeq = t.appliedSeq;

    try {
      const res = await this.request({
        type: "session.attach",
        sessionId: t.sessionId,
        fromSeq: t.appliedSeq >= 0 ? t.appliedSeq : null,
      });
      if (epoch !== this.epoch || generation !== t.attachGeneration || !this.hotSet().includes(t.sessionId)) {
        this.rawSend({ type: "session.detach", sessionId: t.sessionId });
        return;
      }
      t.attachedEpoch = epoch;
      if (t.desiredCols && t.desiredRows) {
        this.rawSend({ type: "session.resize", sessionId: t.sessionId, cols: t.desiredCols, rows: t.desiredRows });
      }
      void res;
    } catch {
      /* reconcile/reconnect will retry */
    } finally {
      if (t.attachingEpoch === epoch) t.attachingEpoch = null;
    }
  }

  private detachTab(t: Tab) {
    t.attachGeneration += 1; // invalidate any in-flight attach
    if (t.attachedEpoch !== null || t.attachingEpoch !== null) {
      this.rawSend({ type: "session.detach", sessionId: t.sessionId });
    }
    t.attachedEpoch = null;
    t.attachingEpoch = null;
  }

  private reconcileHotSet() {
    const keep = new Set(this.hotSet());
    for (const t of this.tabs.values()) {
      if (t.sessionId === this.activeId) continue;
      if (!keep.has(t.sessionId) && t.attachedEpoch !== null) this.detachTab(t);
    }
    if (this.state === "ready") {
      for (const id of keep) {
        const t = this.tabs.get(id);
        if (t && t.attachedEpoch === null && t.attachingEpoch === null) void this.attachTab(t, this.epoch);
      }
    }
  }

  // ---- output application (serialized per tab; reset ordered behind writes) ----
  private onOutput(frame: OutputFrame, epoch: number) {
    if (epoch !== this.epoch) return;
    const t = this.tabs.get(frame.sessionId);
    if (!t) return;
    // only accept frames from a stream we attached (or are attaching) this epoch
    if (t.attachedEpoch !== epoch && t.attachingEpoch !== epoch) return;

    if (frame.reset) {
      t.highestReceivedSeq = frame.seq;
    } else {
      if (frame.seq <= t.highestReceivedSeq) return; // duplicate
      const expected = t.highestReceivedSeq + 1;
      if (frame.seq !== expected) {
        this.lastError = `output gap ${frame.sessionId}: expected ${expected} got ${frame.seq}`;
        try { this.ws?.close(1011, "output gap"); } catch {}
        return;
      }
      t.highestReceivedSeq = frame.seq;
    }

    if (t.sessionId !== this.activeId && !t.unread) { t.unread = true; this.emit(); }

    const bytes = b64ToBytes(frame.data);
    t.queuedBytes += bytes.length;

    t.applyChain = t.applyChain.then(
      () =>
        new Promise<void>((resolve) => {
          if (frame.reset) t.term.reset();
          t.term.write(bytes, () => {
            t.queuedBytes -= bytes.length;
            // once accepted, always advance appliedSeq (durable state) — Sol review A.1
            t.appliedSeq = frame.seq;
            if (t.attachedEpoch === epoch) this.scheduleAck(t, epoch);
            resolve();
          });
        })
    );

    if (t.sessionId !== this.activeId && t.queuedBytes > MAX_QUEUED_BYTES && t.attachedEpoch !== null) {
      t.streamSuppressed = true;
      this.detachTab(t);
    }
  }

  private scheduleAck(t: Tab, epoch: number) {
    t.pendingAck = true;
    if (t.ackTimer && t.ackEpoch === epoch) return;
    if (t.ackTimer) clearTimeout(t.ackTimer);
    t.ackEpoch = epoch;
    t.ackTimer = setTimeout(() => {
      t.ackTimer = null;
      t.ackEpoch = null;
      if (epoch === this.epoch) this.flushAck(t, epoch);
    }, ACK_INTERVAL);
  }
  private flushAck(t: Tab, epoch: number) {
    if (epoch !== this.epoch || t.attachedEpoch !== epoch) return;
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
    let generationChanged = false;
    for (const s of sessions) {
      seen.add(s.sessionId);
      if (this.locallyClosed.has(s.sessionId)) continue;
      let t = this.tabs.get(s.sessionId);
      if (!t) {
        t = this.createTabShell(s);
        this.tabs.set(s.sessionId, t);
      }
      t.title = s.title;
      t.groupId = s.groupId ?? null;
      t.state = s.state;
      t.exitCode = s.exitCode;
      if (s.cwd) t.cwd = s.cwd;
      // session was restored/relaunched under the same id (new generation) -> reset replay state
      if (s.generation && t.generation !== s.generation) {
        t.generation = s.generation;
        t.appliedSeq = -1;
        t.highestReceivedSeq = -1;
        t.attachGeneration += 1;
        t.attachedEpoch = null;
        t.attachingEpoch = null;
        try { t.term.reset(); } catch {}
        generationChanged = true;
      }
      if (s.sessionId !== this.activeId && s.latestSeq > t.appliedSeq && !t.unread) t.unread = true;
    }
    // remove tabs whose sessions vanished from the server
    for (const id of [...this.tabs.keys()]) {
      if (!seen.has(id)) {
        this.locallyClosed.delete(id);
        this.disposeTab(id);
      }
    }
    for (const id of [...this.locallyClosed]) if (!seen.has(id)) this.locallyClosed.delete(id);

    if (generationChanged) this.reconcileHotSet();

    if (!this.activeId && this.tabs.size) {
      // most-recently-created first (session ids are time-ordered enough for MVP)
      const first = [...this.tabs.values()][this.tabs.size - 1];
      this.setActive(first.sessionId);
    } else {
      this.emit();
    }
  }

  // ---- terminals ----
  private createTabShell(s: SessionSummary): Tab {
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: this.fontSize,
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
      cwd: s.cwd || "",
      groupId: s.groupId ?? null,
      generation: s.generation ?? null,
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
      attachingEpoch: null,
      attachGeneration: 0,
      streamSuppressed: false,
      pendingAck: false,
      ackTimer: null,
      ackEpoch: null,
      resizeTimer: null,
      resizeGeneration: 0,
      unread: false,
      desiredCols: s.cols || 80,
      desiredRows: s.rows || 24,
    };

    term.onData((d) => this.sendData(tab, d));
    term.onBinary((d) => this.sendInputRaw(tab, latin1ToB64(d)));
    return tab;
  }

  private sendInputRaw(t: Tab, dataB64: string) {
    if (this.state !== "ready" || t.attachedEpoch !== this.epoch) return; // never queue input across disconnect
    this.rawSend({ type: "session.input", sessionId: t.sessionId, data: dataB64 });
  }

  // Typed input path: reject inactive tabs, apply latched modifiers, then send.
  private sendData(t: Tab, d: string) {
    if (t.sessionId !== this.activeId) return;
    this.sendInputRaw(t, strToB64(this.consumeModifiers(d)));
  }

  private consumeModifiers(d: string): string {
    if (!d) return d;
    const ctrl = this.ctrlLatch;
    const alt = this.altLatch;
    this.ctrlLatch = false;
    this.altLatch = false;
    if (ctrl && d.length === 1) {
      const code = d.toUpperCase().charCodeAt(0);
      if (code >= 63 && code <= 95) d = String.fromCharCode(code & 0x1f);
    }
    if (alt) d = "\x1b" + d;
    if (ctrl || alt) this.emit();
    return d;
  }

  private clearLatches() {
    if (this.ctrlLatch || this.altLatch) {
      this.ctrlLatch = false;
      this.altLatch = false;
      this.emit();
    }
  }

  getActiveTab(): Tab | null {
    return this.activeId ? this.tabs.get(this.activeId) || null : null;
  }

  // Touch keybar: send a literal control sequence to the active pty (clears any armed modifier).
  pressSpecial(seq: string) {
    const t = this.getActiveTab();
    this.clearLatches();
    if (t) {
      this.sendInputRaw(t, strToB64(seq));
      t.term.focus();
    }
  }

  sendText(text: string) {
    const t = this.getActiveTab();
    if (t) this.sendInputRaw(t, strToB64(text));
  }

  toggleCtrl() {
    this.ctrlLatch = !this.ctrlLatch;
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

  refit(sessionId: string) {
    const t = this.tabs.get(sessionId);
    if (t && t.opened) this.activatePane(t);
  }

  private activatePane(t: Tab) {
    // observe only the visible pane so fit tracks its real size (keyboard, rotation, layout)
    if (this.paneObserver && t.pane) {
      this.paneObserver.disconnect();
      this.paneObserver.observe(t.pane);
    }
    requestAnimationFrame(() => {
      const el = t.pane;
      if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
      try { t.fit.fit(); } catch {}
      this.applyResize(t);
      t.term.focus();
    });
  }

  private applyResize(t: Tab) {
    const cols = clamp(t.term.cols, COLS_MIN, COLS_MAX);
    const rows = clamp(t.term.rows, ROWS_MIN, ROWS_MAX);
    if (cols === t.desiredCols && rows === t.desiredRows) return;
    t.desiredCols = cols;
    t.desiredRows = rows;
    if (t.resizeTimer) clearTimeout(t.resizeTimer);
    const generation = ++t.resizeGeneration;
    const epoch = this.epoch;
    t.resizeTimer = setTimeout(() => {
      t.resizeTimer = null;
      if (generation !== t.resizeGeneration || epoch !== this.epoch || t.attachedEpoch !== epoch) return;
      if (t.desiredCols !== cols || t.desiredRows !== rows) return;
      this.rawSend({ type: "session.resize", sessionId: t.sessionId, cols, rows });
    }, RESIZE_DEBOUNCE);
  }

  private onViewportChange = () => {
    this.scheduleFit();
  };

  // ---- public actions ----
  setActive(sessionId: string) {
    if (this.activeId === sessionId) return;
    const prev = this.getActiveTab();
    prev?.term.blur();
    this.activeId = sessionId;
    this.mru = [sessionId, ...this.mru.filter((id) => id !== sessionId)];
    this.locallyClosed.delete(sessionId);
    const t = this.tabs.get(sessionId);
    if (t) {
      t.unread = false;
      t.streamSuppressed = false;
      if (t.attachedEpoch === null && t.attachingEpoch === null && this.state === "ready") void this.attachTab(t, this.epoch);
      if (t.opened) this.activatePane(t);
    }
    this.reconcileHotSet();
    this.emit();
  }

  async createSession(profile: string, opts: { cwd?: string; title?: string } = {}) {
    const active = this.getActiveTab();
    const cols = active?.desiredCols || 80;
    const rows = active?.desiredRows || 24;
    const res = await this.request({ type: "session.create", profile, cwd: opts.cwd, cols, rows, title: opts.title });
    const sessionId = res.sessionId as string;
    await this.refreshList();
    this.setActive(sessionId);
    return sessionId;
  }

  async killSession(sessionId: string) {
    await this.request({ type: "session.kill", sessionId, mode: "graceful" }).catch(() => {});
    this.closeTab(sessionId);
  }

  async renameSession(sessionId: string, title: string) {
    const res = await this.request({ type: "session.rename", sessionId, title });
    const t = this.tabs.get(sessionId);
    if (t && typeof res.title === "string") t.title = res.title;
    this.emit();
    return res;
  }

  async assignGroup(sessionId: string, groupId: string | null) {
    await this.request({ type: "group.assign", sessionId, groupId });
    const t = this.tabs.get(sessionId);
    if (t) t.groupId = groupId;
    this.emit();
  }

  async createGroup(name: string, color?: string) {
    const res = await this.request({ type: "group.create", name, color });
    if (res.group) {
      this.groups = [...this.groups.filter((g) => g.id !== res.group.id), res.group];
      this.emit();
    }
    return res.group as SessionGroup;
  }

  async deleteGroup(groupId: string) {
    await this.request({ type: "group.delete", groupId }).catch(() => {});
    this.groups = this.groups.filter((g) => g.id !== groupId);
    this.emit();
  }

  // Remove a tab locally (detach + dispose). Does not kill the remote session.
  closeTab(sessionId: string) {
    const t = this.tabs.get(sessionId);
    if (t) this.detachTab(t);
    this.locallyClosed.add(sessionId);
    const wasActive = this.activeId === sessionId;
    this.disposeTab(sessionId);
    if (wasActive) {
      const next = this.mru[0] || (this.tabs.keys().next().value ?? null);
      this.activeId = null;
      if (next) this.setActive(next);
    }
    this.reconcileHotSet();
    this.emit();
  }

  private disposeTab(sessionId: string) {
    const t = this.tabs.get(sessionId);
    if (!t) return;
    if (t.ackTimer) clearTimeout(t.ackTimer);
    if (t.resizeTimer) clearTimeout(t.resizeTimer);
    try { t.term.dispose(); } catch {}
    this.tabs.delete(sessionId);
    this.mru = this.mru.filter((id) => id !== sessionId);
    if (this.activeId === sessionId) this.activeId = null;
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
    cancelAnimationFrame(this.fitRaf);
    this.paneObserver?.disconnect();
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.backgroundCloseTimer) clearTimeout(this.backgroundCloseTimer);
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("connection destroyed"));
      this.pending.delete(id);
    }
    for (const t of this.tabs.values()) {
      if (t.ackTimer) clearTimeout(t.ackTimer);
      if (t.resizeTimer) clearTimeout(t.resizeTimer);
      try { t.term.dispose(); } catch {}
    }
    this.tabs.clear();
    this.listeners.clear();
    window.removeEventListener("online", this.onOnline);
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("pagehide", this.onPageHide);
    window.removeEventListener("resize", this.onViewportChange);
    window.visualViewport?.removeEventListener("resize", this.onViewportChange);
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch {}
  }
}
