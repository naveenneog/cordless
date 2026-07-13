// OS autostart registration + single-instance lock for cordless.
// Runs as the normal user (never elevated). Login-scoped: Task Scheduler / systemd --user / launchd.
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { HOME, ensureHome } from "./state.js";
import { IS_SEA } from "./runtime.js";

const __dirname = IS_SEA ? path.dirname(process.execPath) : path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(__dirname, "index.js");
const NODE = process.execPath;
const PIDFILE = path.join(HOME, "daemon.pid");
const LOG = path.join(HOME, "daemon.log");

// How to launch the foreground daemon: a packaged exe runs itself; dev runs `node index.js`.
function daemonCmd() {
  return IS_SEA ? [NODE, ["start", "--foreground"]] : [NODE, [ENTRY, "start", "--foreground"]];
}

// ---- single-instance lock ----
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists but owned by another user
  }
}
export function readPid() {
  try {
    const n = parseInt(fs.readFileSync(PIDFILE, "utf8").trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
export function runningPid() {
  const pid = readPid();
  return pid && processAlive(pid) ? pid : null;
}
export function writePid() {
  ensureHome();
  fs.writeFileSync(PIDFILE, String(process.pid));
  const cleanup = () => {
    try {
      if (readPid() === process.pid) fs.unlinkSync(PIDFILE);
    } catch {
      /* ignore */
    }
  };
  process.on("exit", cleanup);
}

// Start the daemon as a detached background process (survives this CLI exiting). Returns its pid,
// or the pid of the already-running daemon. In a SEA build the entry is the exe itself
// (`cordless start --foreground`); in dev it is `node index.js start --foreground`.
//
// On Windows we launch via WMI (Win32_Process.Create) so the daemon is parented to WmiPrvSE and is
// therefore NOT a member of the caller's job object. Chocolatey's shim (shimgen) — and CI /
// package-manager wrappers — wait on their job object, so a normal detached child would keep
// `cordless start` blocked until the daemon exits. Breaking away from the job lets the launcher
// return immediately while the daemon keeps running. (Confirmed with Sol.)
export function startDaemonDetached() {
  const existing = runningPid();
  if (existing) return existing;
  ensureHome();
  if (process.platform === "win32") {
    try {
      const pid = startDaemonWindowsBreakaway();
      if (pid) return pid;
    } catch {
      /* fall back to plain spawn below */
    }
  }
  const [bin, argv] = daemonCmd();
  const outFd = fs.openSync(LOG, "a");
  const child = spawn(bin, argv, { detached: true, stdio: ["ignore", outFd, outFd], windowsHide: true });
  child.unref();
  return child.pid;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function quoteWin(s) {
  return `"${String(s).replace(/"/g, '\\"')}"`;
}

// Build the WMI Win32_Process.Create command line that launches the foreground daemon and appends
// its stdout/stderr to the log. Wrapped in `cmd /d /s /c "<...>"` so the redirect works and the inner
// command is kept verbatim (cmd strips only the outermost quotes). Pure/exported for testing.
export function windowsDaemonCommandLine(bin, argv, logPath) {
  const inner = [bin, ...argv].map(quoteWin).join(" ");
  return `cmd.exe /d /s /c "${inner} >> ${quoteWin(logPath)} 2>&1"`;
}

// Launch the daemon on Windows outside the caller's job object via WMI. Returns the daemon's real
// pid (read from the pidfile once it starts) or null if the launch failed / didn't come up.
function startDaemonWindowsBreakaway() {
  const [bin, argv] = daemonCmd();
  const commandLine = windowsDaemonCommandLine(bin, argv, LOG);
  // Pass the command line + working dir via env to avoid nested-quote hell inside -Command.
  const ps =
    "$ErrorActionPreference='Stop';" +
    "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:CORDLESS_DCMD; CurrentDirectory = $env:CORDLESS_DCWD };" +
    "if ($null -eq $r -or $r.ReturnValue -ne 0) { exit 1 };" +
    "[Console]::Out.Write($r.ProcessId)";
  const res = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, CORDLESS_DCMD: commandLine, CORDLESS_DCWD: os.homedir() },
  });
  if (res.status !== 0) return null;
  // Win32_Process.Create returns cmd.exe's pid; wait for the daemon to write its own pidfile.
  for (let i = 0; i < 60; i++) {
    const pid = runningPid();
    if (pid) return pid;
    sleepSync(100);
  }
  return runningPid();
}

// ---- commands ----
export function status() {
  const pid = runningPid();
  if (pid) console.log(`cordless is running (pid ${pid}).`);
  else console.log("cordless is not running.");
  return pid;
}

export function stopDaemon() {
  const pid = runningPid();
  if (!pid) {
    console.log("cordless is not running.");
    return;
  }
  try {
    process.kill(pid);
    console.log(`stopped cordless (pid ${pid}).`);
  } catch (e) {
    console.error(`could not stop pid ${pid}: ${e.message}`);
  }
}

export function installService() {
  ensureHome();
  if (process.platform === "win32") return installWindows();
  if (process.platform === "darwin") return installMac();
  return installLinux();
}

export function uninstallService() {
  if (process.platform === "win32") return uninstallWindows();
  if (process.platform === "darwin") return uninstallMac();
  return uninstallLinux();
}

// ---- Windows: Task Scheduler (ONLOGON), launched windowless via WSH ----
function installWindows() {
  const cmdFile = path.join(HOME, "cordless-run.cmd");
  const vbsFile = path.join(HOME, "cordless-launch.vbs");
  const [bin, argv] = daemonCmd();
  const cmdline = [bin, ...argv].map((a) => `"${a}"`).join(" ");
  fs.writeFileSync(cmdFile, `@echo off\r\n${cmdline} >> "${LOG}" 2>&1\r\n`);
  // Run the .cmd fully hidden (window style 0) so nothing flashes at logon.
  fs.writeFileSync(vbsFile, `CreateObject("Wscript.Shell").Run """${cmdFile}""", 0, False\r\n`);
  execFileSync(
    "schtasks",
    [
      "/Create",
      "/TN", "cordless",
      "/TR", `wscript.exe "${vbsFile}"`,
      "/SC", "ONLOGON",
      "/RL", "LIMITED",
      "/F",
    ],
    { stdio: "inherit" }
  );
  console.log("Registered scheduled task 'cordless' (starts hidden at logon).");
  console.log("  start now:  schtasks /Run /TN cordless    (or: cordless start)");
  console.log(`  logs:       ${LOG}`);
}

function uninstallWindows() {
  try {
    execFileSync("schtasks", ["/Delete", "/TN", "cordless", "/F"], { stdio: "inherit" });
  } catch {
    /* not registered */
  }
  for (const f of ["cordless-run.cmd", "cordless-launch.vbs"]) {
    try {
      fs.unlinkSync(path.join(HOME, f));
    } catch {
      /* ignore */
    }
  }
  console.log("Removed scheduled task 'cordless'.");
}

// ---- Linux: systemd --user ----
function installLinux() {
  const dir = path.join(os.homedir(), ".config", "systemd", "user");
  fs.mkdirSync(dir, { recursive: true });
  const [bin, argv] = daemonCmd();
  const unit = `[Unit]
Description=cordless agent daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${[bin, ...argv].join(" ")}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
  fs.writeFileSync(path.join(dir, "cordless.service"), unit);
  try {
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
    execFileSync("systemctl", ["--user", "enable", "--now", "cordless"], { stdio: "inherit" });
    try {
      execFileSync("loginctl", ["enable-linger", os.userInfo().username], { stdio: "inherit" });
    } catch {
      console.log("  (could not enable linger; run: loginctl enable-linger $USER  to keep it running after logout)");
    }
    console.log("Enabled systemd --user service 'cordless'.  logs: journalctl --user -u cordless -f");
  } catch (e) {
    console.error("systemctl failed:", e.message);
    console.log("Unit written to ~/.config/systemd/user/cordless.service — enable it manually.");
  }
}

function uninstallLinux() {
  try {
    execFileSync("systemctl", ["--user", "disable", "--now", "cordless"], { stdio: "inherit" });
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(path.join(os.homedir(), ".config", "systemd", "user", "cordless.service"));
  } catch {
    /* ignore */
  }
  console.log("Removed systemd --user service 'cordless'.");
}

// ---- macOS: launchd LaunchAgent ----
function macPlistPath() {
  return path.join(os.homedir(), "Library", "LaunchAgents", "com.naveenneog.cordless.plist");
}
function installMac() {
  const [bin, argv] = daemonCmd();
  const progArgs = [bin, ...argv].map((a) => `<string>${a}</string>`).join("");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.naveenneog.cordless</string>
  <key>ProgramArguments</key>
  <array>${progArgs}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict>
</plist>
`;
  const p = macPlistPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, plist);
  try {
    execFileSync("launchctl", ["unload", p], { stdio: "ignore" });
  } catch {
    /* not loaded */
  }
  execFileSync("launchctl", ["load", "-w", p], { stdio: "inherit" });
  console.log(`Loaded launchd agent 'com.naveenneog.cordless'.  logs: ${LOG}`);
}

function uninstallMac() {
  const p = macPlistPath();
  try {
    execFileSync("launchctl", ["unload", "-w", p], { stdio: "inherit" });
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
  console.log("Removed launchd agent 'com.naveenneog.cordless'.");
}
