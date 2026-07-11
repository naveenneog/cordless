New requirement from the user for cordless (continuing). They asked:
- "how do I resume the sessions on my laptop or dev box?" (the resume UX from the dev-box side)
- "the tailscale installation and prerequisites are not recorded properly — where are those?" (docs gap)
- "what about a DESKTOP distribution which can just resume the tasks or open and see? how are we going to
  build it or is it built already?" (a desktop app to view/resume sessions on the laptop/dev box — NOT built yet)

Context: cordless today = a Node daemon on the dev box (serves the web client at http://localhost:7443,
WS at /v1/ws, per-device token auth, Origin allowlist + CORS/PNA), a PWA, and an Android APK (Capacitor).
Sessions auto-restore on daemon start; `cordless install` runs the daemon hidden at login. There is NO
first-class desktop client — on the dev box you'd open a browser to localhost:7443.

I want to add a DESKTOP DISTRIBUTION. Design it. Decide concretely:

1. APPROACH: Electron vs Tauri vs "just install the served PWA as a desktop app (Chrome/Edge install)"
   vs a tiny system-webview wrapper. The owner has Node + the existing web client + Capacitor Android,
   Windows dev box (also targets mac/linux), values small/robust. Pick ONE primary and say why. Can I
   reuse the exact same web client build (agent/public) so there's a single UI codebase across
   phone/PWA/desktop?

2. LOCAL AUTO-PAIR: the desktop app usually runs on the SAME machine as the daemon. Forcing QR/token
   pairing there is silly. How do I let a LOCAL desktop client connect WITHOUT manual pairing, securely?
   Options I'm weighing: (a) daemon writes a 0600 local token file in ~/.cordless that the desktop reads
   (same-user filesystem trust); (b) daemon auto-issues a device token to loopback (127.0.0.1/::1)
   connections; (c) a loopback-only control endpoint / unix socket / named pipe. Which is the secure +
   simple choice, and what are the pitfalls (other local users, other local apps, browser JS on
   localhost reading it)? The desktop app should ALSO be able to connect to a REMOTE daemon (another dev
   box) via the normal pairing flow.

3. RESUME UX on desktop: the app opens and immediately shows the (auto-restored) sessions and lets you
   interact. Anything special vs the phone client? Should the desktop app optionally auto-start / ensure
   the daemon is running, or stay decoupled?

4. DISTRIBUTION/BUILD: how to package + ship it (installers vs portable), and a realistic CI path
   (GitHub Actions) for Windows/mac/linux. If Electron, electron-builder targets + code-signing reality
   (unsigned is fine for personal use?). Keep it buildable without exotic toolchains.

5. Also: give me the crisp, correct explanation of "how do I resume sessions on my laptop/dev box" that
   I should put in the docs, and the exact PREREQUISITES + TAILSCALE setup steps (install links,
   `tailscale up`, an ACL example limiting :7443 to the owner's own devices, and the Windows firewall
   inbound rule for the Tailscale interface) — this is currently under-documented.

Be concrete and buildable. Short. This will be executed now.