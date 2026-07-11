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

// Wait past PROMPT_QUIET (1.5s) + INPUT_GRACE (2s) + a manager tick.
await sleep(4500);
let s = (await c.listSessions()).find((x) => x.sessionId === id);
ok(s && s.attention === "prompt", 'confirm prompt detected as attention:"prompt" (got ' + (s && s.attention) + ")");

// Answering (sending a newline) clears the attention badge.
c.send({ type: "session.input", sessionId: id, data: Buffer.from("y\r").toString("base64") });
await sleep(800);
s = (await c.listSessions()).find((x) => x.sessionId === id);
ok(s && s.attention == null, "answering the prompt clears attention (got " + (s && s.attention) + ")");

await c.killSession(id, "force");
c.close();
console.log(`\n=== ATTENTION-PROMPT ${fail === 0 ? "PASS" : "FAIL"} (${pass} ok, ${fail} bad) ===`);
process.exit(fail === 0 ? 0 : 1);
