// Seamless-resume regression test (the user's exact desktop path):
// open the `cordless` dashboard, attach to a session, and confirm the session stays on screen
// while the dashboard's 1s refresh timer keeps ticking (the bug: the timer repainted the
// dashboard *over* the attached PTY). Then detach and confirm the dashboard comes back.
//
// Driven through a real PTY so the dashboard sees an interactive TTY. Talks to the harness daemon
// on 127.0.0.1:7443 via the loopback DaemonClient (CORDLESS_HOME is inherited from the harness).
import path from "node:path";
import pty from "node-pty";
import { DaemonClient } from "../src/cli/client.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ALPHA = "RESUME_ALPHA_" + Math.floor(Math.random() * 1e6);
const BETA = "RESUMEBETA_" + Math.floor(Math.random() * 1e6);
const FOOTER = "enter attach"; // unique to the dashboard footer — never printed by a shell

// hard safety net so a stuck attach can never hang the harness
let child = null;
const bail = (msg) => { console.log("=== RESUME-DASH FAIL ===", msg); try { child && child.kill(); } catch {} process.exit(1); };
const guard = setTimeout(() => bail("overall timeout"), 45000);

async function waitFor(getText, needle, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (getText().includes(needle)) return true;
    await sleep(150);
  }
  bail(`timed out waiting for ${label || JSON.stringify(needle)}`);
}

async function main() {
  // 1. Create a session and leave a known marker in its retained scrollback.
  // (The harness gives every phase a fresh daemon, so this is the only session — the single
  // dashboard row is unambiguously ours and Enter attaches to it.)
  const c = new DaemonClient();
  await c.connect();
  const id = await c.createSession("shell", { title: "resume-me", cwd: process.env.TEMP || process.env.TMPDIR || "." });
  for (let i = 0; i < 25; i++) { // wait for the shell prompt so the echo isn't dropped during startup
    await sleep(300);
    const t = await c.tail(id, 20);
    if (/PS .*>/.test(t) || /[$#%>❯]\s*$/.test(t)) break;
  }
  c.send({ type: "session.input", sessionId: id, data: Buffer.from(`echo ${ALPHA}\r`).toString("base64") });
  for (let i = 0; i < 25; i++) { await sleep(250); if ((await c.tail(id, 40)).includes(ALPHA)) break; }
  c.close();

  // 2. Open the dashboard in a PTY.
  let out = "";
  child = pty.spawn(process.execPath, ["src/index.js"], {
    name: "xterm-color", cols: 100, rows: 30, cwd: ROOT,
    env: { ...process.env, CORDLESS_HOME: process.env.CORDLESS_HOME },
  });
  child.onData((d) => { out += d; });

  await waitFor(() => out, FOOTER, 12000, "dashboard to render");
  await waitFor(() => out, "resume-me", 8000, "the session row to appear");

  // 3. Attach to the (selected) session with Enter. Re-press once if the attach snapshot is slow to
  //    arrive (a dropped keypress under load) so the test is robust without being lenient about the bug.
  child.write("\r");
  const attachStart = Date.now();
  let attached = false;
  let repressed = false;
  while (Date.now() - attachStart < 14000) {
    await sleep(200);
    if (out.includes(ALPHA)) { attached = true; break; }
    if (!repressed && Date.now() - attachStart > 5000) { child.write("\r"); repressed = true; }
  }
  if (!attached) bail("timed out waiting for attach snapshot (the restored scrollback)");
  const postAttach = out.length; // everything from here is *after* we're attached

  // 4. Type into the live session and let several refresh ticks pass. If the timer repainted the
  //    dashboard over the session, FOOTER would reappear in this window. Poll for the command output
  //    (robust to slow shells) but always span >=3 ticks so a repaint bug can't slip through.
  child.write(`echo ${BETA}\r`);
  const t4 = Date.now();
  let betaHits = 0;
  while (Date.now() - t4 < 15000) {
    await sleep(250);
    betaHits = (out.slice(postAttach).match(new RegExp(BETA, "g")) || []).length;
    if (betaHits >= 2 && Date.now() - t4 >= 3500) break; // interactive AND >=3 refresh ticks elapsed
  }

  const slice = out.slice(postAttach);
  const repainted = slice.includes(FOOTER);

  if (betaHits < 2) bail(`typed into the session but its output never came back (betaHits=${betaHits}) — not interactive`);
  if (repainted) bail("the dashboard repainted over the attached session (refresh-timer bug)");
  console.log(`  attached + interactive (BETA x${betaHits}); no dashboard repaint over the session`);

  // 5. Detach (Ctrl-] then d) and confirm the dashboard returns.
  const detachFrom = out.length;
  child.write("\x1d"); // Ctrl-]
  child.write("d");
  const end = Date.now() + 8000;
  let back = false;
  while (Date.now() < end) { if (out.slice(detachFrom).includes(FOOTER)) { back = true; break; } await sleep(150); }
  if (!back) bail("dashboard did not come back after detach");
  console.log("  detached cleanly; dashboard restored");

  // 6. Quit — the dashboard exits on its own; wait for that rather than force-killing.
  const exited = new Promise((res) => child.onExit(() => res(true)));
  child.write("q");
  const cleanExit = await Promise.race([exited, sleep(4000).then(() => false)]);
  if (!cleanExit) { try { child.kill(); } catch {} }
  clearTimeout(guard);
  console.log(`=== RESUME-DASH PASS ===${cleanExit ? "" : " (forced exit)"}`);
  process.exit(0);
}

main().catch((e) => bail(e && e.message ? e.message : String(e)));
