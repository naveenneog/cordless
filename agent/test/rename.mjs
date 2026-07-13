// Live rename test: title set + sanitization (NFC/trim/caps/control-strip), monotonic revisions,
// empty-restores-default, and the session.updated broadcast to other connected clients.
import { DaemonClient } from "../src/cli/client.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m); } };

const c = new DaemonClient();
await c.connect();
const id = await c.createSession("shell", { title: "orig" });

let r = await c.renameSession(id, "My API Work");
ok(r.title === "My API Work", "rename sets the title");
ok(r.revision === 1, "revision starts at 1");

const list = await c.listSessions();
const s = list.find((x) => x.sessionId === id);
ok(s && s.title === "My API Work" && s.titleRevision === 1, "session.list reflects the new title + titleRevision");

r = await c.renameSession(id, "Second");
ok(r.revision === 2, "revision increments monotonically");

r = await c.renameSession(id, "x".repeat(200));
ok([...r.title].length === 80, "title capped to 80 code points");

r = await c.renameSession(id, "a\u0000b\u001bc\nd");
ok(r.title === "abcd", "C0/C1/newline control chars stripped");

r = await c.renameSession(id, "   spaced   out   ");
ok(r.title === "spaced out", "trimmed + inner whitespace collapsed");

r = await c.renameSession(id, "");
ok(/\u00b7/.test(r.title), "empty title restores the generated default (contains \u00b7)");

// broadcast to another connected client
const c2 = new DaemonClient();
await c2.connect();
let updated = null;
c2.on("session.updated", (m) => { if (m.sessionId === id) updated = m; });
await c.renameSession(id, "Broadcast Test");
for (let i = 0; i < 20 && !updated; i++) await sleep(100);
ok(updated && updated.changes && updated.changes.title === "Broadcast Test", "session.updated broadcast to other clients");
ok(updated && typeof updated.revision === "number", "broadcast carries a revision");

c.close();
c2.close();
console.log(fail === 0 ? "=== RENAME PASS ===" : "=== RENAME FAIL ===");
process.exit(fail === 0 ? 0 : 1);
