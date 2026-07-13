#!/usr/bin/env node
// cordless CLI. `cordless` with no arguments opens the dashboard.
import { loadDevices, revokeDevice } from "./state.js";
import { installService, uninstallService, stopDaemon, status, runningPid, writePid, startDaemonDetached } from "./service.js";
import { VERSION } from "./version.js";
import { topLevelHelp, commandHelp, findCommand } from "./cli/help.js";

const cmd = process.argv[2];
const args = process.argv.slice(3);

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

  // `cordless <command> --help|-h` -> that command's detailed help (bare --help handled by the switch).
  if (cmd !== "--help" && cmd !== "-h" && (args.includes("--help") || args.includes("-h"))) {
    const detail = commandHelp(cmd);
    if (detail) {
      console.log(detail);
      return;
    }
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
      const positional = args.find((a) => !a.startsWith("-"));
      const newWindow = args.includes("--new-window") || args.includes("--tab") || args.includes("-w");
      await runAttach(positional, { newWindow });
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
        noStart: args.includes("--no-start"),
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
    case "-h": {
      const topic = args.find((a) => !a.startsWith("-"));
      if (topic) {
        const detail = commandHelp(topic);
        console.log(detail || `cordless: no help topic for '${topic}'.\n\n` + topLevelHelp());
      } else {
        console.log(topLevelHelp());
      }
      break;
    }
    default:
      if (findCommand(cmd)) {
        // A known command reached default only via a bad sub-usage; show its help.
        console.log(commandHelp(cmd));
      } else {
        console.error(`cordless: unknown command '${cmd}'.\n`);
        console.log(topLevelHelp());
        process.exitCode = 1;
      }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
