// Live prompt-detection test: a confirm prompt left on screen is detected as attention:"prompt",
// and answering it (sending input) clears the badge. Cross-platform (Read-Host on Windows, read on sh).
import os from "node:os";
import { DaemonClient } from "../src/cli/client.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m); } };

const c = new DaemonClient();
await c.connect();
const id = await c.createSession("shell", { title: "prompt" });
await sleep(1200); // let the shell settle past startup

const cmd = os.platform() === "win32"
  ? '$null = Read-Host "Apply these edits? (y/n)"\r'
  : 'read -p "Apply these edits? (y/n) " x\r';
c.send({ type: "session.input", sessionId: id, data: Buffer.from(cmd).toString("base64") });

// Poll for the prompt (past PROMPT_QUIET 1.5s + INPUT_GRACE 2s + a tick), robust under CI load.
let s = null;
for (let i = 0; i < 20; i++) {
  await sleep(500);
  s = (await c.listSessions()).find((x) => x.sessionId === id);
  if (s && s.attention === "prompt") break;
}
ok(s && s.attention === "prompt", 'confirm prompt detected as attention:"prompt" (got ' + (s && s.attention) + ")");

// Answering (sending input) clears the attention badge.
c.send({ type: "session.input", sessionId: id, data: Buffer.from("y\r").toString("base64") });
let cleared = false;
for (let i = 0; i < 10; i++) {
  await sleep(300);
  s = (await c.listSessions()).find((x) => x.sessionId === id);
  if (s && s.attention == null) { cleared = true; break; }
}
ok(cleared, "answering the prompt clears attention (got " + (s && s.attention) + ")");

await c.killSession(id, "force");
c.close();
console.log(`\n=== ATTENTION-PROMPT ${fail === 0 ? "PASS" : "FAIL"} (${pass} ok, ${fail} bad) ===`);
process.exit(fail === 0 ? 0 : 1);
