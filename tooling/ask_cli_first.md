Direction change from the owner — this reshapes cordless. Debate hard, then give a concrete v0.6 plan.

OWNER (verbatim intent): "cordless should be a CLI FIRST. Look at the design of a Terminal app and get the features from that."

How I read it (correct me): the CLI *is* the product on the dev box — not the Electron GUI. Running `cordless` should launch a proper terminal experience whose STARTING SCREEN shows the pairing QR (right there in the terminal), plus status and sessions. Model the UX on modern terminal apps (Warp / Windows Terminal / iTerm2 / Ghostty). The phone app scans that QR. Ship it as an installable, ideally single-binary CLI (no Node prerequisite), and it should be signable.

This SUPERSEDES the "Electron desktop app is the all-in-one product" idea from our last exchange. Electron becomes optional/secondary; the CLI + mobile app are the core. Keep the daemon + web/mobile client we already have.

Context recap (still true): daemon (agent/) = Node + node-pty, serves the web client + WS on :7443, mints pairing secrets (currently only via `cordless pair`, which prints a qrcode-terminal QR of http://<tailscale|lan>:7443/#pair=<secret>). Client redeems at POST /v1/pair. We have loopback-scoped desktop credential + Origin allowlist + CSP + rate limits + session restore.

Terminal-app features I could borrow (from research): tabs, panes/splits, command palette, session save/restore + "workspaces", themes, and a welcome/home screen with recent sessions + quick actions. Warp's welcome/onboarding + command palette + blocks are the standout modern references.

DEBATE + ANSWER concretely:

Q1 - THE `cordless` STARTING SCREEN (the heart of this). I want `cordless` (no subcommand) to launch a TUI "home/dashboard": brand banner, daemon status, the reachable Tailscale/LAN URL, a LIVE pairing QR (auto-minted, single-use, refreshable), a session list (profile/cwd/state), device list, and key hints. Questions:
  (a) Should this TUI run the daemon IN-PROCESS (one `cordless` process both serves :7443 AND renders the TUI), or should the TUI be a thin CLIENT of a background daemon (start daemon detached, TUI attaches)? Trade-offs for reliability, "daemon keeps running after I close the TUI", and Ctrl-C behavior. I lean: daemon runs as a persistent background service (cordless install), and `cordless` with no args opens the TUI dashboard as a local client that auto-starts the daemon if down. Agree?
  (b) How interactive for v0.6? A rich, mostly-static status screen that live-refreshes (QR + status + session table) with a few hotkeys (n=new session, p=regenerate pairing QR, d=devices, o=open session, r=refresh, q=quit)? Or a full multi-pane TUI? I want to SCOPE this so it's shippable, not a terminal-emulator rewrite. What's the right v0.6 cut?
  (c) Should selecting a session in the dashboard let you actually attach and interact with that PTY IN the terminal (i.e. cordless becomes a real terminal multiplexer client, tmux-like), or is that out of scope for v0.6 (dashboard shows/*manages* sessions; the phone/web is where you interact)? Be opinionated.

Q2 - WHICH terminal-app features make the v0.6 cut vs defer? Rank: welcome/home screen w/ QR (must), session list/switcher, command palette, tabs, panes/splits, themes, workspaces/layout save-restore. Keep it lean.

Q3 - PACKAGING as an installable CLI with NO Node prerequisite. node-pty is native. Options: @yao-pkg/pkg (maintained pkg fork, bundle prebuilt pty.node as an asset + patch the load path), Node SEA (single-executable-applications, newer, static require only), or ship Node-bundled installer. Recommend one for a robust signed Windows `cordless.exe` (+ mac/linux later). Call out the node-pty .node extraction/load-path traps and how to test the packaged binary (not the repo).

Q4 - RECONCILE with what exists. `cordless start|stop|status|pair|devices|install|uninstall` stay. `cordless` (no args) = the new dashboard. `cordless pair` stays as a one-shot QR (but the dashboard already shows one). Any command-surface cleanup you'd do? How do the dashboard's auto-minted QR and `cordless pair` share the pending-pairs store without conflict?

Q5 - v0.6 CUT LINE for the CLI-first product. Bullet what ships vs defers. Assume Windows-first, unsigned-for-now (owner will add Azure Trusted Signing later), keep mobile app + web client, keep the daemon.

Be decisive and concrete — this is the plan I'll build from immediately.
