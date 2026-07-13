// `cordless` subcommands that talk to the local daemon over the loopback client.
import { execFileSync, spawnSync } from "node:child_process";
import qrcode from "qrcode-terminal";
import { DaemonClient, ensureDaemon, health, daemonBaseUrl } from "./client.js";
import { attachSession } from "./attach.js";
import { loadConfig, loadDevices, loadWorkspaces, getWorkspace, saveWorkspace, deleteWorkspace } from "../state.js";
import { discoverHosts } from "../pairing.js";
import { runningPid } from "../service.js";
import { VERSION } from "../version.js";
import { attentionRank, needsAttention } from "./render.js";
import { Notifier } from "../notifier.js";

async function withClient(fn) {
  const { health: h, stale } = await ensureDaemon();
  if (stale) {
    console.error("cordless: an older daemon is running on this port. Run 'cordless stop' (or reboot), then retry.");
    process.exit(1);
  }
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

// Copy text to the OS clipboard (best effort, cross-platform). Returns true on success.
function copyToClipboard(text) {
  const tools = process.platform === "win32"
    ? [["clip", []]]
    : process.platform === "darwin"
      ? [["pbcopy", []]]
      : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]];
  for (const [cmd, args] of tools) {
    try {
      if (spawnSync(cmd, args, { input: text }).status === 0) return true;
    } catch {
      /* try the next tool */
    }
  }
  return false;
}

// `cordless output <session> [--lines N] [--copy]` — print (or copy) the last N lines of a session.
export async function runOutput(prefix, opts = {}) {
  if (!prefix) {
    console.error("usage: cordless output <session-id-or-prefix> [--lines N] [--copy]");
    process.exit(1);
  }
  await withClient(async (c) => {
    const id = await resolveId(c, prefix);
    const text = await c.tail(id, opts.lines || 50);
    if (opts.copy) {
      if (copyToClipboard(text)) console.log(`copied ${text.split("\n").length} lines to the clipboard.`);
      else {
        console.error("(no clipboard tool found; printing instead)\n");
        console.log(text);
      }
    } else {
      console.log(text);
    }
  });
}

// `cordless search <session> <query> [--limit N]` — search a session's retained scrollback.
export async function runSearch(prefix, query, opts = {}) {
  if (!prefix || !query) {
    console.error("usage: cordless search <session-id-or-prefix> <query> [--limit N]");
    process.exit(1);
  }
  await withClient(async (c) => {
    const id = await resolveId(c, prefix);
    const matches = await c.search(id, query, opts.limit || 200);
    if (!matches.length) {
      console.log(`no matches for "${query}" in the retained scrollback.`);
      return;
    }
    for (const m of matches) console.log(`${String(m.line).padStart(5)}: ${m.text}`);
    console.log(`\n${matches.length} match(es) (retained scrollback only).`);
  });
}

// `cordless group <list|new|rename|delete|assign>` — manage session (tab) groups.
export async function runGroup(sub, a, b) {
  const resolveGroup = (groups, prefix) => {
    const m = groups.filter((g) => g.id === prefix || g.id.startsWith(prefix) || g.name.toLowerCase() === String(prefix).toLowerCase());
    if (m.length === 1) return m[0];
    if (m.length > 1) throw new Error(`ambiguous group "${prefix}"`);
    throw new Error(`no group matches "${prefix}"`);
  };
  await withClient(async (c) => {
    const action = sub || "list";
    if (action === "list") {
      const groups = await c.listGroups();
      const sessions = await c.listSessions();
      if (!groups.length) {
        console.log("no groups yet. Create one with: cordless group new <name> [color]");
        return;
      }
      console.log("");
      for (const g of groups) {
        const members = sessions.filter((s) => s.groupId === g.id);
        console.log(`  ${g.id.slice(0, 8)}  ${String(g.name).padEnd(20)} ${String(g.color).padEnd(7)} ${members.length} session(s)`);
      }
      console.log("");
      return;
    }
    if (action === "new" || action === "create") {
      const g = await c.createGroup(a || "Group", b);
      console.log(`created group "${g.name}" (${g.id.slice(0, 8)}, ${g.color}).`);
      return;
    }
    if (action === "rename") {
      const g = resolveGroup(await c.listGroups(), a);
      const r = await c.renameGroup(g.id, b || "");
      console.log(`renamed group -> "${r.name}".`);
      return;
    }
    if (action === "color") {
      const g = resolveGroup(await c.listGroups(), a);
      const r = await c.setGroupColor(g.id, b);
      console.log(`group "${r.name}" color -> ${r.color}.`);
      return;
    }
    if (action === "delete" || action === "rm") {
      const g = resolveGroup(await c.listGroups(), a);
      await c.deleteGroup(g.id);
      console.log(`deleted group "${g.name}" (its sessions are now ungrouped).`);
      return;
    }
    if (action === "assign") {
      const id = await resolveId(c, a);
      let gid = null;
      if (b && !["none", "null", "-"].includes(String(b).toLowerCase())) gid = resolveGroup(await c.listGroups(), b).id;
      await c.assignSession(id, gid);
      console.log(gid ? `assigned ${id.slice(0, 8)} to the group.` : `ungrouped ${id.slice(0, 8)}.`);
      return;
    }
    console.error("usage: cordless group <list|new|rename|color|delete|assign> [args]");
    process.exit(1);
  });
}

// `cordless profiles [show <name>]` — list the effective launchers (built-ins + your custom ones).
export async function runProfiles(sub, name) {
  await withClient(async (c) => {
    const profiles = await c.profiles();
    if (sub === "show") {
      const p = profiles.find((x) => x.name === name);
      if (!p) {
        console.error(`no profile named "${name}". Run 'cordless profiles'.`);
        process.exit(1);
      }
      console.log("");
      console.log(`  ${p.name}   ${p.available ? "" : "(unavailable)"}`);
      console.log(`    source     ${p.source}`);
      console.log(`    kind       ${p.kind}`);
      if (p.command) console.log(`    command    ${p.command}${p.resolved ? "  -> " + p.resolved : ""}`);
      if (p.reason) console.log(`    note       ${p.reason}`);
      console.log("");
      return;
    }
    console.log("\nlaunch profiles  (cordless new <name>)\n");
    for (const p of profiles) {
      const mark = p.available ? " " : "!";
      const src = p.source === "built-in" ? "" : `[${p.source}]`;
      const note = p.available ? "" : `  \u2014 ${p.reason}`;
      console.log(`  ${mark} ${p.name.padEnd(14)} ${String(p.label).padEnd(16)} ${src}${note}`);
    }
    console.log('\n  add your own under "profiles" in ~/.cordless/config.json, e.g.');
    console.log('    "profiles": { "copilot": { "command": "copilot", "attentionPreset": "agent" } }\n');
  });
}

// `cordless history [status|clear] [session] [--all]` — inspect or clear persisted session history.
export async function runHistory(sub, prefix, opts = {}) {
  const action = sub || "status";
  await withClient(async (c) => {
    if (action === "status" || action === "list") {
      const items = await c.historyList();
      if (!items.length) {
        console.log("no persisted session history on disk.");
        return;
      }
      console.log("\npersisted history (survives a daemon restart):\n");
      for (const it of items) {
        console.log(`  ${it.sessionId.slice(0, 8)}  ${(it.state || "gone").padEnd(8)} ${it.title || ""}`);
      }
      console.log(`\n  ${items.length} file(s) under ~/.cordless/history. Clear with: cordless history clear <id>|--all\n`);
      return;
    }
    if (action === "clear") {
      if (!prefix && !opts.all) {
        console.error("usage: cordless history clear <session-id-or-prefix> | --all");
        process.exit(1);
      }
      let id = null;
      if (prefix && !opts.all) {
        // Try the live session list first, then fall back to prefix-matching the on-disk files
        // (so history for an already-gone session can still be cleared by id prefix).
        id = await resolveId(c, prefix).catch(() => null);
        if (!id) {
          const match = (await c.historyList()).filter((it) => it.sessionId.startsWith(prefix));
          if (match.length === 1) id = match[0].sessionId;
          else if (match.length > 1) {
            console.error(`ambiguous prefix "${prefix}" — matches ${match.length} history files.`);
            process.exit(1);
          } else {
            console.error(`no persisted history matches "${prefix}".`);
            process.exit(1);
          }
        }
      }
      const cleared = await c.historyClear(opts.all ? null : id);
      console.log(`cleared ${cleared} history file(s).`);
      return;
    }
    console.error("usage: cordless history [status|clear] [session] [--all]");
    process.exit(1);
  });
}

// `cordless workspace save|open|list|delete <name>` — named session templates.
// A workspace snapshots the running sessions' profile + cwd + title so you can reopen a whole
// project layout (e.g. "Claude on api, Codex on web, a tests shell") with one command.
export async function runWorkspace(sub, name) {
  if (sub === "list" || !sub) {
    const all = loadWorkspaces();
    const names = Object.keys(all);
    if (!names.length) {
      console.log("no workspaces \u2014 create one with: cordless workspace save <name>");
      return;
    }
    for (const n of names) {
      const ws = all[n];
      console.log(`${n.padEnd(20)} ${ws.sessions.length} session(s)  ${ws.sessions.map((s) => s.profile).join(", ")}`);
    }
    return;
  }
  if (sub === "delete") {
    if (!name) return usageWorkspace();
    console.log(deleteWorkspace(name) ? `deleted workspace '${name}'` : `no such workspace: ${name}`);
    return;
  }
  if (sub === "save") {
    if (!name) return usageWorkspace();
    await withClient(async (c) => {
      const running = (await c.listSessions()).filter((s) => s.state === "running");
      const sessions = running.map((s) => ({ profile: s.profile, cwd: s.cwd, title: s.title }));
      saveWorkspace(name, { sessions });
      console.log(`saved workspace '${name}' with ${sessions.length} session(s).`);
    });
    return;
  }
  if (sub === "open") {
    if (!name) return usageWorkspace();
    const ws = getWorkspace(name);
    if (!ws) {
      console.error(`no such workspace: ${name}`);
      process.exit(1);
    }
    await withClient(async (c) => {
      let n = 0;
      for (const t of ws.sessions) {
        try {
          await c.createSession(t.profile || "shell", { cwd: t.cwd, title: t.title });
          n++;
        } catch (e) {
          console.error(`  ! failed to start ${t.profile} in ${t.cwd}: ${e.message}`);
        }
      }
      console.log(`opened workspace '${name}': started ${n}/${ws.sessions.length} session(s). Run \`cordless\` to see them.`);
    });
    return;
  }
  usageWorkspace();
}

function usageWorkspace() {
  console.error("usage: cordless workspace <save|open|list|delete> [name]");
  process.exit(1);
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

// `cordless rename <id> <title...>` — retitle a session's tab (empty restores the default).
export async function runRename(prefix, title) {
  if (!prefix) {
    console.error('usage: cordless rename <session-id-or-prefix> <new title>   (empty title = reset to default)');
    process.exit(1);
  }
  await withClient(async (c) => {
    const id = await resolveId(c, prefix);
    const res = await c.renameSession(id, title || "");
    console.log(`renamed ${id.slice(0, 8)} -> "${res.title}"`);
  });
}

// `cordless attach [id]` — attach to a session. With no id, resume the most-recently-active one.
export async function runAttach(prefix) {
  const { health: h, stale } = await ensureDaemon();
  if (stale) {
    console.error("cordless: an older daemon is running on this port. Run 'cordless stop' (or reboot), then retry.");
    process.exit(1);
  }
  if (!h) {
    console.error("cordless: daemon not running.");
    process.exit(1);
  }
  const probe = new DaemonClient();
  await probe.connect();
  let id;
  try {
    if (prefix) {
      id = await resolveId(probe, prefix);
    } else {
      // Resume: the most-recently-active running session.
      const running = (await probe.listSessions()).filter((s) => s.state === "running");
      if (!running.length) {
        probe.close();
        console.error("cordless: no running sessions to resume — start one with `cordless new` or `cordless`.");
        process.exit(1);
      }
      running.sort((a, b) => new Date(b.lastActivityAt || 0) - new Date(a.lastActivityAt || 0));
      id = running[0].sessionId;
    }
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

// `cordless notify status|test` — inspect or validate notification config (secrets redacted).
export async function runNotify(sub) {
  const n = loadConfig().notifications || {};
  if (!sub || sub === "status") {
    const redact = (v) => (v ? "\u2026(set)" : "(unset)");
    console.log("\nnotifications\n");
    console.log("  enabled   ", n.enabled ? "yes" : "no");
    console.log("  provider  ", n.provider || "ntfy");
    if ((n.provider || "ntfy") === "webhook") console.log("  webhook   ", redact(n.webhookUrl));
    else {
      console.log("  url       ", n.url || "https://ntfy.sh");
      console.log("  topic     ", redact(n.topic));
    }
    console.log("  events    ", (n.events || ["prompt", "bell", "finished"]).join(", "));
    console.log("  token     ", n.token ? "(set)" : "(none)");
    console.log("  quietHours", n.quietHours ? `${n.quietHours.start}\u2013${n.quietHours.end}` : "(none)");
    console.log('\n  configure in ~/.cordless/config.json under "notifications", then: cordless notify test\n');
    return;
  }
  if (sub === "test") {
    try {
      await new Notifier(n).sendTest();
      console.log("sent a test notification via " + (n.provider || "ntfy") + " \u2014 check your device.");
    } catch (e) {
      console.error("test notification failed:", e.message || e);
      process.exit(1);
    }
    return;
  }
  console.error("usage: cordless notify [status|test]");
  process.exit(1);
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
