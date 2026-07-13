// `cordless setup` — install the packaged binary to a stable location, add it to PATH, and register
// login autostart, so the user goes from "downloaded cordless.exe" to "cordless works everywhere"
// in one step. This is the logic a clickable installer delegates to (see installer/cordless.nsi).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { installService, uninstallService, stopDaemon } from "../service.js";
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
    console.log(`\ncordless ${VERSION} is installed. Open a NEW terminal and run:  cordless\n`);
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
  const destExe = copyApp(dir);
  console.log("  copied binary + resources");

  if (opts.copyOnly) return; // used by tests

  // Finalize from the installed exe so PATH + autostart reference the installed location.
  const args = ["setup", "--path-only", "--dir", dir];
  if (opts.noAutostart) args.push("--no-autostart");
  if (opts.noPath) args.push("--no-path");
  execFileSync(destExe, args, { stdio: "inherit" });
}

function runUninstall(opts = {}) {
  const dir = opts.dir || defaultInstallDir();
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
  console.log("(Your ~/.cordless config + paired devices are kept.)");
}
