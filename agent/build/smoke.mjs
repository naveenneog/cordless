// Smoke-test a packaged cordless build: start -> health -> new PTY -> sessions -> stop.
// Usage: node build/smoke.mjs <path-to-cordless-exe>
import { execFileSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const exe = process.argv[2];
if (!exe || !fs.existsSync(exe)) {
  console.error("usage: node build/smoke.mjs <cordless-exe>  (not found: " + exe + ")");
  process.exit(2);
}
const home = path.join(os.tmpdir(), "cordless-smoke-" + crypto.randomBytes(3).toString("hex"));
fs.mkdirSync(home, { recursive: true });
const env = { ...process.env, CORDLESS_HOME: home, NO_COLOR: "1" };
const run = (args) => execFileSync(exe, args, { env, encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function healthy() {
  return new Promise((resolve) => {
    const q = http.get("http://127.0.0.1:7443/v1/health", (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    q.on("error", () => resolve(false));
    q.setTimeout(1000, () => {
      q.destroy();
      resolve(false);
    });
  });
}

try {
  console.log("version:", run(["--version"]).trim());
  run(["start"]);
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    up = await healthy();
    if (!up) await sleep(500);
  }
  if (!up) throw new Error("daemon did not become healthy");
  run(["new", "shell", "--title", "smoke"]);
  await sleep(700);
  const list = run(["sessions"]);
  if (!/shell/.test(list)) throw new Error("no shell session spawned:\n" + list);
  console.log("sessions:\n" + list.trim());
  run(["stop"]);
  console.log("\nSMOKE PASS");
  process.exit(0);
} catch (e) {
  console.error("SMOKE FAIL:", e.message);
  try {
    run(["stop"]);
  } catch {
    /* ignore */
  }
  try {
    console.error(fs.readFileSync(path.join(home, "daemon.log"), "utf8").slice(-2000));
  } catch {
    /* ignore */
  }
  process.exit(1);
}
