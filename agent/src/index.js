#!/usr/bin/env node
// cordless CLI. `cordless` with no arguments opens the dashboard.
import { loadDevices, revokeDevice } from "./state.js";
import { installService, uninstallService, stopDaemon, status, runningPid, writePid, startDaemonDetached } from "./service.js";
import { VERSION } from "./version.js";

const cmd = process.argv[2];
const args = process.argv.slice(3);

const HELP = `cordless v${VERSION} — remote terminal / coding-agent session manager

  cordless                       open the dashboard (status + pairing QR + sessions)
  cordless --once                print one dashboard frame and exit (non-interactive)

  cordless start [--foreground]  start the daemon (detached by default)
  cordless stop                  stop the running daemon
  cordless status                is the daemon running?
  cordless doctor                diagnose daemon / Tailscale / firewall / profiles
  cordless notify [status|test]  show or test attention notifications (ntfy / webhook)

  cordless pair                  show a single-use pairing QR/code for a new device
  cordless devices               list paired devices
  cordless devices revoke <id>   revoke a device's token

  cordless sessions              list sessions
  cordless new [shell|claude|codex|<profile>] [--cwd <dir>] [--title <t>]
  cordless attach [id]           attach to a session (no id = resume the most recent; detach: Ctrl-] d)
  cordless resume                jump back into your most-recently-active session
  cordless output <id> [--lines N] [--copy]   print/copy a session's last output
  cordless search <id> <query>   search a session's retained scrollback
  cordless kill <id>             stop a session
  cordless rename <id> <title>   retitle a session's tab (empty = reset to default)
  cordless profiles [show <name>]   list launch profiles (built-in + your custom ones)
  cordless group <list|new|rename|delete|assign> [args]   session tab groups
  cordless workspace <save|open|list|delete> [name]   named session templates
  cordless history [status|clear] [id] [--all]   persisted scrollback (survives restart)

  cordless install               start the daemon automatically at login
  cordless setup [--uninstall]   install cordless to a stable path + PATH + autostart (or remove)
  cordless uninstall [--purge]   remove the auto-start registration

Config + state live in ~/.cordless (override with CORDLESS_HOME).`;

function optValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

async function main() {
  // `cordless` (no command) or `cordless --once` -> dashboard
  if (!cmd || cmd === "--once" || cmd === "-1") {
    const { runDashboard } = await import("./cli/dashboard.js");
    await runDashboard({ once: cmd === "--once" || cmd === "-1" });
    return;
  }

  switch (cmd) {
    case "start": {
      const foreground = args.includes("--foreground") || args.includes("-f");
      const existing = runningPid();
      if (existing) {
        console.log(`cordless is already running (pid ${existing}).`);
        return;
      }
      if (foreground) {
        writePid();
        const { runServer } = await import("./server.js");
        await runServer();
      } else {
        const pid = startDaemonDetached();
        console.log(`cordless daemon started (pid ${pid}). Run 'cordless' for the dashboard.`);
      }
      break;
    }
    case "stop":
      stopDaemon();
      break;
    case "status":
      status();
      break;
    case "doctor": {
      const { runDoctor } = await import("./cli/commands.js");
      await runDoctor();
      break;
    }
    case "notify": {
      const { runNotify } = await import("./cli/commands.js");
      await runNotify(args[0]);
      break;
    }
    case "pair": {
      const { runPair } = await import("./cli/commands.js");
      await runPair();
      break;
    }
    case "sessions": {
      const { runSessions } = await import("./cli/commands.js");
      await runSessions({ attention: args.includes("--attention") || args.includes("-a") });
      break;
    }
    case "new": {
      const { runNew } = await import("./cli/commands.js");
      const profile = args[0] && !args[0].startsWith("-") ? args[0] : "shell";
      const opts = {};
      const cwd = optValue("--cwd");
      const title = optValue("--title");
      if (cwd) opts.cwd = cwd;
      if (title) opts.title = title;
      await runNew(profile, opts);
      break;
    }
    case "attach":
    case "resume": {
      const { runAttach } = await import("./cli/commands.js");
      await runAttach(args[0]);
      break;
    }
    case "output": {
      const { runOutput } = await import("./cli/commands.js");
      const lines = optValue("--lines") || optValue("-n");
      await runOutput(args[0] && !args[0].startsWith("-") ? args[0] : undefined, {
        lines: lines ? parseInt(lines, 10) : undefined,
        copy: args.includes("--copy"),
      });
      break;
    }
    case "search": {
      const { runSearch } = await import("./cli/commands.js");
      const limit = optValue("--limit");
      const positionals = args.filter((a) => !a.startsWith("-"));
      await runSearch(positionals[0], positionals.slice(1).join(" "), { limit: limit ? parseInt(limit, 10) : undefined });
      break;
    }
    case "kill": {
      const { runKill } = await import("./cli/commands.js");
      await runKill(args[0]);
      break;
    }
    case "rename": {
      const { runRename } = await import("./cli/commands.js");
      const positionals = args.filter((a) => !a.startsWith("-"));
      await runRename(positionals[0], positionals.slice(1).join(" "));
      break;
    }
    case "workspace":
    case "ws": {
      const { runWorkspace } = await import("./cli/commands.js");
      await runWorkspace(args[0], args[1]);
      break;
    }
    case "history": {
      const { runHistory } = await import("./cli/commands.js");
      const positionals = args.filter((a) => !a.startsWith("-"));
      await runHistory(positionals[0], positionals[1], { all: args.includes("--all") });
      break;
    }
    case "profiles": {
      const { runProfiles } = await import("./cli/commands.js");
      const positionals = args.filter((a) => !a.startsWith("-"));
      await runProfiles(positionals[0], positionals[1]);
      break;
    }
    case "group":
    case "groups": {
      const { runGroup } = await import("./cli/commands.js");
      const positionals = args.filter((a) => !a.startsWith("-"));
      await runGroup(positionals[0], positionals[1], positionals.slice(2).join(" ") || positionals[2]);
      break;
    }
    case "install":
      installService();
      break;
    case "setup": {
      const { runSetup } = await import("./cli/setup.js");
      runSetup({
        dir: optValue("--dir"),
        noAutostart: args.includes("--no-autostart"),
        noPath: args.includes("--no-path"),
        pathOnly: args.includes("--path-only"),
        dryRun: args.includes("--dry-run"),
        uninstall: args.includes("--uninstall"),
        purge: args.includes("--purge"),
        copyOnly: args.includes("--copy-only"),
      });
      break;
    }
    case "uninstall": {
      uninstallService();
      if (args.includes("--purge")) {
        const { HOME } = await import("./state.js");
        console.log(`(--purge) config/tokens kept at ${HOME}; delete that folder manually to fully remove.`);
      }
      break;
    }
    case "devices": {
      const sub = args[0];
      if (sub === "revoke") {
        const id = args[1];
        if (!id) {
          console.error("usage: cordless devices revoke <deviceId>");
          process.exit(1);
        }
        console.log(revokeDevice(id) ? `revoked ${id}` : `device not found: ${id}`);
      } else {
        const list = loadDevices();
        if (!list.length) {
          console.log("no paired devices — run `cordless pair`");
          break;
        }
        for (const d of list) {
          const flag = d.revokedAt ? "[revoked] " : "";
          console.log(
            `${flag}${d.deviceId}  "${d.deviceName}"  paired ${d.createdAt}  lastSeen ${d.lastSeenAt || "never"}`
          );
        }
      }
      break;
    }
    case "version":
    case "--version":
    case "-v":
      console.log("cordless v" + VERSION);
      break;
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      break;
    default:
      console.log(HELP);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
