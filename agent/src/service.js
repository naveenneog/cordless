// OS autostart registration + single-instance lock for cordless.
// Runs as the normal user (never elevated). Login-scoped: Task Scheduler / systemd --user / launchd.
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { HOME, ensureHome } from "./state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(__dirname, "index.js");
const NODE = process.execPath;
const PIDFILE = path.join(HOME, "daemon.pid");
const LOG = path.join(HOME, "daemon.log");

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
export function startDaemonDetached() {
  const existing = runningPid();
  if (existing) return existing;
  ensureHome();
  const isSea = !fs.existsSync(ENTRY);
  const argv = isSea ? ["start", "--foreground"] : [ENTRY, "start", "--foreground"];
  const outFd = fs.openSync(LOG, "a");
  const child = spawn(NODE, argv, { detached: true, stdio: ["ignore", outFd, outFd], windowsHide: true });
  child.unref();
  return child.pid;
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
  fs.writeFileSync(cmdFile, `@echo off\r\n"${NODE}" "${ENTRY}" start --foreground >> "${LOG}" 2>&1\r\n`);
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
  const unit = `[Unit]
Description=cordless agent daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${NODE} ${ENTRY} start --foreground
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
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.naveenneog.cordless</string>
  <key>ProgramArguments</key>
  <array><string>${NODE}</string><string>${ENTRY}</string><string>start</string><string>--foreground</string></array>
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
