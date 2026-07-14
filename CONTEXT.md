# cordless — build context (resume anchor)

Read this to resume building cordless. It captures the architecture, protocol, key files, design
decisions (made in tandem with GPT-5.6 Sol), security model, how to run/test, and the backlog.

## v0.9.0 UX fixes (repushed into the same 0.9.0, current)

Four fixes folded into a **0.9.0 repush** (Chocolatey allows re-pushing an unapproved version, so no
version bump — re-tagged v0.9.0 at the fixed HEAD, CI rebuilt every asset, choco repushed):

- `fix/dashboard-o-newtab` — the dashboard **`o` key now opens a session in a new tab**. Bug: the key
  switch had `case "o"` grouped with Enter, so it attached in place and the dedicated
  `openInNewTerminal` handler below was unreachable dead code. Removed `o` from the Enter group. Also
  default the new wt tab title to the brand mark **`>_<`** (renamed sessions append their sanitized
  title); `>_<` is a trusted literal only in the wt argv path (never the shell fallback).
- `feature/app-agent-icons` — the phone/web client shows agents as **colored icon badges instead of
  names** (shell `>_`, Claude `✳`, Codex `❋`, GitHub Copilot `◉`) in the tabs + new-session picker, and
  **adds GitHub Copilot** (the daemon already had the `copilot` profile in `state.js:76`; the client's
  PROFILES was missing it). `client/src/lib/protocol.ts` (glyph+color+`agentMeta`),
  `components/AgentIcon.tsx`, `NewSessionSheet.tsx`, `TabStrip.tsx`.
- `fix/keybar-scroll` — the on-screen **key bar now scrolls horizontally** so Esc/Tab/arrows/^C/^D are
  all reachable on a narrow phone. The first `.keyrow` wasn't a scroll container; made every `.keyrow`
  `overflow-x:auto` + `touch-action:pan-x` (keys `preventDefault` pointerdown, so pan-x is required for
  touch scroll).
- `ci/choco-auto-publish` — `choco-publish.yml` is now a **reusable workflow** (`workflow_call` +
  `workflow_dispatch`) called from `cli.yml` (`publish-choco`, `needs: build`, tags only,
  `secrets: inherit`). The old `release: published` trigger never fired (CI's GITHUB_TOKEN doesn't start
  workflow runs), so now `git push --tags` builds AND publishes to Chocolatey hands-free.

## v0.9.0 — accurate `start` diagnosis + in-CLI help

Two per-feature branches, then released as 0.9.0 (the choco-ready, self-documenting release):

- daemon `start` under a shim — **investigated and corrected a misdiagnosis.** The prior session's
  "Chocolatey shim hangs on `cordless start` (job object)" was wrong: an empirical shimgen test showed a
  plain detached `spawn()` returns fine under a real shim, and the daemon survives. The perceived hang
  was the ~10–15s first-run cost of Windows scanning the ~100 MB self-contained exe before Node starts.
  A WMI `Win32_Process.Create` "breakaway" was tried (branch `fix/daemon-job-breakaway`) but it dropped
  `CORDLESS_HOME` (WMI processes don't inherit the caller's env — this broke the CI smoke test), so it
  was reverted to the original plain detached spawn with stdio redirected to `~/.cordless/daemon.log`.
  Verified end-to-end through a shimgen shim with a custom `CORDLESS_HOME`: `start` returns, daemon runs
  under the right home, health 200, PTY spawns, clean stop. `agent/src/service.js` `startDaemonDetached`
  is the simple env-preserving spawn; the choco README documents the first-run-scan expectation.
- `feature/cli-help` — a data-driven help system. `agent/src/cli/help.js` holds one `COMMANDS`
  registry that renders both `cordless help` (grouped overview) and `cordless help <cmd>` /
  `cordless <cmd> --help` (USAGE + wrapped description + OPTIONS + EXAMPLES + aliases). `index.js`
  intercepts `<command> --help` and routes `help [topic]`; the old static HELP string is gone. Unknown
  commands print the overview + exit 1. Guarded by `agent/test/help.mjs`. Harness now **26/26**.

## Distribution — Chocolatey (packaging/chocolatey/)

Chocolatey package for the CLI, tested locally end-to-end (pack -> install -> verify -> uninstall).
The package downloads the official `cordless-cli-windows-x64.zip` from the matching GitHub release,
verifies its SHA256, extracts it, and lets Chocolatey shim `cordless.exe`. `chocolateyInstall.ps1`
writes `.ignore` files next to the bundled node-pty helper exes (`OpenConsole.exe`/`winpty-agent.exe`)
so only `cordless.exe` is shimmed onto PATH. `update-checksum.ps1 -Version X` refreshes the version +
SHA256 across the nuspec/install/verification files; `README.md` has the pack/test/**push** steps
(needs a community.chocolatey.org account + API key). `cordless`, `cordless start`, and
`cordless install` all work under the shim (the only quirk is the one-time first-run exe scan — see the
choco README). **v0.9.0 was published to community.chocolatey.org** (page:
community.chocolatey.org/packages/cordless/0.9.0) — in moderation (first version of a new id gets human
review). Publishing is automated via `.github/workflows/choco-publish.yml` (secret **`CHOCO_API_KEY`**):
it runs on every published GitHub release, or manually via
`gh workflow run "Publish to Chocolatey" -f version=<X>` — it re-hashes the release zip, packs, and
`choco push`es. `update-checksum.ps1 -Version X` does the same refresh locally.

## v0.8.3 — open sessions in new terminal tabs

`feature/open-in-new-tab`: from the dashboard, press <kbd>o</kbd> to open the selected session in a
**new terminal tab/window** running `cordless attach <id>`, so the dashboard keeps running in its own
tab and you can launch / resume more — like browser tabs (the user's ask: "launch the attach session
to a new tab so I can resume back"). New `agent/src/cli/openterm.js`: `selfCmd()` (relaunch cordless —
SEA exe or `node src/index.js`), `newTerminalCommand()`/`openInNewTerminal()` — **Windows Terminal**
`wt -w 0 new-tab --title <t> <cordless> attach <id>` (verified: wt launches the command), a
`cmd /c start "" ...` console fallback, and macOS `osascript`/Linux emulator paths; title sanitized
(a renamed session title can't inject wt/shell args). CLI `cordless attach <id> --new-window` (`--tab`
/`-w`). Dashboard `o` key + footer; `test/openterm.mjs` (headless-tolerant). Harness 25/25.

## v0.8.2 — install QA

Fixes to the install experience (`fix/install-qa`):

- **`cordless setup` now STARTS the daemon** after copying + PATH + autostart (`startDaemonDetached()`
  in `setup.js`'s `--path-only` finalize; `--no-start` to skip). Download → `cordless setup` → daemon
  already running → `cordless` shows the QR — a true one-step installer. QA'd end-to-end with the SEA.
- **Desktop app finds an installed CLI beyond PATH.** `desktop/lib/resolve.js` gained
  `installedCliCandidates()`/`findInstalledCli()` (checks `%LOCALAPPDATA%\Programs\cordless\cordless.exe`
  etc.); `main.js` `resolveCordlessCli()` checks the install dir FIRST, then PATH (fixes a stale GUI
  PATH after setup). No CLI → `startDaemon` returns `{needsCli:true}` and the fallback screen shows a
  "Get the cordless CLI" button (`cordless:open-releases` IPC → `shell.openExternal` a fixed URL) +
  the `cordless setup` hint. `desktop/test/resolve.test.mjs` 29 checks.
- User's report root cause: only the **desktop** app was installed (a thin Electron shell over the
  local daemon) with no CLI, so its "Start daemon" and `cordless start` both failed. cordless is
  CLI-first: the CLI *is* the daemon/installer; the desktop is optional.

## v0.8.0 — history, custom launchers, groups

Six-branch v0.8 program designed with Sol, each feature on its own branch merged `--no-ff`. Harness
is **23/23** (`npm --prefix agent test`). Shipped:

1. **Persisted history** (`feature/persisted-history`): capped, normalized plain-text scrollback per
   session at `~/.cordless/history/<id>.json.gz` (gzip, user-only, atomic), saved on a periodic ~3s
   manager sweep (survives reboot / Windows hard-kill, not just clean shutdown) + a shutdown flush.
   On restore it's shown as **frozen context above** the reopened session (output/search/attach
   snapshot) + a "session reopened after system restart" banner — NOT written into the fresh terminal
   (a reopened shell clears its screen and would wipe it). Chains across restarts; GC'd on kill/exit +
   orphan cleanup. `cordless history [status|clear] [id] [--all]`; config `history.{persist,maxLines,
   maxBytes}`. Files: `state.js` (gz helpers), `sessions.js` (`_captureHistoryRecord`/`_liveLines`/
   `seedRestoredHistory`/`_restoredHistoryText`, `flushHistoryIfDirty`), `history.mjs` (phase D).
   **Correctness gotcha (fixed):** on a graceful stop (POSIX SIGTERM) the daemon runs `shutdown()`,
   which kills each PTY; the resulting `_onExit` must NOT clear history or rewrite the manifest, or the
   restored session loses its history / isn't reopened. Guarded via a manager `_shuttingDown` flag
   (`_onExit` skips `clearSessionHistory`; `_persistManifest` is a no-op during shutdown). Regression:
   `history_shutdown.mjs` (drives `mgr.shutdown()` directly — the harness SIGTERM can't trigger graceful
   shutdown on Windows). This only bit Linux/macOS CI; Windows SIGTERM is an uncatchable hard-kill.
2. **Custom launchers** (`feature/custom-profiles`, `agent/src/profiles.js`): user profiles in
   `config.json` merge with built-ins (user wins). Direct-spawn `{command,args?,cwd?,env?,title?,
   attentionPreset?}` (resolved via the daemon PATH/PATHEXT — node-pty needs the full path) or legacy
   shell `{initCommand}`. Validated (name `^[A-Za-z0-9][\w.-]{0,31}$`, exe not a shell string, args<=64,
   string env); missing exe = marked unavailable (never crashes), launch fails clearly. Remote clients
   select by NAME only. `cordless profiles [show <name>]`; dashboard `n` numbers all, dims unavailable.
3. **Copilot profile** (`feature/copilot-profile`): built-in `copilot {command:"copilot",
   attentionPreset:"agent"}` (unavailable until installed). Agent attention is now preset-driven —
   `_isAgent()` = attentionPreset "agent" OR claude/codex — so copilot + custom agents get the shared
   waiting/finished heuristics. Also fixed profile source labelling (built-in vs real override).
4. **Rename tabs** (`feature/session-rename`): `session.rename {sessionId,title}` -> broadcast
   `session.updated {sessionId,revision,changes}` (monotonic metaRevision/titleRevision, last-write-
   wins). NFC/trim/control-strip, cap 80 code points / 256 bytes, empty resets to default; persisted in
   the manifest. `cordless rename <id> <title>`; dashboard `e` inline editor.
5. **Session groups** (`feature/session-groups`): Chrome-mobile-style tab groups. `groups.json` map
   {id,name,color,order,revision} + groupId/groupOrder on sessions (in the manifest; pruned on
   startup). WS: group.list/create/rename/color/reorder/delete/assign, broadcast groups.updated /
   session.updated; delete never kills sessions. `cordless group <list|new|rename|color|delete|
   assign>`. Dashboard renders collapsible ▼/▶ group headers + Ungrouped + per-group waiting counts;
   `g` group menu (new/assign/ungroup/collapse/rename/delete), `f` cycles the smart-view filter
   (All|Attention|Claude|Codex|Copilot|Shell — views, not groups; collapse state is client-local).
   Shared `visibleSessions()`/`groupedRows()` in `render.js` keep the dashboard + renderer in sync.

Remaining: none — the six-feature v0.8 program is complete (feature 6 shipped in v0.8.1). Later
one-shot: `cordless group by-repo`. Deferred: nested groups, shared panes, drag-reorder everywhere,
continuous auto-grouping, and a full phone card-grid rewrite (v0.8.1 filters the existing tab strip
with group chips rather than replacing it).

## v0.8.1 — tab groups on the phone

`feature/group-ui-phone`: the phone web client (`client/`) is now group-aware — the connection tracks
groups (`group.list` + `groups.updated`), carries `groupId` per tab, applies `session.updated` live,
and gains `renameSession`/`assignGroup`/`createGroup`/`deleteGroup`. UI: a filter chip strip (All |
Unread | one chip per group, with counts + color dots) filters the visible tabs; grouped tabs show a
color dot; the details sheet renames the tab and moves it to a group (or creates one).
`client/src/lib/groupColor.ts` maps colors to the theme. Verified with `tsc --noEmit` + `vite build`.

## v0.7.1 — packaged-binary fixes + self-installer

Fixes for the real downloaded-binary experience, each on its own branch merged `--no-ff`:

- **Seamless resume** (`fix/seamless-resume`): the dashboard's 1s refresh `setInterval` called
  `render()` during an attach (it only checked `mode`, not whether the dashboard screen was active),
  repainting the dashboard over the attached PTY — so resuming a session looked broken. Guard the
  timer with `!state.interactive` (false between `leave()`/`enter()` during attach). Added
  `cordless resume` / `cordless attach` (no-arg) = jump into the most-recently-active running session.
- **`cordless setup` self-installer** (`feat/cli-setup`, `agent/src/cli/setup.js`): copies the binary
  to a stable dir (`%LOCALAPPDATA%\Programs\cordless`), adds it to the User PATH idempotently, and
  registers autostart. Flags `--dir --no-path --no-autostart --path-only --dry-run --uninstall
  --purge --copy-only`. The SEA build also drops a double-click `Install cordless.cmd`. (NSIS
  `cordless-Setup.exe` in CI still TODO — it will just extract + call `cordless setup --path-only`.)
- **Version-skew "invalid message" fix** (already in v0.7.0 tail, `034a783`): `ensureDaemon()` now
  replaces a stale/older daemon on :7443 instead of talking to it.
- **Test robustness**: `output.mjs`, `pty_smoke.mjs`, `attention_live/prompt` wait for the shell
  prompt then poll instead of fixed sleeps (slow PowerShell startup dropped early input).
- **Resume regression test (phase C, `resume_dash.mjs`)**: drives the real path through a node-pty —
  open dashboard → Enter to attach → type into the live session while the refresh timer keeps
  ticking → assert the unique `enter attach` footer never reappears over the session → detach →
  dashboard returns. Harness is **18/18**.

### v0.8 roadmap (designed with Sol; branch order)

Ship in this order, groups trigger the `0.8.0` tag:

1. `feature/persisted-history` — persist a capped (2000 lines / 512KB, first-limit-wins) **normalized
   text** scrollback per session to `~/.cordless/history/<id>.json.gz` (strip escapes; debounced
   5–10s writes + clean-shutdown flush; atomic temp+rename; user-only perms). On restore, replay the
   text then `── cordless: session reopened after system restart ──` before the fresh PTY. Add
   `cordless history clear [session]`. Config `history.{persist,maxLines,maxBytes}`.
2. `feature/custom-profiles` — user profiles in `config.json` under `profiles`; `effective =
   {...builtIns, ...config.profiles}` (user overrides win). Schema `{command, args?, cwd?, env?,
   title?, attentionPreset?:"shell"|"agent"|"none", restore?}`. Name `^[a-zA-Z0-9][\w.-]{0,31}$`;
   `command` is an exe/abs-path (NOT a shell string) spawned directly via node-pty; resolve via the
   **daemon** PATH (+ Windows `PATHEXT`). Don't reject config if an exe is missing — mark unavailable.
   `cordless profiles [show <name>]`; dashboard `n` lists all, dims unavailable with reason. Remote
   clients may select a profile but never submit arbitrary argv; no remote profile edits.
3. `feature/copilot-profile` — built-in `copilot` profile `{command:"copilot", attentionPreset:
   "agent"}`, visible-but-unavailable when absent (verify `copilot --version`; NOT `gh copilot`).
   Shared `agent` heuristics + BEL; add Copilot-specific patterns only from recorded PTY fixtures;
   watch alternate-screen use.
4. `feature/session-rename` — `session.rename {sessionId,title}` → broadcast `session.updated
   {sessionId, revision, changes:{title}}`. NFC-normalize, trim, ≤80 code points / 256 bytes, reject
   NUL/C0/C1/newline/ESC/bidi controls; empty = restore generated default; atomic manifest write;
   monotonic revisions (clients ignore older); last-write-wins. Dashboard `e` inline editor.
5. `feature/session-groups` — **manual groups + non-persistent smart views** (no continuous
   auto-grouping). Server: `groups` map `{id,name,color,order,revision}` + `groupId`/`groupOrder` on
   each session (collapse state is client-local). Ops `group.create/rename/delete/assign/reorder`;
   delete → sessions `groupId:null` (never kills). TUI: collapsible group header rows (+`g`), keep
   `e` for rename; top smart filters `All|Attention|Claude|Codex|Copilot|Shell` (views, not groups).
6. `feature/group-ui-phone` — phone chips (`All`, `Attention`, named groups) + grouped card sections
   (not 10 live terminals); tap opens, long-press rename/move/mute/kill; badge counts.

Later one-shot: `cordless group by-repo`. Deferred: nested groups, shared panes, drag-reorder everywhere.

## v0.7 — attention state + coder features

Built on the v0.6 CLI-first base. The differentiator for juggling many coding-agent sessions:

- **Per-session attention state** (`agent/src/attention.js` + SessionManager). The daemon infers each
  session's `activity` (working/idle/exited) + `attention` (prompt/bell/finished) purely from PTY output
  — conservative heuristics (confirm/agent prompt patterns; shell prompts = readiness not attention;
  alt-screen/pager suppression; BEL with input+startup guards; agent "finished" = shell prompt after
  real activity). One manager-level 1s loop; pushed via `session.activity`, cleared via
  `session.attention.clear`, included in `session.list` (+ `lastLine` preview). Dashboard badges +
  attention-first sort + `c` mark-handled; `cordless sessions --attention`. Tests: attention.mjs (pure) +
  attention_live.mjs.
- **Notifications** (`agent/src/notifier.js`): optional ntfy / generic webhook on notify-worthy
  transitions; strict anti-spam (per-revision, 60s cooldown, 5/min burst, quiet hours), async, secrets
  redacted, no cloud owned. `config.json.notifications`; `cordless notify [status|test]`. test notifier.mjs.
- **Copy last output + scrollback search**: `Session.readTail/readSearch` over the headless buffer;
  `session.tail`/`session.search`; `cordless output <id> [--lines N] [--copy]`, `cordless search <id> <q>`.
- **Workspaces**: `~/.cordless/workspaces.json`; `cordless workspace save|open|list|delete` (named
  templates of profile+cwd+title). test workspace.mjs.

`npm --prefix agent test` harness is 15/15. Each feature shipped on its own branch (feature/attention-
state, /notifications, /output-search, /workspaces) merged --no-ff. Deferred (per Sol): profile-completion
wrapper for reliable "finished", file transfer, `cordless run`, broadcast input, read-only share, web
SearchAddon, Web Push.

## v0.6 — CLI-first

cordless is now **CLI-first**: `cordless` (no args) opens a full-screen terminal **dashboard** (a thin
client of the persistent daemon) showing daemon/Tailscale status, a **live single-use pairing QR** (with
countdown; `p` regenerates), and the session list. `Enter` attaches a session straight into the host
terminal (no xterm.js; detach `Ctrl-] d`), `n` starts one, `x` kills, `d` manages devices; `q`/`Ctrl-C`
leaves the dashboard but the daemon keeps running. The phone app scans the dashboard's QR.

- Pairing is **daemon-owned**: `pairing.create` / `pairing.cancel` over the authenticated WS, mintable
  ONLY by a `scope:"loopback"` credential from a loopback socket peer (rate-limited, 256-bit, single-use,
  5-min TTL, max 3 active). Both the dashboard and `cordless pair` call it. `agent/src/cli/` holds
  `client.js` (loopback WS client), `dashboard.js` (TUI), `attach.js`, `commands.js`, `render.js`.
- Packaged as a **self-contained `cordless.exe`** via **Node SEA** (`agent/build/sea.mjs`,
  `npm --prefix agent run sea`): esbuild bundles the CLI (node-pty external) → SEA blob → injected into a
  copy of the Node runtime; `node-pty` (ABI-stable node-api prebuilds) + the built web client ship beside
  it under `resources/`. `src/runtime.js` `IS_SEA` switches paths; `src/pty-loader.js` loads node-pty from
  `resources/`. No Node prerequisite. CI: `.github/workflows/cli.yml` builds + smoke-tests (PTY spawn) +
  zips per-OS on tag. The **Electron desktop app is now optional** (no v0.6 investment).
- Commands: `cordless` (dashboard), `--once`, `start [--foreground]` (detached by default), `stop`,
  `status`, `doctor`, `pair`, `devices [revoke]`, `sessions`, `new`, `attach <id>`, `kill <id>`,
  `install`, `uninstall`. `npm --prefix agent test` harness is 10/10.

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
