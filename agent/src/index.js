#!/usr/bin/env node
// cordless CLI — `start`, `pair`, `devices`.
import { runPair } from "./pairing.js";
import { loadDevices, revokeDevice } from "./state.js";

const cmd = process.argv[2];

async function main() {
  switch (cmd) {
    case "start": {
      const { runServer } = await import("./server.js");
      await runServer();
      break;
    }
    case "pair":
      runPair();
      break;
    case "devices": {
      const sub = process.argv[3];
      if (sub === "revoke") {
        const id = process.argv[4];
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
      console.log(`cordless — remote terminal/agent session manager

  cordless start                     run the agent daemon (serves the app + websocket)
  cordless pair                      create a single-use pairing QR/code for a new device
  cordless devices                   list paired devices
  cordless devices revoke <id>       revoke a device's token

Config + state live in ~/.cordless (override with CORDLESS_HOME).`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
