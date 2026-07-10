// Security checks against the running daemon.
import { WebSocket } from "ws";
const BASE = "http://127.0.0.1:7443";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m); } };

// 1. security headers on served HTML
const r = await fetch(BASE + "/");
ok(/script-src 'self'/.test(r.headers.get("content-security-policy") || ""), "CSP script-src 'self' present");
ok((r.headers.get("x-content-type-options") || "") === "nosniff", "X-Content-Type-Options nosniff");
ok((r.headers.get("x-frame-options") || "") === "DENY", "X-Frame-Options DENY");
ok((r.headers.get("cache-control") || "").includes("no-store"), "index.html no-store");

// 2. health no-store
const h = await fetch(BASE + "/v1/health");
ok((h.headers.get("cache-control") || "").includes("no-store"), "health no-store");

// 3. cross-origin pairing rejected (403)
const p = await fetch(BASE + "/v1/pair", {
  method: "POST",
  headers: { "content-type": "application/json", Origin: "http://evil.example" },
  body: JSON.stringify({ pairSecret: "x", deviceName: "evil" }),
});
ok(p.status === 403, "cross-origin pair rejected (403), got " + p.status);

// 4. same-origin bogus pairing still reaches auth logic (401, not 403)
const p2 = await fetch(BASE + "/v1/pair", {
  method: "POST",
  headers: { "content-type": "application/json", Origin: BASE },
  body: JSON.stringify({ pairSecret: "definitely-wrong", deviceName: "x" }),
});
ok(p2.status === 401, "same-origin bogus pair -> 401, got " + p2.status);

// 5. cross-origin WS upgrade rejected
const wsResult = await new Promise((resolve) => {
  const ws = new WebSocket(BASE.replace("http", "ws") + "/v1/ws", { origin: "http://evil.example" });
  ws.on("open", () => { ws.terminate(); resolve("opened"); });
  ws.on("error", () => resolve("rejected"));
  setTimeout(() => resolve("timeout"), 3000);
});
ok(wsResult === "rejected", "cross-origin WS rejected, got " + wsResult);

// 6. no-origin WS (native/CLI) still allowed to open
const wsNative = await new Promise((resolve) => {
  const ws = new WebSocket(BASE.replace("http", "ws") + "/v1/ws");
  ws.on("open", () => { ws.terminate(); resolve("opened"); });
  ws.on("error", () => resolve("rejected"));
  setTimeout(() => resolve("timeout"), 3000);
});
ok(wsNative === "opened", "no-origin WS allowed, got " + wsNative);

console.log(`\n=== SECURITY ${fail === 0 ? "PASS" : "FAIL"} (${pass} ok, ${fail} bad) ===`);
setTimeout(() => process.exit(fail === 0 ? 0 : 1), 200);
