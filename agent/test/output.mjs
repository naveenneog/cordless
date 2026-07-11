// Live test: session.tail returns recent output; session.search finds it in the retained buffer.
import { DaemonClient } from "../src/cli/client.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m); } };

const c = new DaemonClient();
await c.connect();
const id = await c.createSession("shell", { title: "out" });

const TOKEN = "SEARCHABLE_TOKEN_98765";
c.send({ type: "session.input", sessionId: id, data: Buffer.from(`echo ${TOKEN}\r`).toString("base64") });
await sleep(1500);

const text = await c.tail(id, 40);
ok(typeof text === "string" && text.includes(TOKEN), "session.tail includes the echoed token");

const matches = await c.search(id, "SEARCHABLE_TOKEN", 50);
ok(Array.isArray(matches) && matches.some((m) => m.text.includes(TOKEN)), "session.search finds the token");

const none = await c.search(id, "definitely-not-present-xyzzy", 50);
ok(Array.isArray(none) && none.length === 0, "search returns no matches for absent text");

await c.killSession(id, "force");
c.close();

console.log(`\n=== OUTPUT-SEARCH ${fail === 0 ? "PASS" : "FAIL"} (${pass} ok, ${fail} bad) ===`);
process.exit(fail === 0 ? 0 : 1);
