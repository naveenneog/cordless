#!/usr/bin/env node
// cordless CLI.
import { runPair } from "./pairing.js";
import { loadDevices, revokeDevice } from "./state.js";
import { installService, uninstallService, stopDaemon, status, runningPid, writePid } from "./service.js";

const cmd = process.argv[2];
const args = process.argv.slice(3);

async function main() {
  switch (cmd) {
    case "start": {
      const foreground = args.includes("--foreground") || args.includes("-f");
      const existing = runningPid();
      if (existing) {
        console.error(`cordless is already running (pid ${existing}). Use 'cordless stop' first.`);
        process.exit(1);
      }
      writePid();
      const { runServer } = await import("./server.js");
      await runServer();
      void foreground;
      break;
    }
    case "stop":
      stopDaemon();
      break;
    case "status":
      status();
      break;
    case "pair":
      runPair();
      break;
    case "install":
      installService();
      break;
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
    default:
      console.log(`cordless — remote terminal / coding-agent session manager

  cordless start [--foreground]      run the agent daemon (serves the app + websocket)
  cordless stop                      stop the running daemon
  cordless status                    is the daemon running?
  cordless pair                      create a single-use pairing QR/code for a new device
  cordless devices                   list paired devices
  cordless devices revoke <id>       revoke a device's token
  cordless install                   run the daemon automatically at login (auto-start)
  cordless uninstall [--purge]       remove the auto-start registration

Config + state live in ~/.cordless (override with CORDLESS_HOME).`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
