// Smoke test: does node-pty spawn a working PTY on this Node/OS?
import os from "node:os";
import pty from "node-pty";

const shell = os.platform() === "win32" ? "powershell.exe" : (process.env.SHELL || "bash");
console.log("platform:", os.platform(), "node:", process.version, "shell:", shell);

const p = pty.spawn(shell, [], {
  name: "xterm-color",
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: process.env,
});

let out = "";
p.onData((d) => { out += d; });
p.onExit(({ exitCode }) => {
  console.log("=== PTY exited, code:", exitCode, "===");
  console.log("captured bytes:", out.length);
  console.log("tail:", JSON.stringify(out.slice(-160)));
  console.log(out.includes("PTY_OK") ? "RESULT: PASS" : "RESULT: FAIL (marker not found)");
  process.exit(out.includes("PTY_OK") ? 0 : 1);
});

// Write a command that echoes a marker, then exit.
setTimeout(() => p.write("echo PTY_OK\r"), 800);
setTimeout(() => p.write("exit\r"), 1600);
setTimeout(() => { console.log("timeout"); p.kill(); }, 6000);
