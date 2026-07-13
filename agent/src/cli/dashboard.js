// The `cordless` dashboard: a full-screen TUI that is a thin client of the persistent daemon.
// Leaving the dashboard (q / Ctrl-C) never stops the daemon, PTYs, or phone connections.
import { DaemonClient, ensureDaemon, daemonBaseUrl } from "./client.js";
import { buildFrame, dim, bold, cyan, inverse, red, green, truncate, attentionRank } from "./render.js";
import { attachSession } from "./attach.js";
import { loadDevices, revokeDevice } from "../state.js";
import { VERSION } from "../version.js";

const ALT_ON = "\x1b[?1049h";
const ALT_OFF = "\x1b[?1049l";
const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";

function deriveReach(pairing) {
  if (!pairing || !pairing.preferredUrl) return { reachUrl: null, tailscale: null };
  const reachUrl = pairing.preferredUrl.split("/#pair=")[0];
  const host = pairing.route && pairing.route.host ? pairing.route.host : null;
  const tailscale = pairing.route && pairing.route.kind === "tailscale" ? { connected: true, host } : null;
  return { reachUrl, tailscale };
}

export async function runDashboard({ once = false } = {}) {
  const { health, stale } = await ensureDaemon();
  if (stale) {
    console.error(
      "cordless: an older cordless daemon is already running on this port and couldn't be replaced.\n" +
        "  Run 'cordless stop' (or reboot), then reopen cordless."
    );
    process.exit(1);
  }
  if (!health) {
    console.error("cordless: could not reach or start the daemon (see ~/.cordless/daemon.log).");
    process.exit(1);
  }
  const client = new DaemonClient();
  await client.connect();

  let port = "7443";
  try {
    port = new URL(daemonBaseUrl()).port || "7443";
  } catch {
    /* keep default */
  }

  const state = {
    daemon: { running: true, version: health.version || VERSION },
    port,
    tailscale: null,
    reachUrl: null,
    pairing: null,
    pairingError: null,
    sessions: [],
    selected: 0,
    message: null,
    now: Date.now(),
    interactive: false, // true once the alternate screen is up (guards live re-renders)
  };

  // Live attention/activity updates: merge into the matching session and repaint (interactive only).
  client.on("session.activity", (m) => {
    const s = state.sessions.find((x) => x.sessionId === m.sessionId);
    if (!s) return;
    s.activity = m.activity;
    s.attention = m.attention;
    s.attentionSince = m.attentionSince;
    s.attentionConfidence = m.attentionConfidence;
    s.attentionRevision = m.attentionRevision;
    if (state.interactive) {
      applySort();
      render();
    }
  });

  async function refreshSessions() {
    try {
      state.sessions = await client.listSessions();
    } catch {
      state.sessions = [];
    }
    applySort();
    if (state.selected >= state.sessions.length) state.selected = Math.max(0, state.sessions.length - 1);
  }

  // Sort attention-first (waiting > bell > finished > working > idle > exited), keeping the
  // currently-selected session selected across the reorder.
  function applySort() {
    const selId = state.sessions[state.selected] && state.sessions[state.selected].sessionId;
    state.sessions.sort((a, b) => attentionRank(a) - attentionRank(b));
    if (selId) {
      const i = state.sessions.findIndex((s) => s.sessionId === selId);
      if (i >= 0) state.selected = i;
    }
  }
  async function newPairing() {
    try {
      const r = await client.pairingCreate({ allowLan: true });
      if (r.ok) {
        state.pairing = r;
        state.pairingError = null;
        const d = deriveReach(r);
        state.reachUrl = d.reachUrl;
        state.tailscale = d.tailscale;
      } else {
        state.pairing = null;
        state.pairingError = r.error && r.error.message ? r.error.message : "pairing failed";
      }
    } catch (e) {
      state.pairingError = e.message;
    }
  }

  await refreshSessions();
  await newPairing();

  // ---- one-shot (headless-friendly) ----
  if (once) {
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 40;
    process.stdout.write(buildFrame(state, cols, rows).join("\n") + "\n");
    if (state.pairing && state.pairing.pairingId) {
      try {
        await client.pairingCancel(state.pairing.pairingId);
      } catch {
        /* ignore */
      }
    }
    client.close();
    return;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("cordless: the dashboard needs an interactive terminal. Try `cordless --once` or `cordless status`.");
    client.close();
    process.exit(1);
  }

  // ---- interactive ----
  const stdout = process.stdout;
  const stdin = process.stdin;
  let mode = "dash"; // "dash" | "devices"
  let pending = null; // "new" | "kill"
  let devices = [];
  let devSel = 0;
  let alive = true;
  let refreshTimer = null;
  let ticks = 0;

  function devicesFrame() {
    const lines = ["", "  " + bold("Paired devices") + dim("  (\u2191/\u2193 select \u00b7 x revoke \u00b7 esc back)"), ""];
    if (!devices.length) lines.push("  " + dim("no paired devices"));
    devices.forEach((d, i) => {
      const sel = i === devSel;
      const label = `${(d.deviceName || "device").padEnd(22)} ${dim(d.deviceId.slice(0, 8))}  paired ${dim((d.createdAt || "").slice(0, 10))}${d.revokedAt ? "  " + red("[revoked]") : ""}`;
      lines.push((sel ? cyan("\u25b8 ") : "  ") + (sel ? inverse(truncate(label, 70)) : truncate(label, 70)));
    });
    lines.push("");
    if (state.message) lines.push("  " + state.message);
    return lines;
  }

  function render() {
    const cols = stdout.columns || 80;
    const rows = stdout.rows || 40;
    state.now = Date.now();
    const lines = mode === "devices" ? devicesFrame() : buildFrame(state, cols, rows);
    let outStr = "\x1b[H";
    for (const ln of lines) outStr += ln + "\x1b[K\n";
    outStr += "\x1b[J";
    stdout.write(outStr);
  }

  function enter() {
    stdout.write(ALT_ON + CURSOR_HIDE);
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onKey);
    stdout.on("resize", render);
    state.interactive = true;
    render();
  }
  function leave() {
    state.interactive = false;
    stdin.removeListener("data", onKey);
    stdout.removeListener("resize", render);
    try {
      if (stdin.isTTY) stdin.setRawMode(false);
    } catch {
      /* ignore */
    }
    stdout.write(CURSOR_SHOW + ALT_OFF);
  }
  function quit(code = 0) {
    if (!alive) return;
    alive = false;
    if (refreshTimer) clearInterval(refreshTimer);
    if (state.pairing && state.pairing.pairingId) {
      try {
        client.pairingCancel(state.pairing.pairingId);
      } catch {
        /* ignore */
      }
    }
    leave();
    try {
      client.close();
    } catch {
      /* ignore */
    }
    process.exit(code);
  }

  async function doAttach() {
    const s = state.sessions[state.selected];
    if (!s) return;
    leave();
    try {
      await attachSession(s.sessionId);
    } catch (e) {
      state.message = "attach failed: " + e.message;
    }
    await refreshSessions();
    if (alive) enter();
  }

  async function onKey(buf) {
    const s = buf.toString("utf8");

    // devices sub-view
    if (mode === "devices") {
      if (s === "\x1b" || s === "d" || s === "q") {
        mode = "dash";
        state.message = null;
      } else if (s === "\x1b[A" || s === "k") {
        devSel = Math.max(0, devSel - 1);
      } else if (s === "\x1b[B" || s === "j") {
        devSel = Math.min(devices.length - 1, devSel + 1);
      } else if (s === "x" || s === "r") {
        const d = devices[devSel];
        if (d && !d.revokedAt) {
          revokeDevice(d.deviceId);
          devices = loadDevices();
          state.message = "revoked " + (d.deviceName || d.deviceId.slice(0, 8));
        }
      } else if (s === "\x03") {
        quit(0);
        return;
      }
      render();
      return;
    }

    // profile picker after 'n'
    if (pending === "new") {
      pending = null;
      const profs = state.newProfiles || [];
      const idx = /^[1-9]$/.test(s) ? parseInt(s, 10) - 1 : -1;
      const profile = idx >= 0 ? profs[idx] : null;
      if (profile && profile.available) {
        try {
          await client.createSession(profile.name, {});
          await refreshSessions();
          state.selected = state.sessions.length - 1;
          state.message = "started " + profile.name;
        } catch (e) {
          state.message = "create failed: " + e.message;
        }
      } else if (profile && !profile.available) {
        state.message = `${profile.name} unavailable: ${profile.reason || "not found on PATH"}`;
      } else {
        state.message = null;
      }
      render();
      return;
    }
    // kill confirm after 'x'
    if (pending === "kill") {
      pending = null;
      if (s === "y" || s === "Y") {
        const sess = state.sessions[state.selected];
        if (sess) {
          try {
            await client.killSession(sess.sessionId, "graceful");
            state.message = "killed " + (sess.profile || "session");
          } catch (e) {
            state.message = "kill failed: " + e.message;
          }
          await refreshSessions();
        }
      } else {
        state.message = null;
      }
      render();
      return;
    }

    switch (s) {
      case "q":
      case "\x03":
        quit(0);
        return;
      case "\x1b[A":
      case "k":
        state.selected = Math.max(0, state.selected - 1);
        break;
      case "\x1b[B":
      case "j":
        state.selected = Math.min(state.sessions.length - 1, state.selected + 1);
        break;
      case "\r":
      case "\n":
      case "o":
        if (state.sessions.length) {
          await doAttach();
          return;
        }
        break;
      case "p":
        state.message = "generating a fresh pairing code\u2026";
        render();
        if (state.pairing && state.pairing.pairingId) {
          try {
            await client.pairingCancel(state.pairing.pairingId);
          } catch {
            /* ignore */
          }
        }
        await newPairing();
        state.message = null;
        break;
      case "r":
        await refreshSessions();
        state.message = "refreshed";
        break;
      case "c": {
        // Mark the selected session's attention (waiting/bell/finished) as handled.
        const sess = state.sessions[state.selected];
        if (sess && sess.attention) {
          try {
            await client._rpc("session.attention.clear", { sessionId: sess.sessionId, revision: sess.attentionRevision });
          } catch {
            /* ignore */
          }
          sess.attention = null;
          sess.attentionConfidence = null;
          applySort();
          state.message = "marked handled";
        }
        break;
      }
      case "n": {
        let profs = [];
        try {
          profs = await client.profiles();
        } catch {
          /* fall back to built-ins below */
        }
        if (!profs.length) profs = [{ name: "shell", available: true }, { name: "claude", available: true }, { name: "codex", available: true }];
        state.newProfiles = profs;
        pending = "new";
        const menu = profs.slice(0, 9).map((p, i) => `${i + 1}=${p.name}${p.available ? "" : dim("(n/a)")}`).join(" \u00b7 ");
        state.message = "new: " + menu + " \u00b7 (other cancels)";
        break;
      }
      case "x":
        if (state.sessions[state.selected]) {
          pending = "kill";
          state.message = `kill ${state.sessions[state.selected].profile || "session"}? press y to confirm`;
        }
        break;
      case "d":
        devices = loadDevices();
        devSel = 0;
        mode = "devices";
        state.message = null;
        break;
      default:
        break;
    }
    render();
  }

  process.on("SIGINT", () => quit(0));
  process.on("uncaughtException", (e) => {
    try {
      leave();
    } catch {
      /* ignore */
    }
    console.error(e);
    process.exit(1);
  });

  enter();
  refreshTimer = setInterval(async () => {
    // Do nothing while attached to a session (state.interactive is false between leave() and enter()),
    // otherwise the dashboard would repaint over the attached PTY.
    if (!alive || !state.interactive) return;
    if (mode !== "dash") {
      render(); // devices view: keep it repainting
      return;
    }
    ticks++;
    // auto-refresh the session list every ~4s
    if (ticks % 4 === 0) await refreshSessions();
    // auto-regenerate an expired pairing code
    if (state.pairing && state.pairing.expiresAt && new Date(state.pairing.expiresAt).getTime() <= Date.now()) {
      await newPairing();
    }
    render();
  }, 1000);
}
