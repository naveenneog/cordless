// Live session-groups test: create/list/rename/color/assign/delete, session.list reflection,
// unassign-on-delete (never kills), and the groups.updated broadcast to other clients.
import { DaemonClient } from "../src/cli/client.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m); } };

const c = new DaemonClient();
await c.connect();

// a second client to observe broadcasts
const c2 = new DaemonClient();
await c2.connect();
let lastGroupsBroadcast = null;
c2.on("groups.updated", (m) => { lastGroupsBroadcast = m.groups; });

const s1 = await c.createSession("shell", { title: "one" });
const s2 = await c.createSession("shell", { title: "two" });

const g = await c.createGroup("API migration", "blue");
ok(g && g.id && g.name === "API migration" && g.color === "blue" && g.revision === 1, "group.create returns a group");
ok((await c.listGroups()).some((x) => x.id === g.id), "group.list includes the new group");

for (let i = 0; i < 20 && !lastGroupsBroadcast; i++) await sleep(100);
ok(Array.isArray(lastGroupsBroadcast) && lastGroupsBroadcast.some((x) => x.id === g.id), "groups.updated broadcast to other clients");

const g2 = await c.renameGroup(g.id, "API v2");
ok(g2.name === "API v2" && g2.revision === 2, "group.rename bumps revision");

const gc = await c.setGroupColor(g.id, "green");
ok(gc.color === "green" && gc.revision === 3, "group.color updates + bumps revision");

await c.assignSession(s1, g.id, 0);
await c.assignSession(s2, g.id, 1);
let list = await c.listSessions();
const a1 = list.find((x) => x.sessionId === s1);
const a2 = list.find((x) => x.sessionId === s2);
ok(a1.groupId === g.id && a1.groupOrder === 0, "session.list reflects group assignment + order");
ok(a2.groupId === g.id && a2.groupOrder === 1, "second session assigned with its own order");

// unassign one
await c.assignSession(s1, null);
list = await c.listSessions();
ok(list.find((x) => x.sessionId === s1).groupId === null, "assigning null ungroups a session");

// bad group id rejected
let threw = false;
try { await c.assignSession(s2, "no-such-group"); } catch { threw = true; }
ok(threw, "assigning to an unknown group is rejected");

// delete: sessions survive, become ungrouped
await c.deleteGroup(g.id);
list = await c.listSessions();
ok(!(await c.listGroups()).some((x) => x.id === g.id), "group.delete removes the group");
ok(list.some((x) => x.sessionId === s2) && list.find((x) => x.sessionId === s2).groupId === null, "delete ungroups sessions but never kills them");

c.close();
c2.close();
console.log(fail === 0 ? "=== GROUPS PASS ===" : "=== GROUPS FAIL ===");
process.exit(fail === 0 ? 0 : 1);
