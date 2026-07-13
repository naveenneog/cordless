// Regression test for the cross-platform bug where a graceful daemon shutdown (POSIX SIGTERM ->
// shutdown()) saved each running session's history and then immediately deleted it via the PTY-exit
// handler. shutdown() must PRESERVE history for the restore. Tested directly (the harness's SIGTERM
// can't trigger graceful shutdown on Windows).
import { SessionManager } from "../src/sessions.js";
import { loadSessionHistory } from "../src/state.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m); } };

const mgr = new SessionManager({
  maxSessions: 20,
  scrollback: 2000,
  ringBytesPerSession: 1024 * 1024,
  restoreSessions: true,
  history: { persist: true },
  profiles: { shell: { label: "Shell" } },
});
mgr.create({ profile: "shell", cwd: process.cwd() });
const s = [...mgr.sessions.values()][0];

await sleep(1500); // let the shell emit its prompt
s._saveHistoryNow();
ok(loadSessionHistory(s.id) !== null, "history is persisted while the session runs");

// Graceful shutdown: saves history, then kills the PTY (which fires _onExit).
mgr.shutdown();
await sleep(1500); // let the PTY exit handler run

ok(loadSessionHistory(s.id) !== null, "graceful shutdown PRESERVES history for the restore");

console.log(fail === 0 ? "=== HISTORY-SHUTDOWN PASS ===" : "=== HISTORY-SHUTDOWN FAIL ===");
process.exit(fail === 0 ? 0 : 1);
