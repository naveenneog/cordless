Major redesign debate for cordless. The owner gave clear, blunt feedback — read carefully, then debate hard and recommend concretely. You know the whole cordless design; this changes the product shape.

OWNER'S FEEDBACK (verbatim intent):
"cordless should be a terminal that pairs when you run it. I want ONE installer that installs and starts cordless as a proper terminal, with a QR to pair shown on its starting screen. Right now I have to run `cordless pair` separately, and pair the desktop app and the mobile app independently — which defeats the purpose. Redesign it. Also: can we sign the .exe so the release is legit?"

CURRENT STATE (v0.5):
- Daemon (agent/): Node, node-pty, serves the web client + WS on :7443. Pairing secrets are minted ONLY by the `cordless pair` CLI (pairing.js: mints secret -> addPendingPair, discovers Tailscale/LAN hosts, prints a QR of http://<host>:7443/#pair=<secret>). The client REDEEMS at POST /v1/pair.
- Desktop app (desktop/, Electron): a CLIENT ONLY. It loads the local daemon's page at http://127.0.0.1:<port> and offers a loopback-only "Connect to this computer" button (scope:"loopback" credential, rejected off 127.0.0.1). It does NOT run the daemon — startDaemon() shells out to a separately-installed `cordless` CLI.
- So today the user must: npm i -g cordless -> cordless install -> cordless pair (terminal) -> scan on phone; and separately open the desktop app. Three disjointed steps. That's the complaint.

THE REDESIGN I'm proposing (debate + refine):
ONE all-in-one signed desktop installer. Launch = a proper terminal AND the pairing hub:
1. The desktop app BUNDLES and AUTO-STARTS the daemon (no separate npm install / cordless install). Desktop connects to it over loopback (existing loopback credential — no manual desktop pairing).
2. The app's start screen shows a "Pair a phone" QR (reachable Tailscale/LAN URL + a freshly minted single-use secret). Phone scans -> paired. No `cordless pair` terminal step.
3. `cordless pair` CLI stays as a power-user fallback, not the primary path.

QUESTIONS I need you to debate and answer concretely:

Q1 — BUNDLING THE DAEMON IN ELECTRON (the hard part). node-pty is a native module. Options:
  (a) Electron utilityProcess.fork() running the daemon, with node-pty rebuilt for Electron's ABI via @electron/rebuild.
  (b) Spawn the daemon as a child process using the Electron binary in ELECTRON_RUN_AS_NODE=1 mode (also needs node-pty at Electron ABI).
  (c) Bundle a full Node runtime and spawn the daemon with it (node-pty at Node ABI, no rebuild).
  (d) Keep the daemon a separate process but have the installer set it up (NSIS runs `cordless install`) — less "all-in-one" but avoids ABI pain.
Which do you recommend for a robust, low-friction, cross-platform (win/mac/linux) build, and why? Call out the ABI/packaging traps, asar + native module unpacking, and how the daemon lifecycle (start on app launch, single-instance, stop on quit vs. keep running for the phone) should work. Should the daemon keep running after the desktop app closes (so the phone stays connected)? I lean yes — the daemon is the always-on piece; the desktop app is just one client.

Q2 — IN-APP "PAIR A PHONE" QR. I'll add an AUTHENTICATED mint endpoint (e.g. POST /v1/pairing/new, requires a valid device token; the loopback desktop qualifies) that mints a single-use secret + returns the reachable host URLs (reuse pairing.js host discovery) so the web client can render the QR (qrcode lib). Security review: who may mint (only authenticated? only loopback? both?), rate-limit, secret TTL, which host to put in the QR (Tailscale first), and the risk of exposing LAN/Tailscale IPs in the response. Anything else?

Q3 — REACHABILITY. For the phone to pair, the daemon must be reachable at a non-loopback address (Tailscale/LAN), while the desktop connects via loopback. So the bundled daemon should bind 0.0.0.0 (or the Tailscale iface) by default. On Windows that needs a firewall rule. Should the installer add the Tailscale-scoped firewall rule (100.64.0.0/10 on the Tailscale adapter) automatically, or prompt? How do we keep this secure (token auth + Origin + the ACL guidance we already documented)?

Q4 — UNIFIED UX / MIGRATION. Do we keep the `cordless` CLI + the "separate daemon" path at all, or fold everything into the desktop app? I want to keep the CLI daemon for headless dev boxes (servers with no GUI), but make the desktop app the default consumer experience. How should the two coexist without double-daemons (single-instance lock on :7443 / the PID lock we already have)?

Q5 — CODE SIGNING for a legit release. The owner uses Azure heavily. Give the concrete, current options ranked for a solo indie:
  - Azure Trusted Signing (Microsoft) — cost, identity/eligibility requirements, and how it plugs into electron-builder + a GitHub Actions release. Is this the best path given SmartScreen reputation?
  - OV vs EV Authenticode certs (SmartScreen behavior, HSM/token requirements).
  - Free options for OSS (SignPath.io).
  - macOS: Apple Developer ID + notarization — required for a non-scary .dmg? cost?
  - Linux: signing expectations for AppImage/deb.
  Give a recommended path + what the owner must personally do (accounts, identity verification, payment) vs. what I can automate in CI.

Be opinionated and concrete. Where you'd cut scope for a solid v0.6, say so. This is the plan we'll build from.
