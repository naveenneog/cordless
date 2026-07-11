// Session-restore test. Usage: node test/restore.mjs create   then restart daemon, then   node test/restore.mjs check
import { addPendingPair } from "../src/state.js";
import fs from "node:fs";
import { WebSocket } from "ws";

const BASE = "http://127.0.0.1:7443";
const WSURL = BASE.replace("http", "ws") + "/v1/ws";
const STATE = "test/.restore-state.json";
const mode = process.argv[2];

async function pair() {
  const secret = "restore-" + Date.now();
  addPendingPair(secret, 15);
  const r = await fetch(BASE + "/v1/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairSecret: secret, deviceName: "restore-test" }),
  });
  return r.json();
}
function connect(creds) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WSURL);
    const frames = [];
    ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "hello", requestId: "h", deviceId: creds.deviceId, token: creds.token }));
      resolve({ ws, frames });
    });
    ws.on("error", reject);
  });
}
const wait = (frames, pred, ms = 5000) =>
  new Promise((res, rej) => {
    const t = setInterval(() => {
      const f = frames.find(pred);
      if (f) { clearInterval(t); res(f); }
    }, 50);
    setTimeout(() => { clearInterval(t); rej(new Error("timeout")); }, ms);
  });

async function main() {
  const creds = await pair();
  const { ws, frames } = await connect(creds);
  await wait(frames, (m) => m.type === "hello.result");

  if (mode === "create") {
    ws.send(JSON.stringify({ type: "session.create", requestId: "c", profile: "shell", cwd: process.env.TEMP || "/tmp", title: "restore-me", cols: 90, rows: 28 }));
    const created = await wait(frames, (m) => m.type === "session.create.result");
    ws.send(JSON.stringify({ type: "session.list", requestId: "l" }));
    const list = await wait(frames, (m) => m.type === "session.list.result");
    const s = list.sessions.find((x) => x.sessionId === created.sessionId);
    fs.writeFileSync(STATE, JSON.stringify({ creds, sessionId: s.sessionId, generation: s.generation, title: s.title, cwd: s.cwd }));
    console.log("CREATED", JSON.stringify({ sessionId: s.sessionId.slice(0, 8), generation: s.generation.slice(0, 8), title: s.title, cwd: s.cwd }));
  } else {
    const prev = JSON.parse(fs.readFileSync(STATE, "utf8"));
    ws.send(JSON.stringify({ type: "session.list", requestId: "l" }));
    const list = await wait(frames, (m) => m.type === "session.list.result");
    const s = list.sessions.find((x) => x.sessionId === prev.sessionId);
    if (!s) { console.log("FAIL: session not restored"); process.exit(1); }
    const sameId = s.sessionId === prev.sessionId;
    const newGen = s.generation !== prev.generation;
    console.log("RESTORED", JSON.stringify({ sameId, newGen, title: s.title, cwd: s.cwd, state: s.state }));
    console.log(sameId && newGen && s.title === "restore-me" ? "=== RESTORE PASS ===" : "=== RESTORE FAIL ===");
  }
  ws.close();
  setTimeout(() => process.exit(0), 200);
}
main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
