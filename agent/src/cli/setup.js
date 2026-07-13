// `cordless setup` — install the packaged binary to a stable location, add it to PATH, and register
// login autostart, so the user goes from "downloaded cordless.exe" to "cordless works everywhere"
// in one step. This is the logic a clickable installer delegates to (see installer/cordless.nsi).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { installService, uninstallService, stopDaemon, startDaemonDetached, runningPid } from "../service.js";
import { IS_SEA } from "../runtime.js";
import { VERSION } from "../version.js";

// Stable per-user install location (no admin rights needed).
export function defaultInstallDir() {
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "Programs", "cordless");
  }
  return path.join(os.homedir(), ".local", "share", "cordless");
}

// Where we record the current install so a later `cordless setup` can clean up the previous one.
function cordlessHomeDir() {
  return process.env.CORDLESS_HOME || path.join(os.homedir(), ".cordless");
}
function installMarkerFile() {
  return path.join(cordlessHomeDir(), "install.json");
}
export function loadInstallMarker() {
  try {
    return JSON.parse(fs.readFileSync(installMarkerFile(), "utf8"));
  } catch {
    return null;
  }
}
export function saveInstallMarker(dir) {
  try {
    fs.mkdirSync(cordlessHomeDir(), { recursive: true });
    fs.writeFileSync(installMarkerFile(), JSON.stringify({ dir, version: VERSION, installedAt: new Date().toISOString() }, null, 2));
  } catch {
    /* ignore */
  }
}

// The previously-installed dirs that differ from `newDir` and are safe to remove (a cordless install
// dir is always named "cordless"). Pure so it can be unit-tested.
export function oldInstallDirs(marker, newDir) {
  const olds = new Set();
  if (marker && marker.dir) olds.add(marker.dir);
  for (const d of (marker && marker.previousDirs) || []) olds.add(d);
  return [...olds].filter(
    (d) => d && path.resolve(d) !== path.resolve(newDir) && path.basename(d).toLowerCase() === "cordless"
  );
}

// Remove previous cordless installs (their dir + stale User-PATH entry) that aren't the new location.
// Never touches ~/.cordless (config/tokens are kept); only ever deletes a directory named "cordless".
export function cleanupOldInstalls(newDir, { log = () => {} } = {}) {
  const dirs = oldInstallDirs(loadInstallMarker(), newDir);
  for (const old of dirs) {
    removeFromUserPath(old);
    try {
      fs.rmSync(old, { recursive: true, force: true });
      log("  removed old install: " + old);
    } catch {
      /* ignore */
    }
  }
  return dirs;
}

// The PowerShell command that idempotently adds/removes a directory on the *user* PATH and broadcasts
// the change. Returned (not run) so it can be unit-tested.
export function winUserPathScript(dir, { remove = false } = {}) {
  const d = JSON.stringify(dir);
  if (remove) {
    return `$d=${d}; $p=[Environment]::GetEnvironmentVariable('Path','User'); if($p){ $n=(($p -split ';') | Where-Object { $_ -and $_ -ne $d }) -join ';'; [Environment]::SetEnvironmentVariable('Path',$n,'User') }`;
  }
  return `$d=${d}; $p=[Environment]::GetEnvironmentVariable('Path','User'); if(-not $p){$p=''}; if(($p -split ';') -notcontains $d){ [Environment]::SetEnvironmentVariable('Path', ($p.TrimEnd(';')+';'+$d), 'User') }`;
}

function addToUserPath(dir) {
  if (process.platform === "win32") {
    execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", winUserPathScript(dir)], { stdio: "ignore" });
    return dir;
  }
  // Unix: symlink into ~/.local/bin (commonly on PATH).
  const bin = path.join(os.homedir(), ".local", "bin");
  fs.mkdirSync(bin, { recursive: true });
  const link = path.join(bin, "cordless");
  try {
    fs.rmSync(link, { force: true });
  } catch {
    /* ignore */
  }
  fs.symlinkSync(path.join(dir, "cordless"), link);
  return bin;
}

function removeFromUserPath(dir) {
  if (process.platform === "win32") {
    try {
      execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", winUserPathScript(dir, { remove: true })], { stdio: "ignore" });
    } catch {
      /* ignore */
    }
  } else {
    try {
      fs.rmSync(path.join(os.homedir(), ".local", "bin", "cordless"), { force: true });
    } catch {
      /* ignore */
    }
  }
}

// Copy the packaged app (the running exe + its resources/) into destDir. Returns the installed exe path.
export function copyApp(destDir, { exe = process.execPath } = {}) {
  const srcDir = path.dirname(exe);
  const destExe = path.join(destDir, path.basename(exe));
  fs.mkdirSync(destDir, { recursive: true });
  if (path.resolve(exe) !== path.resolve(destExe)) fs.copyFileSync(exe, destExe);
  const srcRes = path.join(srcDir, "resources");
  const destRes = path.join(destDir, "resources");
  if (fs.existsSync(srcRes) && path.resolve(srcRes) !== path.resolve(destRes)) {
    fs.rmSync(destRes, { recursive: true, force: true });
    fs.cpSync(srcRes, destRes, { recursive: true });
  }
  return destExe;
}

export function runSetup(opts = {}) {
  if (opts.uninstall) return runUninstall(opts);

  // --path-only: finalize from the *installed* exe (add PATH + autostart from the installed location).
  if (opts.pathOnly) {
    const dir = opts.dir || path.dirname(process.execPath);
    if (!opts.noPath) {
      const added = addToUserPath(dir);
      console.log("  added to PATH: " + added);
    }
    if (!opts.noAutostart) {
      try {
        installService();
      } catch (e) {
        console.error("  autostart registration failed: " + (e.message || e));
      }
    }
    // Start the daemon now so the user goes straight to a working `cordless` (QR on the dashboard)
    // without waiting for the next login — the whole point of an installer.
    if (!opts.noStart) {
      try {
        const pid = startDaemonDetached();
        if (pid) console.log("  started the cordless daemon (pid " + pid + ")");
      } catch (e) {
        console.error("  could not start the daemon now: " + (e.message || e) + " (it will start at next login)");
      }
    }
    saveInstallMarker(dir); // record this install so a future setup can clean it up
    console.log(`\ncordless ${VERSION} is installed and running. Open a NEW terminal and run:  cordless`);
    console.log(`(that opens the dashboard with a QR to pair your phone.)\n`);
    return;
  }

  // Fresh install from the downloaded binary.
  if (!IS_SEA && !opts.dryRun) {
    console.error("cordless setup installs the packaged binary — run it from the downloaded cordless.exe.");
    process.exit(1);
  }
  const dir = opts.dir || defaultInstallDir();
  console.log(`Installing cordless ${VERSION} -> ${dir}`);

  if (opts.dryRun) {
    console.log("  [dry-run] would copy: " + process.execPath + " (+ resources/)");
    console.log("  [dry-run] would add to PATH: " + (process.platform === "win32" ? dir : path.join(os.homedir(), ".local", "bin")));
    console.log("  [dry-run] would register login autostart: " + (opts.noAutostart ? "no" : "yes"));
    return;
  }

  // Stop any running (possibly older) daemon so files aren't locked and version skew is cleared.
  try {
    stopDaemon();
  } catch {
    /* ignore */
  }
  // Clean up a previous install in a different location (dir + stale PATH entry) before copying.
  try {
    cleanupOldInstalls(dir, { log: console.log });
  } catch {
    /* ignore */
  }
  const destExe = copyApp(dir);
  console.log("  copied binary + resources");

  if (opts.copyOnly) return; // used by tests

  // Finalize from the installed exe so PATH + autostart reference the installed location.
  const args = ["setup", "--path-only", "--dir", dir];
  if (opts.noAutostart) args.push("--no-autostart");
  if (opts.noPath) args.push("--no-path");
  if (opts.noStart) args.push("--no-start");
  execFileSync(destExe, args, { stdio: "inherit" });
}

function runUninstall(opts = {}) {
  const marker = loadInstallMarker();
  const dir = opts.dir || (marker && marker.dir) || defaultInstallDir();
  try {
    stopDaemon();
  } catch {
    /* ignore */
  }
  try {
    uninstallService();
  } catch {
    /* ignore */
  }
  removeFromUserPath(dir);
  console.log("Removed cordless autostart + PATH entry.");
  if (opts.purge) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log("Removed " + dir);
    } catch {
      /* ignore */
    }
  }
  try {
    fs.rmSync(installMarkerFile(), { force: true });
  } catch {
    /* ignore */
  }
  console.log("(Your ~/.cordless config + paired devices are kept.)");
}
