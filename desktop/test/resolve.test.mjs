// Unit tests for the desktop credential/origin parsing (security-critical).
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { validateLocalServer, resolveOrigin, sanitizeCredential } = require("../lib/resolve.js");

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log("FAIL:", msg); } };
const throws = (fn, msg) => { try { fn(); fail++; console.log("FAIL (no throw):", msg); } catch { pass++; } };

// validateLocalServer — accepts loopback http only
ok(validateLocalServer("http://127.0.0.1:7443") === "http://127.0.0.1:7443", "accepts 127.0.0.1:7443");
ok(validateLocalServer("http://127.0.0.1:9000") === "http://127.0.0.1:9000", "keeps custom port");
ok(validateLocalServer("http://127.0.0.1") === "http://127.0.0.1:7443", "defaults port when absent");
ok(validateLocalServer("http://127.0.0.1:7443/") === "http://127.0.0.1:7443", "trailing slash ok");
throws(() => validateLocalServer("https://127.0.0.1:7443"), "rejects https");
throws(() => validateLocalServer("http://100.64.1.2:7443"), "rejects tailscale IP");
throws(() => validateLocalServer("http://evil.example:7443"), "rejects public host");
throws(() => validateLocalServer("http://localhost:7443"), "rejects localhost name (ambiguous)");
throws(() => validateLocalServer("http://user:pw@127.0.0.1:7443"), "rejects userinfo");
throws(() => validateLocalServer("http://127.0.0.1:7443/steal"), "rejects path");
throws(() => validateLocalServer("ws://127.0.0.1:7443"), "rejects ws scheme");
throws(() => validateLocalServer("file:///etc/passwd"), "rejects file scheme");

// sanitizeCredential — shape + caps, and server falls back on bad input
ok(sanitizeCredential(null, "http://127.0.0.1:7443") === null, "null cred -> null");
ok(sanitizeCredential({ deviceId: "d", token: "t" }, "http://127.0.0.1:7443").server === "http://127.0.0.1:7443", "no server -> fallback");
ok(sanitizeCredential({ deviceId: "d", token: "t", server: "http://127.0.0.1:9000" }, "http://127.0.0.1:7443").server === "http://127.0.0.1:9000", "valid server passes through");
ok(sanitizeCredential({ deviceId: "d", token: "t", server: "https://evil" }, "http://127.0.0.1:7443").server === "http://127.0.0.1:7443", "bad server -> fallback");
ok(sanitizeCredential({ deviceId: "d" }, "x") === null, "missing token -> null");
ok(sanitizeCredential({ deviceId: "x".repeat(201), token: "t" }, "x") === null, "oversized deviceId -> null");
ok(sanitizeCredential({ deviceId: "d", token: "t".repeat(4097) }, "x") === null, "oversized token -> null");
{
  const c = sanitizeCredential({ deviceId: "d", token: "t", extra: "nope", server: "http://127.0.0.1:7443" }, "x");
  ok(!("extra" in c), "strips unknown fields");
}

// resolveOrigin precedence
{
  const home = path.join(os.tmpdir(), "cordless-desktop-test-" + crypto.randomBytes(3).toString("hex"));
  fs.mkdirSync(home, { recursive: true });
  ok(resolveOrigin(home) === "http://127.0.0.1:7443", "empty home -> default");
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ port: 8123 }));
  ok(resolveOrigin(home) === "http://127.0.0.1:8123", "config.port used when no credential");
  fs.writeFileSync(path.join(home, "desktop-credential.json"), JSON.stringify({ deviceId: "d", token: "t", server: "http://127.0.0.1:9443" }));
  ok(resolveOrigin(home) === "http://127.0.0.1:9443", "credential.server wins over config");
  fs.writeFileSync(path.join(home, "desktop-credential.json"), JSON.stringify({ deviceId: "d", token: "t", server: "https://evil.example" }));
  ok(resolveOrigin(home) === "http://127.0.0.1:8123", "bad credential.server falls back to config");
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(`\n=== DESKTOP RESOLVE ${fail === 0 ? "PASS" : "FAIL"} (${pass} ok, ${fail} bad) ===`);
process.exit(fail === 0 ? 0 : 1);
