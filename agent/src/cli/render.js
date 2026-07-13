// Pure rendering helpers for the cordless CLI dashboard. Kept side-effect free so a single frame
// can be rendered headlessly (`cordless --once`) and unit-tested.
import qrcode from "qrcode-terminal";

const NO_COLOR = !!process.env.NO_COLOR || process.env.TERM === "dumb";
const wrap = (code, s) => (NO_COLOR ? s : `\x1b[${code}m${s}\x1b[0m`);
export const dim = (s) => wrap("2", s);
export const bold = (s) => wrap("1", s);
export const green = (s) => wrap("32", s);
export const red = (s) => wrap("31", s);
export const yellow = (s) => wrap("33", s);
export const cyan = (s) => wrap("36", s);
export const violet = (s) => wrap("35", s);
export const inverse = (s) => wrap("7", s);

// The QR as an array of text rows (small mode ~ 15 rows / 27 cols for a pairing URL).
export function qrLines(text) {
  let out = "";
  qrcode.generate(text, { small: true }, (s) => {
    out = s;
  });
  return out.replace(/\n+$/, "").split("\n");
}

export function countdown(expiresAt, now = Date.now()) {
  if (!expiresAt) return "";
  const ms = new Date(expiresAt).getTime() - now;
  if (ms <= 0) return "expired";
  const s = Math.floor(ms / 1000);
  return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
}

export function truncate(s, w) {
  s = String(s);
  if (w <= 0) return "";
  return s.length <= w ? s : s.slice(0, Math.max(0, w - 1)) + "\u2026";
}

const profileIcon = (p) => (p === "claude" ? "\u25c6" : p === "codex" ? "\u25c7" : "\u25cf");

// A one-glyph status badge: attention (waiting/bell/finished) takes precedence over activity.
export function attentionGlyph(s) {
  if (s.attention === "prompt") return yellow("!");
  if (s.attention === "bell") return yellow("\u203c"); // ‼
  if (s.attention === "finished") return green("\u2713"); // ✓
  if (s.state === "exited" || s.activity === "exited") return dim("\u00d7"); // ×
  if (s.activity === "idle") return dim("\u25cb"); // ○
  return green("\u25cf"); // ● working
}

// Short status word shown after the title.
export function attentionWord(s) {
  if (s.attention === "prompt") return yellow("waiting");
  if (s.attention === "bell") return yellow("bell");
  if (s.attention === "finished") return green("finished");
  if (s.state === "exited" || s.activity === "exited") return dim("exited" + (s.exitCode != null ? ` (${s.exitCode})` : ""));
  if (s.activity === "idle") return dim("idle");
  return green("working");
}

// Sort key — attention first, then working, idle, exited. Lower sorts earlier.
export function attentionRank(s) {
  if (s.attention === "prompt") return 0;
  if (s.attention === "bell") return 1;
  if (s.attention === "finished") return 2;
  if (s.state === "exited" || s.activity === "exited") return 5;
  if (s.activity === "idle") return 4;
  return 3; // working
}

export function needsAttention(s) {
  return s.attention === "prompt" || s.attention === "bell" || s.attention === "finished";
}

// Group header glyph color by the group's assigned color.
const GROUP_COLOR_FN = { blue: cyan, green, yellow, red, purple: violet, gray: dim };

const FILTERS = ["all", "attention", "claude", "codex", "copilot", "shell"];

function applyFilter(sessions, filter) {
  if (!filter || filter === "all") return sessions;
  if (filter === "attention") return sessions.filter(needsAttention);
  return sessions.filter((s) => (s.profile || "shell") === filter);
}

// Order rows for rendering when tab groups exist: each group (by order) as a header + its members
// (attention-first, then groupOrder), then an "Ungrouped" section. Session rows carry a running
// selIndex so selection lines up with visibleSessions(). With no groups, a flat list of sessions.
export function groupedRows(state) {
  const all = applyFilter(state.allSessions || state.sessions || [], state.filter);
  const groups = (state.groups || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const collapsed = state.collapsed instanceof Set ? state.collapsed : new Set(state.collapsed || []);
  const rows = [];
  let selIndex = 0;
  const memberSort = (a, b) => attentionRank(a) - attentionRank(b) || (a.groupOrder || 0) - (b.groupOrder || 0) || String(a.title || "").localeCompare(String(b.title || ""));
  if (!groups.length) {
    for (const s of all.slice().sort(memberSort)) rows.push({ type: "session", session: s, selIndex: selIndex++ });
    return rows;
  }
  const byGroup = new Map(groups.map((g) => [g.id, []]));
  const ungrouped = [];
  for (const s of all) {
    if (s.groupId && byGroup.has(s.groupId)) byGroup.get(s.groupId).push(s);
    else ungrouped.push(s);
  }
  const emit = (name, color, members, gid) => {
    const attn = members.filter(needsAttention).length;
    const isCollapsed = !!(gid && collapsed.has(gid));
    rows.push({ type: "header", name, color, count: members.length, attn, collapsed: isCollapsed, groupId: gid });
    if (!isCollapsed) for (const s of members.slice().sort(memberSort)) rows.push({ type: "session", session: s, selIndex: selIndex++ });
  };
  for (const g of groups) emit(g.name, g.color, byGroup.get(g.id), g.id);
  if (ungrouped.length) emit("Ungrouped", "gray", ungrouped, null);
  return rows;
}

// The visible, selectable sessions (collapsed groups excluded) in display order. state.selected
// indexes into this list; the dashboard and buildFrame agree on the ordering via this one function.
export function visibleSessions(state) {
  return groupedRows(state).filter((r) => r.type === "session").map((r) => r.session);
}

function filterBar(filter) {
  return dim("view: ") + FILTERS.map((o) => (o === (filter || "all") ? inverse(" " + o + " ") : dim(o))).join(dim(" \u00b7 "));
}

// Build the visible dashboard as an array of plain-width lines (color codes added but not counted
// toward width). The caller clears the screen and prints these.
export function buildFrame(state, cols = 80, rows = 24) {
  const width = Math.max(40, Math.min(cols, 120));
  const inner = width - 4;
  const lines = [];
  const pad = "  ";
  const push = (s = "") => lines.push(pad + s);

  push();
  push(violet(bold(">_<")) + "  " + bold("cordless") + " " + dim(state.daemon?.version || ""));
  push();

  // Status row
  const dot = (okc) => (okc ? green("\u25cf") : red("\u25cf"));
  const ts = state.tailscale;
  const tsLabel = ts && ts.connected ? `Tailscale ${green("\u25cf")} ${ts.host}` : dim("Tailscale \u25cb offline");
  push(`${dim("Daemon")}  ${dot(!!state.daemon?.running)} ${state.daemon?.running ? "running" : "down"}    ${tsLabel}    ${dim("Port")} :${state.port}`);
  push(`${dim("Reach ")}  ${state.reachUrl ? cyan(truncate(state.reachUrl, inner - 9)) : dim("loopback only \u2014 install Tailscale to reach from your phone")}`);
  push();

  // Pair a phone
  const p = state.pairing;
  const expLabel = p && p.expiresAt ? `expires ${countdown(p.expiresAt, state.now)}` : "";
  push(dim("\u2500\u2500 ") + bold("Pair a phone") + dim(" \u2500\u2500") + (p ? "  " + dim(`scan with the cordless app \u00b7 ${expLabel}`) : ""));
  if (state.pairingError) {
    push("  " + red(truncate(state.pairingError, inner - 2)));
  } else if (p && p.preferredUrl) {
    const showQr = rows >= 26 && width >= 44;
    if (showQr) {
      for (const q of qrLines(p.preferredUrl)) push("    " + q);
    } else {
      push("  " + dim("(enlarge the terminal to show the QR, or use the URL below)"));
    }
    push("    " + dim("URL  ") + truncate(p.preferredUrl, inner - 9));
    if (p.code) push("    " + dim("Code ") + p.code);
    if (p.route && p.route.kind === "none") {
      push("    " + yellow("No Tailscale/LAN address found \u2014 the phone can only reach this over a network."));
    }
  } else {
    push("  " + dim("no reachable address \u2014 start Tailscale, then press p"));
  }
  push();

  // Sessions (grouped, attention-first)
  const allS = state.allSessions || state.sessions || [];
  const attnCount = allS.filter(needsAttention).length;
  const hasGroups = !!(state.groups && state.groups.length);
  push(dim("\u2500\u2500 ") + bold(`Sessions (${allS.length})`) + dim(" \u2500\u2500") + (attnCount ? "  " + yellow(`${attnCount} need attention`) : ""));
  if (!allS.length) {
    push("  " + dim("no sessions yet \u2014 press n to start a shell, Claude, Codex, or Copilot"));
  } else {
    if (hasGroups || (state.filter && state.filter !== "all")) push("  " + filterBar(state.filter));
    const rows = groupedRows(state);
    const indent = hasGroups ? "    " : "  ";
    for (const r of rows) {
      if (r.type === "header") {
        const arrow = r.collapsed ? "\u25b6" : "\u25bc"; // ▶ / ▼
        const cfn = GROUP_COLOR_FN[r.color] || dim;
        const meta = (r.attn ? yellow(`${r.attn} waiting`) + dim(" \u00b7 ") : "") + dim(`${r.count} session${r.count === 1 ? "" : "s"}`);
        push("  " + cfn(`${arrow} ${r.name}`) + "  " + meta);
      } else {
        const s = r.session;
        const sel = r.selIndex === state.selected;
        const glyph = attentionGlyph(s);
        const label = `${(s.profile || "shell").padEnd(7)} ${truncate(s.title || s.cwd || "", 26).padEnd(26)} ${attentionWord(s)}`;
        push(indent + (sel ? cyan("\u25b8 ") : "  ") + glyph + " " + (sel ? inverse(truncate(label, inner - 6)) : truncate(label, inner - 6)));
        if (sel && s.lastLine) push(indent + "      " + dim(truncate(s.lastLine, inner - 8)));
      }
    }
  }
  push();

  // Footer
  push(dim("\u2191/\u2193 select \u00b7 enter attach \u00b7 n new \u00b7 e rename \u00b7 g group \u00b7 f view \u00b7 p QR \u00b7 x kill \u00b7 q quit"));
  if (state.message) push(yellow(truncate(state.message, inner)));

  return lines;
}
