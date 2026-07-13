// Test harness: spins up an isolated daemon and runs every suite against it.
// Usage: node test/run.mjs        (npm test)
// Each phase uses a fresh CORDLESS_HOME so runs are hermetic.
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = 7443;
const BASE = `http://127.0.0.1:${PORT}`;

const freshHome = () => {
  const dir = path.join(os.tmpdir(), `cordless-test-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function healthOnce() {
  return new Promise((resolve) => {
    const req = http.get(`${BASE}/v1/health`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1000, () => { req.destroy(); resolve(false); });
  });
}

async function waitHealthy(ms = 12000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await healthOnce()) return true;
    await sleep(250);
  }
  return false;
}

async function waitPortFree(ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!(await healthOnce())) return true;
    await sleep(250);
  }
  return false;
}

function startDaemon(home) {
  const child = spawn("node", ["src/index.js", "start", "--foreground"], {
    cwd: ROOT,
    env: { ...process.env, CORDLESS_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.stdout.write("  [daemon] " + d));
  child.stderr.on("data", (d) => process.stderr.write("  [daemon!] " + d));
  return child;
}

async function stopDaemon(child) {
  if (!child || child.killed) return;
  try { child.kill("SIGTERM"); } catch {}
  await waitPortFree();
  try { child.kill("SIGKILL"); } catch {}
}

// Runs a test file; resolves { code, out }. Streams output live.
function runTest(file, home, args = []) {
  return new Promise((resolve) => {
    const child = spawn("node", [`test/${file}`, ...args], {
      cwd: ROOT,
      env: { ...process.env, CORDLESS_HOME: home, BASE },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const cap = (d) => { out += d.toString(); process.stdout.write("    " + d.toString().replace(/\n(?!$)/g, "\n    ")); };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);
    child.on("close", (code) => resolve({ code, out }));
  });
}

const results = [];
const record = (name, ok, note = "") => { results.push({ name, ok, note }); console.log(`\n>>> ${ok ? "PASS" : "FAIL"}  ${name}${note ? "  (" + note + ")" : ""}\n`); };

async function main() {
  // Phase 0: pty smoke + pure dashboard render (no daemon needed)
  console.log("== pty_smoke ==");
  {
    const { code, out } = await runTest("pty_smoke.mjs", freshHome());
    record("pty_smoke", code === 0 && /RESULT: PASS/.test(out));
  }
  console.log("== dashboard_render ==");
  {
    const { code, out } = await runTest("dashboard_render.mjs", freshHome());
    record("dashboard_render", code === 0 && /DASHBOARD-RENDER PASS/.test(out));
  }
  console.log("== attention (pure) ==");
  {
    const { code, out } = await runTest("attention.mjs", freshHome());
    record("attention", code === 0 && /ATTENTION PASS/.test(out));
  }
  console.log("== notifier ==");
  {
    const { code, out } = await runTest("notifier.mjs", freshHome());
    record("notifier", code === 0 && /NOTIFIER PASS/.test(out));
  }
  console.log("== workspace ==");
  {
    const { code, out } = await runTest("workspace.mjs", freshHome());
    record("workspace", code === 0 && /WORKSPACE PASS/.test(out));
  }
  console.log("== setup ==");
  {
    const { code, out } = await runTest("setup.mjs", freshHome());
    record("setup", code === 0 && /SETUP PASS/.test(out));
  }
  console.log("== profiles ==");
  {
    const { code, out } = await runTest("profiles.mjs", freshHome());
    record("profiles", code === 0 && /PROFILES PASS/.test(out));
  }
  console.log("== openterm ==");
  {
    const { code, out } = await runTest("openterm.mjs", freshHome());
    record("openterm", code === 0 && /OPENTERM PASS/.test(out));
  }
  console.log("== history_shutdown ==");
  {
    const { code, out } = await runTest("history_shutdown.mjs", freshHome());
    record("history_shutdown", code === 0 && /HISTORY-SHUTDOWN PASS/.test(out));
  }

  // Phase A: protocol + security + desktop credential (single daemon, shared home)
  console.log("== phase A: e2e / security / desktop ==");
  {
    const home = freshHome();
    const d = startDaemon(home);
    if (!(await waitHealthy())) { record("phaseA:daemon-start", false, "health never came up"); await stopDaemon(d); }
    else {
      for (const f of ["e2e.mjs", "security.mjs", "desktop.mjs", "desktop_scope.mjs", "pairing.mjs", "cli_client.mjs", "attention_live.mjs", "attention_prompt.mjs", "output.mjs", "rename.mjs", "groups.mjs"]) {
        const { code } = await runTest(f, home);
        record(f, code === 0);
      }
      await stopDaemon(d);
    }
  }

  // Phase B: session restore across a daemon restart (same home)
  console.log("== phase B: restore across restart ==");
  {
    const home = freshHome();
    let d = startDaemon(home);
    if (!(await waitHealthy())) { record("phaseB:daemon-start", false); await stopDaemon(d); }
    else {
      const create = await runTest("restore.mjs", home, ["create"]);
      record("restore:create", create.code === 0);
      await stopDaemon(d);
      await sleep(500);
      d = startDaemon(home);
      if (!(await waitHealthy())) { record("phaseB:daemon-restart", false); }
      else {
        const check = await runTest("restore.mjs", home, ["check"]);
        record("restore:check", check.code === 0 && /RESTORE PASS/.test(check.out));
      }
      await stopDaemon(d);
    }
  }

  // Phase C: seamless resume — attach from the dashboard and confirm the refresh timer does not
  // repaint the dashboard over the attached session (the user-reported "can't resume" bug).
  console.log("== phase C: seamless resume (dashboard attach) ==");
  {
    const home = freshHome();
    const d = startDaemon(home);
    if (!(await waitHealthy())) { record("phaseC:daemon-start", false); await stopDaemon(d); }
    else {
      const { code, out } = await runTest("resume_dash.mjs", home);
      record("resume_dash", code === 0 && /RESUME-DASH PASS/.test(out));
      await stopDaemon(d);
    }
  }

  // Phase D: persisted history survives a daemon restart (marker saved on shutdown, injected on restore)
  console.log("== phase D: persisted history across restart ==");
  {
    const home = freshHome();
    let d = startDaemon(home);
    if (!(await waitHealthy())) { record("phaseD:daemon-start", false); await stopDaemon(d); }
    else {
      const create = await runTest("history.mjs", home, ["create"]);
      record("history:create", create.code === 0);
      await stopDaemon(d);
      await sleep(500);
      d = startDaemon(home);
      if (!(await waitHealthy())) { record("phaseD:daemon-restart", false); }
      else {
        const check = await runTest("history.mjs", home, ["check"]);
        record("history:check", check.code === 0 && /HISTORY PASS/.test(check.out));
      }
      await stopDaemon(d);
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log("\n================ SUMMARY ================");
  for (const r of results) console.log(`  ${r.ok ? "ok  " : "FAIL"}  ${r.name}${r.note ? "  " + r.note : ""}`);
  console.log(`  ${results.length - failed.length}/${results.length} passed`);
  console.log("========================================");
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
