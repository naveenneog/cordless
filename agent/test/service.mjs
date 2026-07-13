// Unit tests for the Windows daemon launch command line (WMI breakaway) — pure, no spawning.
// Guards the quoting/redirect construction that lets `cordless start` return under a job object
// (e.g. the Chocolatey shim) instead of hanging.
import { windowsDaemonCommandLine } from "../src/service.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log("FAIL:", m); } };

// SEA build: the exe runs itself as `<exe> start --foreground`.
{
  const exe = "C:\\Program Files\\cordless\\cordless.exe";
  const log = "C:\\Users\\me\\.cordless\\daemon.log";
  const cl = windowsDaemonCommandLine(exe, ["start", "--foreground"], log);
  ok(cl.startsWith("cmd.exe /d /s /c \""), "wrapped in cmd /d /s /c with an opening quote");
  ok(cl.endsWith("2>&1\""), "ends with the redirect + closing quote");
  ok(cl.includes(`"${exe}" "start" "--foreground"`), "exe path + args each quoted");
  ok(cl.includes(`>> "${log}" 2>&1`), "appends stdout+stderr to the quoted log path");
}

// Dev build: `node index.js start --foreground` — both node and the entry script are quoted.
{
  const node = "C:\\Program Files\\nodejs\\node.exe";
  const entry = "C:\\Users\\me\\cordless\\agent\\src\\index.js";
  const cl = windowsDaemonCommandLine(node, [entry, "start", "--foreground"], "C:\\log\\d.log");
  ok(cl.includes(`"${node}" "${entry}" "start" "--foreground"`), "node + entry both quoted");
}

// Quoting safety: embedded quotes in a path are escaped (can't break out of the cmd string).
{
  const cl = windowsDaemonCommandLine('C:\\a"b\\cordless.exe', ["start", "--foreground"], "C:\\l.log");
  ok(cl.includes('"C:\\a\\"b\\cordless.exe"'), "embedded double-quote in exe path is backslash-escaped");
}

console.log(`\n=== SERVICE ${fail === 0 ? "PASS" : "FAIL"} (${pass} ok, ${fail} bad) ===`);
process.exit(fail === 0 ? 0 : 1);
