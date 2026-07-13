// Unit tests for opening a session in a new terminal tab/window (pure command building, no spawns).
import { selfCmd, newTerminalCommand, openInNewTerminal } from "../src/cli/openterm.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m); } };

// selfCmd — relaunch cordless with the given args
const [bin, sargs] = selfCmd(["attach", "abc123"]);
ok(typeof bin === "string" && bin.length > 0, "selfCmd returns a bin");
ok(Array.isArray(sargs) && sargs.includes("attach") && sargs.includes("abc123"), "selfCmd carries the cordless args");

// newTerminalCommand — platform-aware; may be null on a headless box (graceful fallback)
const cmd = newTerminalCommand(["attach", "abc123"], { title: "my session" });
if (cmd) {
  ok(typeof cmd.bin === "string" && Array.isArray(cmd.argv), "newTerminalCommand returns { bin, argv }");
  ok(cmd.argv.includes("abc123"), "the new-terminal argv includes the session id");
  if (process.platform === "win32") {
    ok(cmd.method === "wt" || cmd.method === "start", "windows uses wt or the start fallback");
    if (cmd.method === "wt") ok(cmd.argv.includes("--title") && cmd.argv.some((a) => a.includes("my session")), "wt sets the tab title");
    if (cmd.method === "start") ok(cmd.argv[0] === "/c" && cmd.argv[1] === "start", "start fallback uses cmd /c start");
  }
  const r = openInNewTerminal(["attach", "abc123"], { dryRun: true });
  ok(r.ok && Array.isArray(r.argv) && r.argv.includes("abc123"), "openInNewTerminal(dryRun) returns the command");
} else {
  // headless platform (no terminal emulator) — must fail gracefully, never throw
  const r = openInNewTerminal(["attach", "abc123"], { dryRun: true });
  ok(!r.ok && typeof r.error === "string", "no-terminal platform returns a graceful { ok:false, error }");
}

console.log(fail === 0 ? "=== OPENTERM PASS ===" : "=== OPENTERM FAIL ===");
process.exit(fail === 0 ? 0 : 1);
