// Minimal interactive attach: stream a daemon PTY straight into the host terminal.
// The host terminal is the renderer (no xterm.js). Detach chord: Ctrl-] then d.
import { DaemonClient } from "./client.js";

const CTRL_RBRACKET = 0x1d; // Ctrl-]
const b64ToBuf = (s) => Buffer.from(s, "base64");
const bufToB64 = (b) => Buffer.from(b).toString("base64");

// Attach to `sessionId`; resolves with a reason ("detach" | "exit" | "disconnected") when it ends.
export async function attachSession(sessionId, { onStatus } = {}) {
  const client = new DaemonClient();
  await client.connect();

  const stdin = process.stdin;
  const stdout = process.stdout;
  let latestSeq = -1;
  let ackTimer = null;
  let chord = false;
  let settled = false;
  let done;
  const finished = new Promise((r) => (done = r));

  const cleanup = (reason) => {
    if (settled) return;
    settled = true;
    if (ackTimer) clearInterval(ackTimer);
    stdin.removeListener("data", onData);
    stdout.removeListener("resize", onResize);
    try {
      if (stdin.isTTY) stdin.setRawMode(false);
    } catch {
      /* ignore */
    }
    stdin.pause();
    try {
      client.close();
    } catch {
      /* ignore */
    }
    done(reason);
  };

  client.on("session.output", (m) => {
    if (m.sessionId !== sessionId) return;
    if (m.reset) stdout.write("\x1b[2J\x1b[3J\x1b[H"); // reset host view before a snapshot
    stdout.write(b64ToBuf(m.data));
    latestSeq = m.seq;
  });
  client.on("session.exit", (m) => {
    if (m.sessionId !== sessionId) return;
    stdout.write(`\r\n\x1b[2m[session exited${m.exitCode != null ? ` (code ${m.exitCode})` : ""}]\x1b[0m\r\n`);
    cleanup("exit");
  });
  client.onClose = () => cleanup("disconnected");

  function forward(bytes) {
    if (bytes.length) client.send({ type: "session.input", sessionId, data: bufToB64(Buffer.from(bytes)) });
  }
  function onData(buf) {
    // Fast path: no chord pending and no Ctrl-] in the chunk -> forward as-is.
    if (!chord && !buf.includes(CTRL_RBRACKET)) {
      client.send({ type: "session.input", sessionId, data: bufToB64(buf) });
      return;
    }
    const run = [];
    for (const byte of buf) {
      if (chord) {
        chord = false;
        if (byte === 0x64 || byte === 0x44) {
          forward(run);
          cleanup("detach");
          return;
        }
        if (byte === CTRL_RBRACKET) {
          run.push(CTRL_RBRACKET); // Ctrl-] Ctrl-] -> literal Ctrl-]
          continue;
        }
        run.push(CTRL_RBRACKET, byte);
        continue;
      }
      if (byte === CTRL_RBRACKET) {
        chord = true;
        continue;
      }
      run.push(byte);
    }
    forward(run);
  }
  function onResize() {
    client.send({ type: "session.resize", sessionId, cols: stdout.columns || 80, rows: stdout.rows || 24 });
  }

  const res = await client._rpc("session.attach", { sessionId, fromSeq: null });
  if (!res.ok) {
    client.close();
    throw new Error(res.error?.message || "attach failed");
  }
  if (onStatus) onStatus();

  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  stdin.on("data", onData);
  stdout.on("resize", onResize);
  onResize();
  ackTimer = setInterval(() => {
    if (latestSeq >= 0) client.send({ type: "session.ack", sessionId, seq: latestSeq });
  }, 1000);

  return finished;
}
