// `cordless pair` — mint a single-use pairing secret and show a QR the phone can open.
// The QR/URL carries the pairing secret in the URL *fragment* (never sent to the server, stays
// client-side). The client exchanges it at POST /v1/pair for a permanent per-device token.
import os from "node:os";
import { execSync } from "node:child_process";
import qrcode from "qrcode-terminal";
import { randomToken, addPendingPair, loadConfig } from "./state.js";

function tailscaleHosts() {
  const hosts = [];
  try {
    const ip = execSync("tailscale ip -4", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim()
      .split(/\r?\n/)[0]
      ?.trim();
    if (ip) hosts.push(ip);
  } catch {
    /* tailscale not installed */
  }
  try {
    const json = JSON.parse(
      execSync("tailscale status --json", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    );
    const dns = json?.Self?.DNSName?.replace(/\.$/, "");
    if (dns) hosts.push(dns);
  } catch {
    /* ignore */
  }
  return hosts;
}

function lanHosts() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const ni of ifs[name] || []) {
      if (ni.family === "IPv4" && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

export function runPair() {
  const cfg = loadConfig();
  const secret = randomToken();
  addPendingPair(secret, 15);

  const ts = tailscaleHosts();
  const lan = lanHosts();
  const hosts = [...ts, ...lan];
  const port = cfg.port;
  const primary = hosts[0] || "localhost";
  const mkUrl = (h) => `http://${h}:${port}/#pair=${secret}`;
  const mkDeep = (h) => `cordless://pair?server=${encodeURIComponent(`http://${h}:${port}`)}#pair=${secret}`;

  console.log("\n  cordless — pair a new device  (valid 15 min, single use)\n");
  qrcode.generate(mkUrl(primary), { small: true });
  console.log("\n  • In the cordless app: tap “Scan QR” and scan the code above.");
  console.log("  • Or open one of these URLs in your phone's browser (PWA):\n");
  for (const h of hosts) console.log(`      ${mkUrl(h)}`);
  if (!hosts.length) console.log(`      ${mkUrl("localhost")}`);
  console.log(`\n  Manual pairing code: ${secret}`);
  console.log(`  App deep link:       ${mkDeep(primary)}\n`);
  if (!ts.length) {
    console.log("  Tip: install Tailscale on this box + your phone to reach it securely from anywhere.");
    console.log("       Then re-run `cordless pair` to get a *.ts.net URL.\n");
  }
}
