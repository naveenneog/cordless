// `cordless` subcommands that talk to the local daemon over the loopback client.
import { execFileSync } from "node:child_process";
import qrcode from "qrcode-terminal";
import { DaemonClient, ensureDaemon, health, daemonBaseUrl } from "./client.js";
import { attachSession } from "./attach.js";
import { loadConfig, loadDevices } from "../state.js";
import { discoverHosts } from "../pairing.js";
import { runningPid } from "../service.js";
import { VERSION } from "../version.js";
import { attentionRank, needsAttention } from "./render.js";

async function withClient(fn) {
  const { health: h } = await ensureDaemon();
  if (!h) {
    console.error("cordless: could not reach or start the daemon (see ~/.cordless/daemon.log).");
    process.exit(1);
  }
  const c = new DaemonClient();
  await c.connect();
  try {
    return await fn(c);
  } finally {
    c.close();
  }
}

async function resolveId(c, prefix) {
  const list = await c.listSessions();
  const matches = list.filter((s) => s.sessionId === prefix || s.sessionId.startsWith(prefix));
  if (matches.length === 1) return matches[0].sessionId;
  if (!matches.length) throw new Error("no session matching '" + prefix + "'");
  throw new Error("ambiguous session prefix '" + prefix + "' (matches " + matches.length + ")");
}

// `cordless pair` — leave an active single-use code + QR for the phone to redeem.
export async function runPair() {
  await withClient(async (c) => {
    const r = await c.pairingCreate({ allowLan: true });
    if (!r.ok) {
      console.error("cordless: pairing failed:", (r.error && r.error.message) || "error");
      process.exit(1);
    }
    const primary = r.preferredUrl || (r.urls && r.urls[0]);
    console.log("\n  cordless \u2014 pair a new device  (valid 5 min, single use)\n");
    if (primary) qrcode.generate(primary, { small: true });
    else console.log("  (no Tailscale/LAN address found \u2014 connect this machine to a network, then retry)\n");
    console.log("\n  \u2022 In the cordless app: tap Scan QR and scan the code above.");
    if (r.urls && r.urls.length) {
      console.log("  \u2022 Or open one of these in your phone browser (PWA):\n");
      for (const u of r.urls) console.log("      " + u);
    }
    console.log(`\n  Manual pairing code: ${r.code}\n`);
  });
}

export async function runSessions(opts = {}) {
  await withClient(async (c) => {
    let list = await c.listSessions();
    if (opts.attention) list = list.filter(needsAttention);
    list.sort((a, b) => attentionRank(a) - attentionRank(b));
    if (!list.length) {
      console.log(opts.attention ? "no sessions need attention." : "no sessions \u2014 run `cordless new` or open the dashboard with `cordless`.");
      return;
    }
    for (const s of list) {
      const status = s.attention ? s.attention.toUpperCase() : s.activity || s.state || "";
      console.log(`${s.sessionId.slice(0, 8)}  ${(s.profile || "shell").padEnd(7)} ${String(status).padEnd(9)} ${s.title || s.cwd || ""}`);
    }
  });
}

export async function runNew(profile = "shell", opts = {}) {
  await withClient(async (c) => {
    const id = await c.createSession(profile, opts);
    console.log(`started ${profile} (${id.slice(0, 8)}). Attach with: cordless attach ${id.slice(0, 8)}`);
  });
}

export async function runKill(prefix) {
  if (!prefix) {
    console.error("usage: cordless kill <session-id-or-prefix>");
    process.exit(1);
  }
  await withClient(async (c) => {
    const id = await resolveId(c, prefix);
    await c.killSession(id, "graceful");
    console.log("killed", id.slice(0, 8));
  });
}

export async function runAttach(prefix) {
  if (!prefix) {
    console.error("usage: cordless attach <session-id-or-prefix>");
    process.exit(1);
  }
  const { health: h } = await ensureDaemon();
  if (!h) {
    console.error("cordless: daemon not running.");
    process.exit(1);
  }
  const probe = new DaemonClient();
  await probe.connect();
  let id;
  try {
    id = await resolveId(probe, prefix);
  } catch (e) {
    probe.close();
    console.error("cordless:", e.message);
    process.exit(1);
  }
  probe.close();
  console.log(`attaching to ${id.slice(0, 8)} \u2014 detach with Ctrl-] then d\n`);
  const reason = await attachSession(id);
  if (reason === "detach") console.log("\n[detached]");
  else if (reason === "disconnected") console.log("\n[disconnected]");
}

function commandOnPath(cmd) {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export async function runDoctor() {
  const base = daemonBaseUrl();
  const h = await health(base);
  const cfg = loadConfig();
  const { tailscale, lan } = discoverHosts();
  const line = (label, val) => console.log(`  ${label.padEnd(12)} ${val}`);
  console.log("\ncordless doctor\n");
  line("cli", "v" + VERSION);
  line("daemon", h ? `running  (v${h.version || "?"}, protocol ${h.protocol})` : "NOT running \u2014 run `cordless` or `cordless start`");
  line("pid", runningPid() || "\u2014");
  line("endpoint", base);
  line("port", cfg.port + (cfg.bindHost ? `  bind ${cfg.bindHost}` : ""));
  line("tailscale", tailscale.length ? tailscale.join(", ") : "not detected \u2014 install Tailscale to reach from your phone");
  line("lan", lan.length ? lan.join(", ") : "none");
  line("devices", loadDevices().filter((d) => !d.revokedAt).length + " paired");
  for (const [name, p] of Object.entries(cfg.profiles || {})) {
    if (p.initCommand) line("profile " + name, commandOnPath(p.initCommand) ? `${p.initCommand} \u2713 on PATH` : `${p.initCommand} \u2717 NOT found on PATH`);
  }
  console.log("");
}
