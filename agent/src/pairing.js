// Host discovery for phone pairing. The QR/URL carries the pairing secret in the URL *fragment*
// (never sent to the server). Pairing itself is minted by the daemon (pairing.create); this module
// only discovers the reachable addresses, shared by the daemon and the `cordless pair` CLI.
import os from "node:os";
import { execSync } from "node:child_process";

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

// Reachable hosts for phone pairing, Tailscale first. Shared by `cordless pair` and the daemon's
// authenticated pairing.create (so the dashboard and CLI show consistent URLs).
export function discoverHosts() {
  return { tailscale: tailscaleHosts(), lan: lanHosts() };
}
