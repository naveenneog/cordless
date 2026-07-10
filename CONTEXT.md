# cordless — build context (resume anchor)

Read this to resume building cordless. It captures the architecture, protocol, key files, design
decisions (made in tandem with GPT-5.6 Sol), security model, how to run/test, and the backlog.

## What it is

A mobile app + Node daemon to manage many **remote PTY / coding-agent sessions** (shell, `claude`,
`codex`) running on a personal dev box, presented like **browser tabs**. Sessions survive client
disconnects; reconnect replays from the last-applied byte or a snapshot.

Owner: @naveenneog. Built with GitHub Copilot CLI. Design partner: **GPT-5.6 Sol** on Azure
(`REDACTED-AZURE-RESOURCE`, deployment `gpt-5.6-sol`). The Sol conversation is stateful — see
"Working with Sol" below.

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
      pty_smoke.mjs          # node-pty sanity
      e2e.mjs                # full protocol E2E against a live daemon
      security.mjs           # header + Origin + pairing security checks
  client/                    # web app (Vite + React + TS + @xterm/xterm), built into agent/public
    src/
      App.tsx                # workspace shell (topbar, tabs, terminal stack, keybar, sheet)
      lib/connection.ts      # THE hard part: WS client, reconnect, per-tab replay/ack, hot-set
      lib/protocol.ts        # wire types + PROFILES
      lib/storage.ts         # creds + server base + ws url helpers
      components/            # Pairing, TabStrip, TerminalPane, KeyBar, NewSessionSheet
    public/                  # manifest.webmanifest, icon.svg
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

## Run / build / test

```
npm run setup      # agent + client install
npm run build      # client -> agent/public
npm start          # daemon (or: npm run up  = build + start)
npm run pair       # pairing QR
npm test           # e2e.mjs + security.mjs  (set CORDLESS_HOME to isolate)
```

Verified working: Windows dev box, Node 26, pwsh.exe auto-detected; browser (Chromium via Playwright)
create/type/echo, tab switch preserves content, keybar history recall, reload restores via snapshot.

## Working with Sol (do not make stateless calls)

`node tooling/sol.mjs <promptFile>` or `-m "text"` continues the SAME conversation
(`tooling/sol_conversation.json`), so Sol stays consistent with every prior decision. Reseed with
`tooling/sol_seed.mjs`. Auth: `az account get-access-token --resource https://cognitiveservices.azure.com`
(reasoning model — keep `max_completion_tokens >= ~8k`).

## Backlog (priority order, per Sol)

1. **Android APK via Capacitor + GitHub Actions CI** — bundle client, `androidScheme:'http'` +
   cleartext so `ws://<tailscale-ip>` works; debug-signed `cordless-vX.Y.Z.apk`. Test on a real phone
   (Tailscale, background/foreground, keyboard resize, reconnect, token persistence, process death).
2. **Auto-start installers** — `systemd --user`, `launchd`, Task Scheduler (separately; no fake generic).
3. **PWA polish** — icons (real PNGs), fullscreen, safe-area, keyboard/visualViewport behavior.
4. **Publish** — public repo `naveenneog/cordless`, PolyForm Noncommercial (call it *source-available*),
   `docs/` GitHub Pages landing page, tagged release. Run dep audit + secret scan first.
5. **Increments**: TLS pinning + native WS plugin, session-drawer to reopen closed tabs, server-side
   `session.activity` push for exact unread, file up/download, persist transcripts across daemon restart.

## Known limitations (MVP)

- Plain `ws://` (relies on Tailscale/LAN); no TLS pinning yet.
- Every listed session gets an xterm client-side (fine for a handful; add lazy-open if needed).
- `closeTab` hides a running session locally until reload (no reopen UI yet).
- Token stored in browser localStorage (move to Android Keystore in the Capacitor build).
