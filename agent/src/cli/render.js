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

  // Sessions
  const sessions = state.sessions || [];
  push(dim("\u2500\u2500 ") + bold(`Sessions (${sessions.length})`) + dim(" \u2500\u2500"));
  if (!sessions.length) {
    push("  " + dim("no sessions yet \u2014 press n to start a shell, Claude, or Codex"));
  } else {
    sessions.forEach((s, i) => {
      const sel = i === state.selected;
      const icon = profileIcon(s.profile);
      const st = s.state === "running" ? green(s.state || "running") : dim(s.state || "exited");
      const label = `${icon} ${(s.profile || "shell").padEnd(7)} ${truncate(s.title || s.cwd || "", 28).padEnd(28)} ${st}`;
      push((sel ? cyan("\u25b8 ") : "  ") + (sel ? inverse(truncate(label, inner - 2)) : truncate(label, inner - 2)));
    });
  }
  push();

  // Footer
  push(dim("\u2191/\u2193 select \u00b7 enter attach \u00b7 n new \u00b7 p new QR \u00b7 d devices \u00b7 x kill \u00b7 r refresh \u00b7 q quit"));
  if (state.message) push(yellow(truncate(state.message, inner)));

  return lines;
}
