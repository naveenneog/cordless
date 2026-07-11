# cordless — build context (resume anchor)

Read this to resume building cordless. It captures the architecture, protocol, key files, design
decisions (made in tandem with GPT-5.6 Sol), security model, how to run/test, and the backlog.

## What it is

A mobile app + Node daemon to manage many **remote PTY / coding-agent sessions** (shell, `claude`,
`codex`) running on a personal dev box, presented like **browser tabs**. Sessions survive client
disconnects; reconnect replays from the last-applied byte or a snapshot.

Owner: @naveenneog. Built with GitHub Copilot CLI. Design partner: **GPT-5.6 Sol** on Azure AI Foundry
(endpoint + deployment configured via env or `tooling/sol.local.json`, gitignored). The Sol conversation
is stateful — see "Working with Sol" below.

## Repo layout

```
cordless/
  agent/                     # cordlessd — the daemon (Node, ESM, no build step)
    src/
      index.js               # CLI: start | pair | devices [revoke <id>]
      server.js              # HTTP + WS server, Origin allowlist, CSP/security headers, flow control
      sessions.js            # PTY session manager: node-pty + @xterm/headless snapshots + replay ring
      protocol.js            # zod schemas (client->server) + outgoing frame builders
      auth.js                # token verify + brute-force throttle
      state.js               # ~/.cordless persistence: daemon id, config, devices, pending pairs
      pairing.js             # `cordless pair` — QR + single-use secret + Tailscale/LAN URL discovery
    public/                  # built web client (gitignored; produced by `npm --prefix client run build`)
    test/
      run.mjs                # `npm test` harness: boots an isolated daemon, runs every suite,
                             #   incl. desktop credential + restore-across-restart
      pty_smoke.mjs          # node-pty sanity
      e2e.mjs                # full protocol E2E against a live daemon
      security.mjs           # header + Origin + pairing security checks
      desktop.mjs            # loopback desktop-credential auth over 127.0.0.1
      desktop_scope.mjs      # loopback-scoped token rejected from non-loopback IPs
      restore.mjs            # session restore across a daemon restart (create|check)
  client/                    # web app (Vite + React + TS + @xterm/xterm), built into agent/public
    src/
      App.tsx                # workspace shell (topbar, tabs, terminal stack, keybar, sheet)
      lib/connection.ts      # THE hard part: WS client, reconnect, per-tab replay/ack, hot-set
      lib/protocol.ts        # wire types + PROFILES
      lib/storage.ts         # creds + server base + ws url helpers
      components/            # Pairing, TabStrip, TerminalPane, KeyBar, NewSessionSheet
    public/                  # manifest.webmanifest + the >_< PNG icons (favicon/apple-touch/maskable)
  desktop/                   # cordless Desktop — hardened Electron shell for the LOCAL daemon
    main.js                  # secure BrowserWindow, health-check→fallback, IPC (credential/start/retry)
    preload.js               # narrow contextBridge: { platform, getLocalCredential, startDaemon, retry }
    fallback.html            # "daemon not running → Start daemon / Retry" screen
    lib/resolve.js           # pure, testable loopback-server validation + origin precedence
    test/resolve.test.mjs    # 24 unit checks for the credential/origin parsing
    build/icon.png           # 1024px app icon (from the >_< logo)
    package.json             # electron + electron-builder (win nsis/portable, mac dmg/zip, linux AppImage/deb)
  tooling/
    sol.mjs                  # stateful GPT-5.6 Sol conversation (append user+assistant each turn)
    sol_conversation.json    # the running transcript (gitignored)
    sol_plan.md              # Sol's original architecture plan
    *.md                     # design Q&A prompts
  README.md  CONTEXT.md  LICENSE (PolyForm Noncommercial 1.0.0)  package.json (root scripts)
```

## Architecture

- **cordlessd (agent)** owns all PTYs, replay buffers, auth, and one HTTP+WS listener on `:7443`.
  It also serves the built web client same-origin, so the phone just opens `http://<host>:7443`.
- **Client** connects one WebSocket to `/v1/ws`, authenticates with a device token, and renders one
  xterm.js terminal per session tab.
- **Networking**: Tailscale (primary, WireGuard-encrypted, stable `*.ts.net`) or same-LAN IP. Plain
  `ws://` over the tunnel for MVP. TLS pinning + native WS plugin is a later increment.

## Remote sessions (agent/src/sessions.js)

- **node-pty**, NOT tmux (ConPTY on Windows, PTY on Unix; the daemon is already the multiplexer).
- Each session = one PTY + an `@xterm/headless` mirror (for snapshots) + an 8 MiB **replay ring**.
- **Output batching**: PTY `onData` chunks are coalesced every **16 ms / 32 KiB** into one frame with
  **one sequence number per batch**.
- **Serialized terminal op queue** (critical, per Sol): headless `write()` is async, and `reset()` is
  NOT ordered behind queued writes. So all writes + snapshots go through one promise chain, and a
  batch's `seq` is assigned **inside the write callback** — keeping the ring, the counter, and
  `serialize()` always consistent.
- **Reconnect**: on attach with `fromSeq`, if the ring still covers `fromSeq+1` → incremental replay of
  ring chunks; else serialize the headless terminal and send one **reset snapshot** frame.
- **Flow control**: drop a socket at 4 MiB `bufferedAmount`; a 5 s sweep closes connections with no ack
  for 30 s. Client re-attaches and replays.
- Disconnect never kills PTYs. `kill` = SIGTERM→SIGKILL (Unix) / ConPTY terminate (Windows).

## Protocol (JSON text frames over /v1/ws)

Client→server (validated by zod discriminated union in protocol.js): `hello`, `session.list`,
`session.create`, `session.attach {fromSeq}`, `session.input {data:b64}`, `session.resize`,
`session.detach`, `session.kill {mode}`, `session.ack {seq}`.
Server→client: `hello.result`, `*.result`, `session.output {seq,data:b64,replay,reset}`,
`session.exit`, generic `{ok:false,error}`.

- Output bytes are **raw** (never utf8-decoded server-side), shipped base64; client decodes to
  `Uint8Array` and `term.write()`s (xterm reassembles split multibyte).
- Input is base64(utf8) keystrokes; server utf8-decodes and `pty.write()`s.

## Client connection layer (client/src/lib/connection.ts) — the tricky bits

All of these came from Sol's review; keep them:

- **Connection epoch**: every socket increments `epoch`; all handlers/timers/resolvers verify it so a
  stale socket can't corrupt the new one.
- **Per-tab `applyChain`**: serialize writes; `reset()` ordered behind writes; `appliedSeq` advanced in
  the write callback and, once a frame is accepted, ALWAYS becomes durable (never dropped on epoch
  change) — otherwise reconnect double-renders.
- **Admission via `highestReceivedSeq`** (not `appliedSeq`): reject duplicates; a `seq` gap closes the
  socket (→ reconnect → replay/reset). Before each attach, drain applyChain and set
  `highestReceivedSeq = appliedSeq`.
- **Attach/detach generations** + `attachingEpoch` prevent duplicate-attach and detach-during-attach.
- **Bounded hot set**: active + 3 background tabs stay attached/streaming; others `session.detach`.
  Noisy background tab past 1 MiB queued → `streamSuppressed` + detach. Unread for ALL sessions is
  derived cheaply from `session.list` `latestSeq` vs `appliedSeq`.
- **Ack**: throttled 250 ms, epoch-tracked; flushed on background/pagehide.
- **Resize**: per-tab debounce (90 ms) + generation; clamp 20..300 × 5..120 (matches server).
- **Backgrounding**: on `visibilitychange` hidden → flush acks + close socket after 500 ms (Android
  freezes JS); reconnect on visible/online.
- **Modifier latches**: Ctrl/Alt are one-shot, consumed on the next key even if not transformable;
  keybar special keys clear latches.
- Terminals kept mounted; inactive panes are `visibility:hidden` (not display:none); `fit()` only when
  the pane has non-zero size, on rAF after activation.

## Security (baked in — see agent/src/server.js, auth.js, state.js)

- Per-device 256-bit tokens, only SHA-256 hashes stored; `devices revoke`.
- Single-use, 15-min, rate-limited pairing; secret in URL fragment (never sent to server).
- WS + pairing **Origin allowlist** (same-host + localhost + configured app origins; foreign origins
  rejected). CSP `script-src 'self'` (no inline JS), nosniff, `frame-ancestors 'none'`, `no-store` on
  credential responses. 5-fails→10-min IP block. Root/all-interfaces startup warnings.
- Verified by `agent/test/security.mjs` (9 checks) — keep it green.
- **Loopback desktop credential** (v0.5): `ensureDesktopCredential(port)` writes
  `~/.cordless/desktop-credential.json` (mode 0600, plaintext token; daemon stores only the hash) and
  creates a `scope:"loopback"` device. `authenticate(deviceId, token, ip)` accepts that token **only**
  when the socket peer is `127.0.0.1`/`::1` — a Tailscale/LAN IP is rejected. QR pairing stays the app's
  default auth; the desktop's "Connect to this computer" button is an explicit opt-in only. Verified by
  `agent/test/desktop.mjs` + `desktop_scope.mjs`.
- **Cross-origin / CORS**: the PWA is same-origin, but the Capacitor APK's WebView origin is
  `http://localhost`, so it talks to the agent cross-origin. The server therefore does CORS scoped to
  the Origin allowlist: echoes `Access-Control-Allow-Origin` for allowed origins, answers `OPTIONS`
  preflight (204), and answers Private Network Access (`Access-Control-Allow-Private-Network: true`)
  for allowed origins reaching LAN/Tailscale addresses. Disallowed origins still get 403.

## Run / build / test

```
npm run setup      # agent + client install
npm run build      # client -> agent/public
npm start          # daemon (or: npm run up  = build + start)
npm run pair       # pairing QR
npm test           # boots an isolated daemon + runs every suite (pty, e2e, security,
                   #   desktop credential + scope, restore-across-restart). Hermetic temp homes.
npm --prefix desktop test   # desktop credential/origin parsing unit tests (24 checks)
```

Verified working: Windows dev box, Node 26, pwsh.exe auto-detected; browser (Chromium via Playwright)
create/type/echo, tab switch preserves content, keybar history recall, reload restores via snapshot.

## Working with Sol (do not make stateless calls)

`node tooling/sol.mjs <promptFile>` or `-m "text"` continues the SAME conversation
(`tooling/sol_conversation.json`), so Sol stays consistent with every prior decision. Reseed with
`tooling/sol_seed.mjs`. Auth: `az account get-access-token --resource https://cognitiveservices.azure.com`
(reasoning model — keep `max_completion_tokens >= ~8k`).

## Backlog (priority order, per Sol)

DONE this session: Android APK (Capacitor 8, `android/`, debug-signed release, emulator-tested end to
end — pair over CORS, connect, attach, render, replay), `.github/workflows/android.yml` (tag `v*` →
builds `cordless-vX.Y.Z.apk` → release asset), `install/` auto-start scripts (systemd/launchd/Task
Scheduler), `docs/` GitHub Pages landing page.

Remaining:
1. **Real-phone test over Tailscale** — server URL `http://<tailscale-ip>:7443` (non-loopback, http,
   cleartext → avoids Capacitor localhost interception, emulator routing, and adb reverse). Needs
   Windows Firewall inbound 7443 on the Tailscale interface + a tailnet ACL.
2. **Increments**: TLS pinning + native WS plugin, session-drawer to reopen closed tabs, server-side
   `session.activity` push for exact unread, file up/download, persist transcripts across daemon restart.

### v0.4 additions (this session, tested)
- **Seamless resume**: `agent/src/service.js` — `cordless install|uninstall|stop|status` register OS
  autostart (Task Scheduler hidden ONLOGON / systemd --user / launchd) + a PID lock. Session **restore**:
  `SessionManager` persists a manifest (`~/.cordless/sessions.json`) of running sessions and relaunches
  them on start with the SAME id + a NEW `generation`; the client resets `appliedSeq/highestReceivedSeq`
  when a tab's `generation` changes (in `onList`). Config flag `restoreSessions` (default true).
- **Mobile truncation fix**: `min-width:0` on the flex ancestors (`.app/.terminalStack/.terminalPane/.xterm`)
  + a per-active-pane `ResizeObserver` → coalesced `scheduleFit()`; xterm soft-wraps (no h-scroll, per Sol).
  Font zoom `adjustFont/resetFont` (persisted `cordless.fontSize`), and a `SessionDetails` sheet
  (title/cwd/host/state/id, copyable) via the topbar ⓘ.
- **In-app QR scanner**: `client/src/lib/scan.ts` + `@capacitor/barcode-scanner` (3.0.2, needs
  `minSdk 26`) + `@capacitor/app`. "Scan QR" button on the pairing screen (native only) → `parsePairPayload`
  → confirm host → pair. Camera permission + a `cordless://pair?server=…#pair=…` deep-link intent-filter
  in the manifest; `cordless pair` also prints the deep link. (In-app scanner verified on emulator;
  deep-link `appUrlOpen` is wired but not confirmed via `adb am start` — should work from a real camera app.)

### v0.5 additions (this session, tested)
- **Brand logo**: a framed `>_<` mark generated with **gpt-image-2** (`tooling/gen_logo.py` → sources in
  `tooling/logo/{icon,mark}.png`; `tooling/apply_logo.py` resizes into every web + Android size and
  luminance-keys the adaptive-icon foreground since gpt-image-2 can't do transparent backgrounds).
  Applied to the PWA (`icon-192/512`, maskable, apple-touch, favicons), the landing-page hero, and the
  Android launcher/adaptive/splash. **Gitignore fix**: the global `*.png` rule was silently dropping the
  new client/desktop icons — added `!client/public/*.png`, `!desktop/build/*.png`, `!tooling/logo/*.png`.
- **Desktop app** (`desktop/`, approved with Sol): hardened Electron shell that loads the LOCAL daemon's
  served page at `http://127.0.0.1:<port>` (same-origin → zero CORS/CSP changes). `contextIsolation` on,
  `nodeIntegration` off, `sandbox` on; `setWindowOpenHandler` deny, `will-navigate` pinned to the trusted
  origin, all permissions + webviews denied. Preload exposes only `{ platform, getLocalCredential,
  startDaemon, retry }`; IPC verifies the sender is a trusted page; `startDaemon` takes no renderer input
  and resolves the CLI via `where`/`which`. Health-checks the daemon → `fallback.html` (Start daemon /
  Retry) when down. Port precedence: credential.server → config.port → 7443, all loopback-validated.
  `.github/workflows/desktop.yml` builds win/mac/linux installers on native runners on tag.
- **QR-first auth preserved**: the earlier desktop auto-connect was removed; `Pairing.tsx` now only shows
  an explicit **🖥️ Connect to this computer** button when `window.cordless.getLocalCredential()` (the
  Electron bridge) returns a credential — plain browsers see QR/code only.
- **Test harness**: `agent/test/run.mjs` makes `npm test` actually self-contained (previously it invoked
  daemon-dependent scripts with no daemon). 7/7 suites green on Windows/Node 26.

## Known limitations (MVP)

- Plain `ws://` (relies on Tailscale/LAN); no TLS pinning yet.
- Every listed session gets an xterm client-side (fine for a handful; add lazy-open if needed).
- `closeTab` hides a running session locally until reload (no reopen UI yet).
- Token stored in browser localStorage (move to Android Keystore in the Capacitor build).
