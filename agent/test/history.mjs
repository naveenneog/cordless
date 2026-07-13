// Persisted-history test (create/check split; the harness restarts the daemon between them).
// create: start a session, echo a marker, wait for it in the buffer.
// [daemon stop -> shutdown() saves history -> daemon start -> restore() injects it]
// check: the restored session's tail must still contain the marker; killing it must drop the file.
import { DaemonClient } from "../src/cli/client.js";
import fs from "node:fs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mode = process.argv[2];
const STATE = "test/.history-state.json";
const TOKEN = "HISTORY_TOKEN_54321";

const c = new DaemonClient();
await c.connect();

if (mode === "create") {
  const id = await c.createSession("shell", { title: "hist-me" });
  for (let i = 0; i < 25; i++) {
    await sleep(300);
    const t = await c.tail(id, 20);
    if (/PS .*>/.test(t) || /[$#%>❯]\s*$/.test(t)) break;
  }
  c.send({ type: "session.input", sessionId: id, data: Buffer.from(`echo ${TOKEN}\r`).toString("base64") });
  let seen = false;
  for (let i = 0; i < 25; i++) {
    await sleep(250);
    if ((await c.tail(id, 40)).includes(TOKEN)) { seen = true; break; }
  }
  // Keep the daemon up past one periodic history-flush sweep (~3s) so the marker is persisted before
  // the harness hard-kills the daemon (a Windows TerminateProcess / real reboot never runs shutdown()).
  await sleep(4000);
  fs.writeFileSync(STATE, JSON.stringify({ id }));
  console.log(seen ? "CREATED (marker in buffer)" : "CREATE WARN: marker not seen pre-restart");
  process.exit(seen ? 0 : 1);
} else {
  let pass = 0, fail = 0;
  const ok = (cond, m) => { if (cond) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m); } };
  const { id } = JSON.parse(fs.readFileSync(STATE, "utf8"));

  // The restored session should exist and its tail should still contain the pre-restart marker.
  let text = "";
  for (let i = 0; i < 25; i++) {
    await sleep(250);
    text = await c.tail(id, 200);
    if (text.includes(TOKEN)) break;
  }
  ok(text.includes(TOKEN), "persisted history survived the restart (marker in restored tail)");
  ok(/reopened after system restart/.test(text), "restore banner present");

  // Killing the session must delete its persisted history file.
  const before = await c.historyList();
  ok(before.some((h) => h.sessionId === id), "history file exists before kill");
  await c.killSession(id, "force");
  await sleep(1200);
  const after = await c.historyList();
  ok(!after.some((h) => h.sessionId === id), "history file removed after kill");

  console.log(fail === 0 ? "=== HISTORY PASS ===" : "=== HISTORY FAIL ===");
  process.exit(fail === 0 ? 0 : 1);
}
