// Unit-check: loopback-scoped token is accepted from 127.0.0.1/::1 but rejected from a public IP.
import fs from "node:fs";
import path from "node:path";
import { authenticate } from "../src/auth.js";

const HOME = process.env.CORDLESS_HOME;
const cred = JSON.parse(fs.readFileSync(path.join(HOME, "desktop-credential.json"), "utf8"));

const cases = [
  ["127.0.0.1", true],
  ["::1", true],
  ["::ffff:127.0.0.1", true],
  ["203.0.113.5", false],
  ["100.64.1.2", false], // tailscale CGNAT range — still not loopback
];
let ok = true;
for (const [ip, expect] of cases) {
  const got = !!authenticate(cred.deviceId, cred.token, ip);
  const pass = got === expect;
  if (!pass) ok = false;
  console.log(`${pass ? "ok  " : "FAIL"}  ip=${ip.padEnd(20)} authed=${got} (expected ${expect})`);
}
console.log(ok ? "=== LOOPBACK-SCOPE ENFORCEMENT PASS ===" : "=== LOOPBACK-SCOPE ENFORCEMENT FAIL ===");
process.exit(ok ? 0 : 1);
