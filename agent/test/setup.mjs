// Unit tests for `cordless setup` helpers (install dir, PATH script, app copy) — no side effects.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { defaultInstallDir, winUserPathScript, copyApp } from "../src/cli/setup.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log("FAIL:", m); } };

// install dir
const dir = defaultInstallDir();
ok(typeof dir === "string" && dir.includes("cordless"), "defaultInstallDir mentions cordless");
if (process.platform === "win32") ok(/Programs[\\/]cordless$/.test(dir), "windows install dir under Programs");

// PATH script: idempotent add + targeted remove, references the dir + SetEnvironmentVariable('...','User')
const add = winUserPathScript("C:/x/cordless");
ok(add.includes("C:/x/cordless") && add.includes("SetEnvironmentVariable") && add.includes("'User'"), "add script sets User PATH");
ok(add.includes("-notcontains") || add.includes("notcontains"), "add script is idempotent (skips if present)");
const rem = winUserPathScript("C:/x/cordless", { remove: true });
ok(rem.includes("Where-Object") && rem.includes("SetEnvironmentVariable"), "remove script filters the dir out");

// copyApp: copies an exe + its resources/ into a fresh dir
{
  const src = path.join(os.tmpdir(), "cordless-cp-src-" + crypto.randomBytes(3).toString("hex"));
  const dst = path.join(os.tmpdir(), "cordless-cp-dst-" + crypto.randomBytes(3).toString("hex"));
  fs.mkdirSync(path.join(src, "resources", "node_modules"), { recursive: true });
  const fakeExe = path.join(src, "cordless.exe");
  fs.writeFileSync(fakeExe, "MZfake");
  fs.writeFileSync(path.join(src, "resources", "hello.txt"), "hi");
  const installed = copyApp(dst, { exe: fakeExe });
  ok(fs.existsSync(installed) && fs.readFileSync(installed, "utf8") === "MZfake", "copies the exe");
  ok(fs.existsSync(path.join(dst, "resources", "hello.txt")), "copies resources/ recursively");
  fs.rmSync(src, { recursive: true, force: true });
  fs.rmSync(dst, { recursive: true, force: true });
}

console.log(`\n=== SETUP ${fail === 0 ? "PASS" : "FAIL"} (${pass} ok, ${fail} bad) ===`);
process.exit(fail === 0 ? 0 : 1);
