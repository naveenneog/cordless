// Verify daemon-owned pairing: loopback credential can mint + cancel; a normal device cannot.
import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import { addPendingPair } from "../src/state.js";

const BASE = process.env.BASE || "http://127.0.0.1:7443";
const WSURL = BASE.replace("http", "ws") + "/v1/ws";
const HOME = process.env.CORDLESS_HOME;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m); } };

const connect = () => new Promise((res, rej) => { const ws = new WebSocket(WSURL); ws.on("open", () => res(ws)); ws.on("error", rej); });
const rpc = (ws, msg, resultType) => new Promise((res) => {
  const onMsg = (d) => { const m = JSON.parse(d.toString()); if (m.type === resultType) { ws.off("message", onMsg); res(m); } };
  ws.on("message", onMsg);
  ws.send(JSON.stringify(msg));
});
const hello = (ws, deviceId, token) => rpc(ws, { type: "hello", requestId: "h", deviceId, token }, "hello.result");

// 1. The loopback desktop/CLI credential can mint + cancel a pairing code.
const cred = JSON.parse(fs.readFileSync(path.join(HOME, "desktop-credential.json"), "utf8"));
{
  const ws = await connect();
  const h = await hello(ws, cred.deviceId, cred.token);
  ok(h.ok, "desktop credential authenticates");
  const r = await rpc(ws, { type: "pairing.create", requestId: "p1" }, "pairing.create.result");
  ok(r.ok, "pairing.create ok from loopback credential");
  ok(typeof r.code === "string" && r.code.length > 20, "returns a single-use secret code");
  ok(typeof r.pairingId === "string" && r.pairingId.length > 0, "returns a pairingId");
  ok(Array.isArray(r.urls), "returns a urls array");
  ok(r.urls.every((u) => u.includes("#pair=")), "urls carry the #pair= fragment");
  ok(!!r.route && typeof r.route.kind === "string", "returns a route descriptor");
  const c = await rpc(ws, { type: "pairing.cancel", requestId: "c1", pairingId: r.pairingId }, "pairing.cancel.result");
  ok(c.ok, "pairing.cancel ok");
  ws.close();
}

// 2. A normal (scope:"device") phone token must NOT be able to mint pairing codes.
{
  const secret = "pairtest-" + Date.now();
  addPendingPair(secret, 5);
  const pr = await fetch(BASE + "/v1/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairSecret: secret, deviceName: "pairtest" }),
  });
  const pd = await pr.json();
  ok(pd.ok, "normal device paired via /v1/pair");
  const ws = await connect();
  await hello(ws, pd.deviceId, pd.token);
  const r = await rpc(ws, { type: "pairing.create", requestId: "p2" }, "pairing.create.result");
  ok(!r.ok && r.error?.code === "forbidden", "normal device is forbidden from minting (got " + (r.error?.code || "ok") + ")");
  ws.close();
}

console.log(`\n=== PAIRING ${fail === 0 ? "PASS" : "FAIL"} (${pass} ok, ${fail} bad) ===`);
process.exit(fail === 0 ? 0 : 1);
