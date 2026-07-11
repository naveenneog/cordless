// Optional outbound notifications when a session needs attention (waiting / bell / finished / exited).
//
// Self-hosted friendly — cordless owns no cloud. Two providers:
//   - "ntfy":    POST to <url>/<topic> (ntfy.sh or a self-hosted server); the ntfy phone app pushes it.
//   - "webhook": POST a JSON body to a user URL (Slack/Discord/automation/etc.).
//
// Strict anti-spam (per Sol): one notification per attentionRevision, a 60s per-session cooldown, a
// 5-per-minute global burst cap, optional quiet hours, and only on transitions the user opted into.
// Delivery is async with a short timeout and MUST never block the SessionManager or PTY output. The
// topic / webhook URL / token are secrets and are never logged.
const PER_SESSION_COOLDOWN_MS = 60_000;
const GLOBAL_WINDOW_MS = 60_000;
const GLOBAL_MAX = 5;
const TIMEOUT_MS = 4_000;
const DEFAULT_EVENTS = ["prompt", "bell", "finished"];

export class Notifier {
  /** @param {object} cfg config.notifications @param {{fetchImpl?:Function}} deps */
  constructor(cfg = {}, { fetchImpl } = {}) {
    this.cfg = cfg || {};
    this._fetch = fetchImpl || globalThis.fetch;
    this._perSession = new Map(); // sessionId -> { rev, at }
    this._recent = []; // global send timestamps (for the burst cap)
  }

  reconfigure(cfg) {
    this.cfg = cfg || {};
  }

  /** Pure decision: should we send for this session+reason right now? Testable. */
  decide(s, reason, now = Date.now()) {
    const c = this.cfg;
    if (!c.enabled) return { ok: false, why: "disabled" };
    const events = c.events || DEFAULT_EVENTS;
    if (!events.includes(reason)) return { ok: false, why: "event-filtered" };
    const st = this._perSession.get(s.id) || { rev: -1, at: 0 };
    if (st.rev === s.attentionRevision) return { ok: false, why: "same-revision" };
    if (now - st.at < PER_SESSION_COOLDOWN_MS) return { ok: false, why: "cooldown" };
    if (this.inQuietHours(now)) return { ok: false, why: "quiet-hours" };
    if (this._recent.filter((t) => now - t < GLOBAL_WINDOW_MS).length >= GLOBAL_MAX) {
      return { ok: false, why: "burst" };
    }
    return { ok: true };
  }

  /** Notify if allowed. Fire-and-forget friendly; resolves to a small status object. */
  async maybeNotify(s, reason) {
    const now = Date.now();
    const d = this.decide(s, reason, now);
    if (!d.ok) return d;
    // Record before sending so rapid duplicate transitions can't double-fire.
    this._perSession.set(s.id, { rev: s.attentionRevision, at: now });
    this._recent = this._recent.filter((t) => now - t < GLOBAL_WINDOW_MS);
    this._recent.push(now);
    try {
      await this._send(s, reason);
      return { ok: true };
    } catch (e) {
      // Redacted: never echo the topic/url/token.
      console.error(`[notify] delivery failed (${this.cfg.provider}): ${e.message || e}`);
      return { ok: false, why: "send-failed" };
    }
  }

  /** Always send (config validation / `cordless notify test`). */
  sendTest() {
    return this._send({ id: "test", title: "test", profile: "shell", cwd: process.cwd(), attentionConfidence: "explicit" }, "test");
  }

  inQuietHours(now = Date.now()) {
    const q = this.cfg.quietHours;
    if (!q || !q.start || !q.end) return false;
    const d = new Date(now);
    const mins = d.getHours() * 60 + d.getMinutes();
    const [sh, sm] = String(q.start).split(":").map(Number);
    const [eh, em] = String(q.end).split(":").map(Number);
    const start = sh * 60 + sm;
    const end = eh * 60 + em;
    return start <= end ? mins >= start && mins < end : mins >= start || mins < end; // handle overnight
  }

  _title(s) {
    return `cordless \u00b7 ${s.title || s.profile || "session"}`;
  }

  _body(s, reason) {
    const where = s.cwd ? ` in ${s.cwd}` : "";
    const map = {
      prompt: `Waiting for input${where}`,
      bell: `Bell${where}`,
      finished: `Finished${where}`,
      exited: `Exited${where}`,
      test: `Test notification from cordless${where}`,
    };
    let body = map[reason] || `Needs attention${where}`;
    if (this.cfg.includePreview && s.lastLine) body += `\n${s.lastLine}`; // off by default (may leak code/secrets)
    return body;
  }

  async _send(s, reason) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      if (this.cfg.provider === "webhook") {
        if (!this.cfg.webhookUrl) throw new Error("no webhookUrl configured");
        await this._fetch(this.cfg.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            event: "session.attention",
            sessionId: s.id,
            title: s.title,
            profile: s.profile,
            cwd: s.cwd,
            attention: reason,
            confidence: s.attentionConfidence,
            occurredAt: new Date().toISOString(),
          }),
          signal: controller.signal,
        });
      } else {
        if (!this.cfg.topic) throw new Error("no ntfy topic configured");
        const base = (this.cfg.url || "https://ntfy.sh").replace(/\/$/, "");
        const headers = {
          Title: this._title(s),
          Priority: reason === "prompt" || reason === "bell" ? "high" : "default",
          Tags: reason === "finished" ? "white_check_mark" : reason === "bell" ? "bell" : reason === "exited" ? "checkered_flag" : "warning",
        };
        if (this.cfg.token) headers.Authorization = `Bearer ${this.cfg.token}`;
        await this._fetch(`${base}/${encodeURIComponent(this.cfg.topic)}`, {
          method: "POST",
          headers,
          body: this._body(s, reason),
          signal: controller.signal,
        });
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
