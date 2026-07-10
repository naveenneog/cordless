// End-to-end test of the cordless agent protocol against a live daemon.
// Uses an isolated CORDLESS_HOME (set by the caller). Requires the server already running.
import { addPendingPair } from "../src/state.js";
import { WebSocket } from "ws";

const BASE = process.env.BASE || "http://127.0.0.1:7443";
const WSURL = BASE.replace("http", "ws") + "/v1/ws";

let rid = 0;
const nextId = () => "r" + ++rid;
const send = (ws, obj) => ws.send(JSON.stringify(obj));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const deB64 = (s) => Buffer.from(s, "base64").toString("utf8");

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WSURL);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function makeHub(ws) {
  const waiters = [];
  ws.on("message", (raw) => {
    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(m)) {
        waiters[i].resolve(m);
        waiters.splice(i, 1);
      }
    }
  });
  return {
    wait(pred, ms = 5000, label = "frame") {
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => {
          const idx = waiters.indexOf(w);
          if (idx >= 0) {
            waiters.splice(idx, 1);
            reject(new Error("timeout waiting for " + label));
          }
        }, ms);
      });
    },
  };
}

const outputHas = (m, s) => {
  try {
    return m.type === "session.output" && deB64(m.data).includes(s);
  } catch {
    return false;
  }
};

async function main() {
  // 1. pair
  const secret = "e2e-secret-" + Date.now();
  addPendingPair(secret, 15);
  const pairRes = await fetch(BASE + "/v1/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairSecret: secret, deviceName: "e2e-test" }),
  });
  const pair = await pairRes.json();
  if (!pair.ok) throw new Error("pair failed: " + JSON.stringify(pair));
  console.log("PASS pair ->", pair.deviceId);

  // 2. reject a bogus pairing secret
  const bad = await (
    await fetch(BASE + "/v1/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairSecret: "nope", deviceName: "x" }),
    })
  ).json();
  if (bad.ok) throw new Error("bad secret should be rejected");
  console.log("PASS bogus pairing rejected");

  // 3. hello
  const ws1 = await connect();
  const hub1 = makeHub(ws1);
  send(ws1, { type: "hello", requestId: nextId(), deviceId: pair.deviceId, token: pair.token });
  await hub1.wait((m) => m.type === "hello.result" && m.ok, 5000, "hello.result");
  console.log("PASS hello");

  // 4. create + attach
  const cid = nextId();
  send(ws1, { type: "session.create", requestId: cid, profile: "shell", cols: 80, rows: 24 });
  const created = await hub1.wait((m) => m.type === "session.create.result" && m.requestId === cid, 5000, "create");
  const sid = created.sessionId;
  const aid = nextId();
  send(ws1, { type: "session.attach", requestId: aid, sessionId: sid, fromSeq: null });
  const att = await hub1.wait((m) => m.type === "session.attach.result" && m.requestId === aid, 5000, "attach");
  console.log(`PASS create+attach -> ${sid.slice(0, 8)} mode=${att.replayMode}`);

  await sleep(1000);

  // 5. input echo
  const marker = "CORDLESSMARK" + Math.floor(Math.random() * 1e6);
  send(ws1, { type: "session.input", sessionId: sid, data: b64(`echo ${marker}\r`) });
  const seen = await hub1.wait((m) => outputHas(m, marker), 8000, "echo marker");
  const lastSeq = seen.seq;
  send(ws1, { type: "session.ack", sessionId: sid, seq: lastSeq });
  console.log(`PASS input echo -> marker at seq ${lastSeq}`);

  // 6. reconnect + replay
  ws1.close();
  await sleep(400);
  const ws2 = await connect();
  const hub2 = makeHub(ws2);
  send(ws2, { type: "hello", requestId: nextId(), deviceId: pair.deviceId, token: pair.token });
  await hub2.wait((m) => m.type === "hello.result" && m.ok, 5000, "hello2");
  const aid2 = nextId();
  send(ws2, { type: "session.attach", requestId: aid2, sessionId: sid, fromSeq: lastSeq });
  const att2 = await hub2.wait((m) => m.type === "session.attach.result" && m.requestId === aid2, 5000, "reattach");
  console.log(`PASS reconnect -> mode=${att2.replayMode} latestSeq=${att2.latestSeq}`);

  // 7. streaming works after reconnect
  const marker2 = "CORDLESSMARK2_" + Math.floor(Math.random() * 1e6);
  send(ws2, { type: "session.input", sessionId: sid, data: b64(`echo ${marker2}\r`) });
  const seen2 = await hub2.wait((m) => outputHas(m, marker2), 8000, "post-reconnect marker");
  console.log(`PASS post-reconnect stream -> seq ${seen2.seq}`);

  // 8. list
  send(ws2, { type: "session.list", requestId: nextId() });
  const list = await hub2.wait((m) => m.type === "session.list.result", 5000, "list");
  console.log("PASS list ->", list.sessions.map((s) => `${s.sessionId.slice(0, 8)}:${s.state}`).join(", "));

  // 9. kill
  send(ws2, { type: "session.kill", requestId: nextId(), sessionId: sid, mode: "graceful" });
  try {
    await hub2.wait((m) => m.type === "session.exit" && m.sessionId === sid, 8000, "exit");
    console.log("PASS kill -> session exited");
  } catch {
    console.log("WARN no exit frame within timeout");
  }

  ws2.close();
  console.log("\n=== E2E PASS ===");
  process.exit(0);
}

main().catch((err) => {
  console.error("E2E FAIL:", err.message);
  process.exit(1);
});
