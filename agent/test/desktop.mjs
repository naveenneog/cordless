// Verify the desktop loopback credential authenticates over 127.0.0.1.
import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";

const HOME = process.env.CORDLESS_HOME;
const cred = JSON.parse(fs.readFileSync(path.join(HOME, "desktop-credential.json"), "utf8"));
console.log("credential:", JSON.stringify({ deviceId: cred.deviceId.slice(0, 8), server: cred.server, hasToken: !!cred.token }));

const ws = new WebSocket("ws://127.0.0.1:7443/v1/ws");
const done = (msg, code) => { console.log(msg); try { ws.close(); } catch {} setTimeout(() => process.exit(code), 150); };
ws.on("open", () => ws.send(JSON.stringify({ type: "hello", requestId: "r1", deviceId: cred.deviceId, token: cred.token })));
ws.on("message", (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === "hello.result") done(m.ok ? "=== DESKTOP-CRED AUTH PASS ===" : "=== FAIL: " + JSON.stringify(m.error) + " ===", m.ok ? 0 : 1);
});
ws.on("error", (e) => done("ws error " + e.message, 1));
setTimeout(() => done("timeout", 1), 5000);
