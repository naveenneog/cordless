// Verify the CLI loopback client: health, authenticated connect, session RPCs, pairing mint.
import { DaemonClient, ensureDaemon, health } from "../src/cli/client.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m); } };

const h = await health();
ok(!!(h && h.ok), "health() reaches the daemon");

const e = await ensureDaemon();
ok(!!(e.health && !e.started), "ensureDaemon() sees the running daemon (no restart)");

const c = new DaemonClient();
await c.connect();
ok(c._authed === true, "client authenticated via the loopback credential");

const before = await c.listSessions();
ok(Array.isArray(before), "listSessions() returns an array");

const id = await c.createSession("shell", { title: "cli-test" });
ok(typeof id === "string" && id.length > 0, "createSession() returns an id");

const after = await c.listSessions();
ok(after.some((s) => s.sessionId === id), "the created session appears in the list");

const pr = await c.pairingCreate();
ok(pr.ok && Array.isArray(pr.urls) && typeof pr.code === "string", "pairingCreate() mints a code + urls");

await c.killSession(id, "force");
c.close();

console.log(`\n=== CLI-CLIENT ${fail === 0 ? "PASS" : "FAIL"} (${pass} ok, ${fail} bad) ===`);
process.exit(fail === 0 ? 0 : 1);
