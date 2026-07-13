// Open a cordless subcommand (e.g. `attach <id>`) in a NEW terminal tab/window, so the dashboard
// keeps running in its own tab and you can launch / resume more sessions — like browser tabs.
// Prefers Windows Terminal tabs; falls back to a new console window (Windows) or a terminal emulator
// (macOS/Linux).
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { IS_SEA } from "../runtime.js";

const CLI_DIR = IS_SEA ? path.dirname(process.execPath) : path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(CLI_DIR, "..", "index.js"); // src/cli/openterm.js -> src/index.js (dev only)
const NODE = process.execPath;

// How to relaunch cordless with `args`: a packaged exe runs itself; dev runs `node src/index.js`.
export function selfCmd(args) {
  return IS_SEA ? [NODE, [...args]] : [NODE, [ENTRY, ...args]];
}

function onPath(cmd) {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Build the { bin, argv, method } that opens `cordlessArgs` in a new terminal tab/window, or null if
// we don't know how on this platform. Pure (no spawning) so it's unit-testable.
export function newTerminalCommand(cordlessArgs, { title = "cordless" } = {}) {
  const [bin, base] = selfCmd(cordlessArgs);
  // A session title is user-controlled (rename); strip anything that could break wt/start/shell arg
  // parsing before using it as a window/tab title.
  const safeTitle = ("cordless: " + String(title)).replace(/[;"'`\\\r\n\t|&<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  if (process.platform === "win32") {
    // Windows Terminal → a real new TAB in the current window (-w 0 = the most-recently-used window).
    if (onPath("wt.exe") || onPath("wt")) {
      return { bin: "wt.exe", argv: ["-w", "0", "new-tab", "--title", safeTitle, bin, ...base], method: "wt" };
    }
    // Fallback: a new console window. `cmd /c start "" <bin> <args>` (empty title is the safe form).
    return { bin: "cmd.exe", argv: ["/c", "start", "", bin, ...base], method: "start" };
  }
  if (process.platform === "darwin") {
    const line = [bin, ...base].map((a) => `'${String(a).replace(/'/g, "'\\''")}'`).join(" ");
    return {
      bin: "osascript",
      argv: ["-e", `tell application "Terminal" to do script "${line.replace(/"/g, '\\"')}"`, "-e", 'tell application "Terminal" to activate'],
      method: "Terminal.app",
    };
  }
  // Linux: try common terminal emulators in order.
  for (const [emu, flag] of [["x-terminal-emulator", "-e"], ["gnome-terminal", "--"], ["konsole", "-e"], ["xterm", "-e"]]) {
    if (onPath(emu)) return { bin: emu, argv: [flag, bin, ...base], method: emu };
  }
  return null;
}

// Spawn a new terminal tab/window running `cordless <cordlessArgs>`. Returns { ok, method } or
// { ok:false, error }. With { dryRun } it returns the command without spawning (for tests).
export function openInNewTerminal(cordlessArgs, { title = "cordless", dryRun = false } = {}) {
  const cmd = newTerminalCommand(cordlessArgs, { title });
  if (!cmd) return { ok: false, error: "no known terminal on this platform — attach in place instead" };
  if (dryRun) return { ok: true, method: cmd.method, bin: cmd.bin, argv: cmd.argv };
  try {
    const child = spawn(cmd.bin, cmd.argv, { detached: true, stdio: "ignore", windowsHide: false });
    child.on("error", () => {});
    child.unref();
    return { ok: true, method: cmd.method };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
