// Custom-profiles test: validation, PATH resolution, describeProfiles, and a real direct-spawn
// (command + args + env) through the SessionManager — no daemon/WS needed.
import { validateProfile, resolveExecutable, describeProfiles, profileKind, profileExecutable } from "../src/profiles.js";
import { SessionManager } from "../src/sessions.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m); } };

// ---- validation ----
ok(validateProfile("my-repo", { command: "pwsh", args: ["-NoLogo"] }).ok, "valid command profile");
ok(!validateProfile("bad name!", { command: "x" }).ok, "rejects an invalid profile name");
ok(!validateProfile("x", { command: "" }).ok, "rejects an empty command");
ok(!validateProfile("x", { command: "a", args: "nope" }).ok, "rejects non-array args");
ok(!validateProfile("x", { command: "a", args: ["\u0000"] }).ok, "rejects control chars in args");
ok(!validateProfile("x", { command: "a", env: { K: 5 } }).ok, "rejects non-string env value");
ok(!validateProfile("x", { command: "a", attentionPreset: "bogus" }).ok, "rejects unknown attentionPreset");
ok(validateProfile("x", { command: "a", attentionPreset: "agent" }).ok, "accepts attentionPreset agent");
ok(validateProfile("shell", {}).ok, "bare shell profile is valid");

// ---- kind / executable ----
ok(profileKind({ command: "copilot" }) === "command", "kind=command");
ok(profileKind({ initCommand: "claude" }) === "shell+command", "kind=shell+command");
ok(profileKind({ label: "Shell" }) === "shell", "kind=shell");
ok(profileExecutable({ initCommand: "codex --flag" }) === "codex", "executable from initCommand first token");

// ---- resolveExecutable ----
ok(!!resolveExecutable(process.execPath), "resolves an absolute path (node)");
ok(resolveExecutable("definitely-not-a-real-exe-xyz-123") === null, "unknown exe resolves to null");
ok(!!resolveExecutable(process.platform === "win32" ? "powershell" : "sh"), "resolves a PATH exe");

// ---- describeProfiles ----
const cfg = {
  profiles: {
    shell: { label: "Shell" },
    claude: { label: "Claude Code", initCommand: "claude" },
    myrepo: { command: process.execPath, args: ["-v"] },
    broken: { command: "definitely-not-a-real-exe-xyz-123" },
  },
};
const desc = describeProfiles(cfg, process.env);
const byName = Object.fromEntries(desc.map((d) => [d.name, d]));
ok(byName.shell.available === true, "bare shell is available");
ok(byName.myrepo.available === true && byName.myrepo.kind === "command", "custom command profile available");
ok(byName.broken.available === false && /not.*found/i.test(byName.broken.reason || ""), "missing-exe profile marked unavailable with reason");
ok(byName.shell.source === "built-in", "built-in source detected");

// ---- real direct-spawn through SessionManager (command + args + env) ----
const mgr = new SessionManager({
  maxSessions: 20,
  scrollback: 2000,
  ringBytesPerSession: 1024 * 1024,
  restoreSessions: false,
  history: { persist: false },
  profiles: {
    shell: { label: "Shell" },
    printer: { command: process.execPath, args: ["-e", "console.log('DIRECT_'+process.env.PROFVAR)"], env: { PROFVAR: "OK123" } },
  },
});

let threw = false;
try {
  mgr.create({ profile: "printer", cwd: process.cwd() });
} catch {
  threw = true;
}
ok(!threw, "create() with a valid command profile does not throw");

const s = [...mgr.sessions.values()][0];
let tail = "";
for (let i = 0; i < 25; i++) {
  await sleep(200);
  tail = await s.readTail(20);
  if (tail.includes("DIRECT_OK123")) break;
}
ok(tail.includes("DIRECT_OK123"), "direct-spawned command ran with its args + custom env");

let threw2 = false;
try {
  mgr.create({ profile: "shell", cwd: process.cwd() });
  const bad = { profiles: { ...mgr.cfg.profiles, ghost: { command: "definitely-not-a-real-exe-xyz-123" } } };
  const mgr2 = new SessionManager({ ...mgr.cfg, ...bad });
  mgr2.create({ profile: "ghost", cwd: process.cwd() });
} catch (e) {
  threw2 = /unavailable/.test(e.message);
}
ok(threw2, "create() throws a clear 'unavailable' error for a missing executable");

// ---- copilot built-in + agent attention preset ----
const dCop = describeProfiles({ profiles: { copilot: { label: "GitHub Copilot", command: "copilot", attentionPreset: "agent" } } }, process.env);
ok(dCop[0].kind === "command" && dCop[0].command === "copilot", "copilot is a direct-command profile");

const mgrA = new SessionManager({
  maxSessions: 20, scrollback: 1000, ringBytesPerSession: 1024 * 1024, restoreSessions: false, history: { persist: false },
  profiles: {
    shell: { label: "Shell" },
    agenty: { command: process.execPath, args: ["-e", "setInterval(()=>{},10000)"], attentionPreset: "agent" },
  },
});
mgrA.create({ profile: "agenty", cwd: process.cwd() });
mgrA.create({ profile: "shell", cwd: process.cwd() });
const [agentSess, shellSess] = [...mgrA.sessions.values()];
ok(agentSess._isAgent() === true, "attentionPreset 'agent' => _isAgent() true");
ok(shellSess._isAgent() === false, "bare shell => _isAgent() false");
mgrA.shutdown();

mgr.shutdown();
await sleep(200);
console.log(fail === 0 ? "=== PROFILES PASS ===" : "=== PROFILES FAIL ===");
process.exit(fail === 0 ? 0 : 1);
