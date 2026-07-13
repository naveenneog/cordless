// Structured CLI help for cordless. A single command registry drives both the top-level overview
// (`cordless help`) and per-command detail (`cordless help <cmd>` / `cordless <cmd> --help`), so the
// documentation can never drift from the command list.
import { VERSION } from "../version.js";

// Each command: { name, aliases?, group, summary, usage, details?, options?, examples? }
// `options` is [flag, description] pairs; `usage`/`examples` may be a string or string[].
export const COMMANDS = [
  {
    name: "dashboard",
    invocation: "cordless",
    group: "Dashboard",
    summary: "Open the live dashboard (status + pairing QR + your sessions).",
    usage: ["cordless", "cordless --once"],
    details:
      "Running `cordless` with no command opens the interactive dashboard: daemon status, a pairing QR, " +
      "and every session as a selectable row. Keys: enter attach, o open in a new tab, n new, e rename, " +
      "g group, f filter, k kill, q quit. `--once` prints a single frame and exits (for scripts/screenshots).",
    options: [["--once, -1", "print one dashboard frame and exit (non-interactive)"]],
    examples: ["cordless", "cordless --once"],
  },
  {
    name: "start",
    group: "Daemon",
    summary: "Start the background daemon.",
    usage: "cordless start [--foreground]",
    details:
      "Starts the daemon detached (returns immediately; logs to ~/.cordless/daemon.log). On Windows the " +
      "daemon is launched via WMI so it breaks away from the caller's job object — `cordless start` returns " +
      "cleanly even under a Chocolatey shim or CI wrapper. Use `cordless install` to also start it at login.",
    options: [["--foreground, -f", "run the daemon in this terminal instead of detaching"]],
    examples: ["cordless start", "cordless start --foreground   # run it in the foreground (Ctrl-C to stop)"],
  },
  { name: "stop", group: "Daemon", summary: "Stop the running daemon (and its sessions).", usage: "cordless stop" },
  { name: "status", group: "Daemon", summary: "Show whether the daemon is running, with its PID.", usage: "cordless status" },
  {
    name: "doctor",
    group: "Daemon",
    summary: "Diagnose daemon, Tailscale/LAN reachability, devices, and profiles.",
    usage: "cordless doctor",
    details: "Prints the CLI/daemon versions, the listen endpoint, detected Tailscale + LAN addresses, the number of paired devices, and whether each configured profile's command is on PATH.",
  },
  {
    name: "pair",
    group: "Pairing",
    summary: "Show a single-use QR + code to pair a new device.",
    usage: "cordless pair",
    details: "Prints a QR (and a manual code + PWA URLs) that the cordless phone app scans to pair. The code is single-use and valid for 5 minutes. Needs a Tailscale or LAN address to be reachable from your phone.",
    examples: ["cordless pair"],
  },
  {
    name: "devices",
    group: "Pairing",
    summary: "List paired devices, or revoke one.",
    usage: ["cordless devices", "cordless devices revoke <deviceId>"],
    details: "Lists every paired device with its name, pairing time, and last-seen time. `revoke` invalidates a device's token so it can no longer connect.",
    examples: ["cordless devices", "cordless devices revoke 3f9a1c2b"],
  },
  {
    name: "new",
    group: "Sessions",
    summary: "Start a new session (shell, agent, or a custom profile).",
    usage: "cordless new [profile] [--cwd <dir>] [--title <title>]",
    details: "Creates a new session running the given profile (default: shell). Built-in profiles: shell, claude, codex, copilot. Add your own under \"profiles\" in ~/.cordless/config.json — see `cordless profiles`.",
    options: [
      ["--cwd <dir>", "working directory to launch in (default: your home dir)"],
      ["--title <t>", "set the session's tab title up front"],
    ],
    examples: [
      "cordless new                       # a plain shell",
      "cordless new claude --cwd .        # Claude Code in the current dir",
      "cordless new copilot --title api   # Copilot CLI, titled \"api\"",
    ],
  },
  {
    name: "sessions",
    group: "Sessions",
    summary: "List sessions (id, profile, state, title).",
    usage: "cordless sessions [--attention]",
    options: [["--attention, -a", "only show sessions that are waiting on you (a prompt/bell)"]],
    examples: ["cordless sessions", "cordless sessions -a"],
  },
  {
    name: "attach",
    group: "Sessions",
    summary: "Attach to a session (no id = resume the most recent).",
    usage: ["cordless attach [id]", "cordless attach <id> --new-window"],
    details: "Attaches your terminal to a session's live PTY. Detach without killing it by pressing Ctrl-] then d. With no id, attaches the most-recently-active running session. `--new-window` opens it in a NEW terminal tab/window (Windows Terminal tab, or a new console) and returns here — so a dashboard can keep running while you launch sessions like browser tabs.",
    options: [["--new-window, --tab, -w", "open the session in a new terminal tab/window instead of here"]],
    examples: [
      "cordless attach            # resume the most recent session",
      "cordless attach 3f9a       # attach to a session by id prefix",
      "cordless attach 3f9a -w    # open it in a new terminal tab",
    ],
  },
  {
    name: "resume",
    group: "Sessions",
    summary: "Jump back into your most-recently-active session.",
    usage: "cordless resume",
    details: "Shorthand for `cordless attach` with no id — reattaches the session you were last working in.",
  },
  {
    name: "output",
    group: "Sessions",
    summary: "Print or copy a session's recent output.",
    usage: "cordless output <id> [--lines N] [--copy]",
    options: [
      ["--lines N, -n N", "how many trailing lines to show (default: 50)"],
      ["--copy", "copy the output to the clipboard instead of printing"],
    ],
    examples: ["cordless output 3f9a --lines 200", "cordless output 3f9a --copy"],
  },
  {
    name: "search",
    group: "Sessions",
    summary: "Search a session's retained scrollback.",
    usage: "cordless search <id> <query> [--limit N]",
    options: [["--limit N", "cap the number of matches (default: 200)"]],
    examples: ["cordless search 3f9a error", "cordless search 3f9a \"npm run build\" --limit 20"],
  },
  {
    name: "rename",
    group: "Sessions",
    summary: "Rename a session's tab (empty title resets to default).",
    usage: "cordless rename <id> [new title...]",
    examples: ["cordless rename 3f9a api server", "cordless rename 3f9a        # reset to the default title"],
  },
  { name: "kill", group: "Sessions", summary: "Stop a session.", usage: "cordless kill <id>", examples: ["cordless kill 3f9a"] },
  {
    name: "profiles",
    group: "Organize",
    summary: "List launch profiles (built-ins + your custom ones).",
    usage: ["cordless profiles", "cordless profiles show <name>"],
    details: "Shows every profile `cordless new` can launch and whether its command is available. Define custom profiles under \"profiles\" in ~/.cordless/config.json, e.g. { \"copilot\": { \"command\": \"copilot\", \"attentionPreset\": \"agent\" } }.",
    examples: ["cordless profiles", "cordless profiles show claude"],
  },
  {
    name: "group",
    aliases: ["groups"],
    group: "Organize",
    summary: "Manage session tab groups (Chrome-mobile style).",
    usage: [
      "cordless group [list]",
      "cordless group new <name> [color]",
      "cordless group rename <group> <new name>",
      "cordless group color <group> <color>",
      "cordless group assign <session> <group|none>",
      "cordless group delete <group>",
    ],
    details: "Organize many sessions into colored, collapsible groups — handy once you have more than a handful of tabs. Groups sync to the phone app too.",
    examples: [
      "cordless group new \"api\" blue",
      "cordless group assign 3f9a api",
      "cordless group assign 3f9a none   # ungroup it",
    ],
  },
  {
    name: "workspace",
    aliases: ["ws"],
    group: "Organize",
    summary: "Save or restore a whole session layout (named templates).",
    usage: ["cordless workspace list", "cordless workspace save <name>", "cordless workspace open <name>", "cordless workspace delete <name>"],
    details: "A workspace snapshots the running sessions' profile + cwd + title so you can reopen a whole project layout (e.g. \"Claude on api, Codex on web, a tests shell\") with one command.",
    examples: ["cordless workspace save morning", "cordless workspace open morning"],
  },
  {
    name: "history",
    group: "Organize",
    summary: "Inspect or clear persisted scrollback (survives restart).",
    usage: ["cordless history [status]", "cordless history clear <id>", "cordless history clear --all"],
    options: [["--all", "with `clear`, remove every persisted history file"]],
    examples: ["cordless history", "cordless history clear 3f9a", "cordless history clear --all"],
  },
  {
    name: "notify",
    group: "Notifications",
    summary: "Show or test attention notifications (ntfy / webhook).",
    usage: ["cordless notify [status]", "cordless notify test"],
    details: "Sends a push to your phone when a session needs attention (a prompt, a bell, or a finished agent). Configure it under \"notifications\" in ~/.cordless/config.json, then run `cordless notify test`.",
    examples: ["cordless notify status", "cordless notify test"],
  },
  {
    name: "install",
    group: "Install",
    summary: "Register the daemon to start automatically at login.",
    usage: "cordless install",
    details: "Registers a per-user login item (Task Scheduler on Windows, systemd --user on Linux, launchd on macOS). Never elevates. Run `cordless uninstall` to remove it.",
  },
  {
    name: "setup",
    group: "Install",
    summary: "Install cordless to a stable path (+ PATH + autostart), or remove it.",
    usage: ["cordless setup", "cordless setup --uninstall [--purge]"],
    details: "Run from the downloaded cordless.exe: copies the binary + resources to a stable location, adds it to your PATH, registers login autostart, and starts the daemon so `cordless` works immediately in a new terminal. Cleans up any previous install location first.",
    options: [
      ["--dir <dir>", "install to a specific directory"],
      ["--no-autostart", "don't register login autostart"],
      ["--no-path", "don't modify PATH"],
      ["--no-start", "don't start the daemon after installing"],
      ["--dry-run", "print what it would do without changing anything"],
      ["--uninstall", "remove cordless (add --purge to also drop ~/.cordless)"],
    ],
    examples: ["cordless setup", "cordless setup --uninstall"],
  },
  {
    name: "uninstall",
    group: "Install",
    summary: "Remove the login-autostart registration.",
    usage: "cordless uninstall [--purge]",
    options: [["--purge", "also note the config/token dir (~/.cordless) for manual deletion"]],
  },
  {
    name: "help",
    aliases: ["--help", "-h"],
    group: "Help",
    summary: "Show help, optionally for a specific command.",
    usage: ["cordless help", "cordless help <command>", "cordless <command> --help"],
    examples: ["cordless help", "cordless help attach"],
  },
  { name: "version", aliases: ["--version", "-v"], group: "Help", summary: "Print the cordless version.", usage: "cordless version" },
];

const GROUP_ORDER = ["Dashboard", "Daemon", "Pairing", "Sessions", "Organize", "Notifications", "Install", "Help"];

const asLines = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

// Resolve a command name/alias to its spec (null if unknown).
export function findCommand(name) {
  if (!name) return null;
  const n = String(name).toLowerCase();
  return COMMANDS.find((c) => c.name === n || (c.aliases || []).includes(n)) || null;
}

// The grouped top-level overview.
export function topLevelHelp() {
  const width = Math.max(...COMMANDS.map((c) => (c.invocation || c.name).length));
  const out = [];
  out.push(`cordless v${VERSION} — remote terminal / coding-agent session manager`);
  out.push("");
  out.push("USAGE");
  out.push("  cordless [command] [options]");
  out.push("  cordless                       open the dashboard (status + pairing QR + sessions)");
  out.push("");
  for (const group of GROUP_ORDER) {
    const cmds = COMMANDS.filter((c) => c.group === group);
    if (!cmds.length) continue;
    out.push(group.toUpperCase());
    for (const c of cmds) out.push(`  ${(c.invocation || c.name).padEnd(width + 2)} ${c.summary}`);
    out.push("");
  }
  out.push("Run 'cordless help <command>' (or 'cordless <command> --help') for details and options.");
  out.push("Config + state live in ~/.cordless (override with CORDLESS_HOME).");
  return out.join("\n");
}

// Detailed help for one command.
export function commandHelp(name) {
  const c = findCommand(name);
  if (!c) return null;
  const out = [];
  out.push(`cordless ${c.name === "dashboard" ? "" : c.name}`.trimEnd() + ` — ${c.summary}`);
  out.push("");
  out.push("USAGE");
  for (const u of asLines(c.usage)) out.push("  " + u);
  if (c.details) {
    out.push("");
    for (const para of asLines(c.details)) out.push(wrap(para, 78, "  "));
  }
  if (c.options && c.options.length) {
    out.push("");
    out.push("OPTIONS");
    const w = Math.max(...c.options.map(([f]) => f.length));
    for (const [flag, desc] of c.options) out.push(`  ${flag.padEnd(w + 2)} ${desc}`);
  }
  if (c.examples && c.examples.length) {
    out.push("");
    out.push("EXAMPLES");
    for (const ex of asLines(c.examples)) out.push("  " + ex);
  }
  if (c.aliases && c.aliases.length) {
    out.push("");
    out.push("Aliases: " + c.aliases.join(", "));
  }
  return out.join("\n");
}

// Soft-wrap a paragraph to `width` columns with a fixed indent.
function wrap(text, width, indent = "") {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = indent;
  for (const word of words) {
    if (line.length + word.length + 1 > width && line.trim()) {
      lines.push(line);
      line = indent + word;
    } else {
      line += (line === indent ? "" : " ") + word;
    }
  }
  if (line.trim()) lines.push(line);
  return lines.join("\n");
}
