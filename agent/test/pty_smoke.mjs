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

let done = false;
function finish(pass, why) {
  if (done) return;
  done = true;
  console.log("captured bytes:", out.length);
  console.log("tail:", JSON.stringify(out.slice(-160)));
  console.log(pass ? "RESULT: PASS" : `RESULT: FAIL (${why})`);
  try { p.kill(); } catch {}
  process.exit(pass ? 0 : 1);
}

const shellReady = () => /PS .*>/.test(out) || /[$#%>❯]\s*$/.test(out);

// Wait for the shell to be ready before typing (slow PowerShell startup drops early input),
// then poll for the echoed marker instead of firing writes at fixed times.
const started = Date.now();
let echoed = false;
const tick = setInterval(() => {
  if (done) { clearInterval(tick); return; }
  if (out.includes("PTY_OK")) { clearInterval(tick); finish(true); return; }
  if (Date.now() - started > 15000) { clearInterval(tick); console.log("timeout"); finish(false, "timeout"); return; }
  if (!echoed && shellReady()) {
    echoed = true;
    p.write("echo PTY_OK\r");
  } else if (echoed && Date.now() - started > 8000) {
    p.write("echo PTY_OK\r"); // resend once if the first was eaten during startup
  }
}, 300);
