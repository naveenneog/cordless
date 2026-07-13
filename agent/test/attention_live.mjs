// Live attention test: a session settles working -> idle, exposes attention fields, pushes a
// session.activity frame, and honours session.attention.clear. (Prompt/bell classification itself
// is unit-tested in attention.mjs.)
import { DaemonClient } from "../src/cli/client.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m); } };

const c = new DaemonClient();
await c.connect();
const acts = [];
c.on("session.activity", (m) => acts.push(m));

const id = await c.createSession("shell", { title: "attn" });
ok(!!id, "created a session");

// Produce a little output, then go quiet.
c.send({ type: "session.input", sessionId: id, data: Buffer.from("echo hi\r").toString("base64") });

// Poll for the idle transition (IDLE_AFTER_MS = 5s) up to ~12s so the test is robust under CI load.
let s = null;
for (let i = 0; i < 24; i++) {
  await sleep(500);
  s = (await c.listSessions()).find((x) => x.sessionId === id);
  if (s && s.activity === "idle") break;
}
ok(!!s && "activity" in s && "attention" in s && "attentionRevision" in s, "session.list carries attention fields");
ok(s && s.activity === "idle", "quiet session settled to idle (got " + (s && s.activity) + ")");
ok(s && s.attention == null, "no false-positive attention on a bare shell (got " + (s && s.attention) + ")");
ok(acts.some((a) => a.sessionId === id), "received at least one session.activity push");

const clr = await c._rpc("session.attention.clear", { sessionId: id });
ok(clr.ok, "session.attention.clear returns ok");

await c.killSession(id, "force");
c.close();

console.log(`\n=== ATTENTION-LIVE ${fail === 0 ? "PASS" : "FAIL"} (${pass} ok, ${fail} bad) ===`);
process.exit(fail === 0 ? 0 : 1);
