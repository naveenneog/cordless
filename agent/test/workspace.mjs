// Unit tests for the workspace store (named session templates). Uses an isolated CORDLESS_HOME.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

process.env.CORDLESS_HOME = path.join(os.tmpdir(), "cordless-ws-" + crypto.randomBytes(4).toString("hex"));
fs.mkdirSync(process.env.CORDLESS_HOME, { recursive: true });
const { saveWorkspace, getWorkspace, loadWorkspaces, deleteWorkspace } = await import("../src/state.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log("FAIL:", m); } };

ok(Object.keys(loadWorkspaces()).length === 0, "starts empty");

const ws = saveWorkspace("api-feature", {
  sessions: [
    { profile: "claude", cwd: "/src/api", title: "Claude API" },
    { profile: "codex", cwd: "/src/web", title: "Codex Web" },
    { profile: "shell", cwd: "/src/api", title: "Tests" },
  ],
});
ok(ws.name === "api-feature" && !!ws.savedAt, "save stamps name + savedAt");
ok(getWorkspace("api-feature").sessions.length === 3, "get returns the 3 templates");
ok("api-feature" in loadWorkspaces(), "appears in the map");

saveWorkspace("solo", { sessions: [{ profile: "shell", cwd: "/x", title: "one" }] });
ok(Object.keys(loadWorkspaces()).length === 2, "second workspace stored independently");

ok(deleteWorkspace("api-feature") === true, "delete returns true");
ok(getWorkspace("api-feature") === null, "deleted workspace is gone");
ok(deleteWorkspace("nope") === false, "delete of a missing workspace returns false");
ok(Object.keys(loadWorkspaces()).length === 1, "only the surviving workspace remains");

console.log(`\n=== WORKSPACE ${fail === 0 ? "PASS" : "FAIL"} (${pass} ok, ${fail} bad) ===`);
process.exit(fail === 0 ? 0 : 1);
