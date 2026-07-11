# cordless

**A CLI-first remote terminal. Run `cordless`, scan the QR on its starting screen, and drive your dev‑box coding sessions from your phone.**

cordless is a single self‑contained command you install on your dev box or laptop. Run it and it opens a
proper terminal **dashboard** whose starting screen shows a **pairing QR** — scan it with the cordless phone
app and your sessions (a shell, `claude`, or `codex`) are in your pocket. Sessions keep running when you
disconnect; the daemon stays up after you close the dashboard, and reconnecting replays where you left off.

**Site:** [naveenneog.github.io/cordless](https://naveenneog.github.io/cordless/) · **Download:** [cordless CLI](https://github.com/naveenneog/cordless/releases/latest) (Windows / macOS / Linux — no Node needed) · [Android APK](https://github.com/naveenneog/cordless/releases/latest)

<p align="center"><img src="docs/screenshot.png" alt="cordless" width="820"></p>

- **CLI‑first** — `cordless` is a full‑screen terminal dashboard: daemon status, a live single‑use pairing
  QR with countdown, and your session list — all in the terminal. No GUI required on the dev box.
- **One self‑contained binary** — ships with its own Node runtime **and** `node-pty`; nothing to install first.
- **Persistent sessions** — PTYs survive phone disconnects, network switches, and app backgrounding.
  Reconnect replays from your last‑seen byte (or a full‑screen snapshot if you were away too long).
- **Attach from anywhere** — `cordless attach <id>` streams a session straight into your terminal (detach
  with `Ctrl‑] d`); the phone app gives you the same sessions with a touch key bar and QR scanner.
- **Reach it from anywhere** — Tailscale is the recommended path; same‑Wi‑Fi LAN also works.
- **Secure by default** — per‑device tokens, single‑use pairing codes that only the **local** daemon can
  mint (loopback‑only), Origin allowlist, CSP, and a daemon that only ever runs as *you*.

> Designed and code‑reviewed in tandem with GPT‑5.6 Sol. See `CONTEXT.md` for the architecture and the
> full design rationale.

---

## Prerequisites

**On your dev box / laptop:** nothing — the cordless CLI is a self‑contained binary (its own Node runtime +
`node-pty`). Optionally:

- **Tailscale** to reach your box from anywhere — <https://tailscale.com/download>
- Coding agents on `PATH` if you want those profiles: `claude --version`, `codex --version`
- (Only to **build from source**: Node.js 22+ and a C/C++ toolchain for `node-pty`.)

**On your phone:**

- The cordless **Android APK** — [latest release](https://github.com/naveenneog/cordless/releases/latest).
- The **Tailscale Android app** (for access from anywhere) — <https://tailscale.com/download/android>

Sign the phone and the dev box into the **same tailnet**.

---

## Quick start

### 1. Install cordless on your dev box / laptop

Download the **cordless CLI** for your OS from the [latest release](https://github.com/naveenneog/cordless/releases/latest) and unpack it:

| OS | Asset | Run |
| --- | --- | --- |
| Windows | `cordless-cli-windows-x64.zip` | `cordless.exe` |
| macOS | `cordless-cli-macos-arm64.tar.gz` | `./cordless` |
| Linux | `cordless-cli-linux-x64.tar.gz` | `./cordless` |

It's a **single self‑contained executable** — no Node install required. Put it on your `PATH`, then:

```bash
cordless            # opens the dashboard: status + a pairing QR + your sessions
cordless install    # keep the daemon running at login, so your sessions are always there
```

### 2. Pair your phone

The dashboard's starting screen shows a **QR**. Install the cordless Android app, tap **Scan QR**, and scan
it. (Or press `p` for a fresh code, run `cordless pair` for a one‑shot QR, or open the printed URL in your
phone browser as a PWA.)

### 3. Use it

In the dashboard: `↑/↓` select a session, `Enter` to attach, `n` to start a shell / Claude / Codex, `x` to
kill, `q` to leave (the daemon keeps running). From the phone, tap **＋** for a new session and switch tabs.
Close everything, come back later — your sessions are still there.

<details><summary>Prefer to run from source (Node 22+)?</summary>

```bash
git clone https://github.com/naveenneog/cordless
cd cordless
npm run setup      # installs agent + client deps (builds node-pty)
npm run build      # builds the web client into agent/public
npm start          # starts the daemon on :7443 — then run `node agent/src/index.js` for the dashboard
```

Build a self‑contained binary from source with `npm --prefix agent run sea` (output in `agent/dist-sea/`).

</details>

---

## Desktop app (optional)

Prefer a windowed app? There's also an experimental **[desktop app](https://github.com/naveenneog/cordless/releases/latest)**
(Electron; Windows `.exe`, macOS `.dmg`, Linux `.AppImage`/`.deb`) that opens the same UI in a window and
talks to your local daemon with the loopback credential. The **CLI is the primary product**; the desktop
app receives no further investment for now.

---

## Networking

| Path | When | URL |
| ---- | ---- | --- |
| **Tailscale** (recommended) | Anywhere (cellular, other Wi-Fi) | `http://<name>.<tailnet>.ts.net:7443` |
| **LAN** | Same Wi-Fi as the dev box | `http://<lan-ip>:7443` |

WireGuard (Tailscale) already encrypts traffic end-to-end, so the MVP speaks plain `ws://` over the
tunnel. Do **not** expose port `7443` on the public internet.

## Tailscale setup

Install Tailscale on the dev box (and the phone), then authenticate the dev box:

```bash
tailscale up
tailscale status
tailscale ip -4          # your 100.x address — the phone connects to http://<that>:7443
```

Optionally tag the dev box so an ACL can target it:

```bash
tailscale up --advertise-tags=tag:cordless-devbox
```

Approve the tag/device in the Tailscale admin console if prompted. The phone then connects to:

```text
http://<tailscale-100.x-address>:7443
ws://<tailscale-100.x-address>:7443/v1/ws
```

### Tailnet ACL (lock port 7443 to your own devices)

Merge this into your tailnet policy (replace the email with your Tailscale identity):

```json
{
  "groups": { "group:cordless-owner": ["owner@example.com"] },
  "tagOwners": { "tag:cordless-devbox": ["group:cordless-owner"] },
  "grants": [
    {
      "src": ["group:cordless-owner"],
      "dst": ["tag:cordless-devbox"],
      "ip": ["tcp:7443"]
    }
  ]
}
```

This permits only devices authenticated as you to reach TCP `7443` on tagged cordless boxes. cordless's
per-device token auth still applies — the ACL is an *additional* network boundary.

### Windows Firewall

The daemon must listen on the Tailscale interface (set `bindHost` in `~/.cordless/config.json`, or leave
the default all-interfaces bind). Then allow `7443` **only** on the Tailscale adapter — run PowerShell as
Administrator:

```powershell
$adapter = Get-NetAdapter |
  Where-Object InterfaceDescription -Match 'Tailscale' |
  Select-Object -First 1
if (-not $adapter) { throw "Tailscale network adapter not found" }

New-NetFirewallRule `
  -DisplayName "cordless via Tailscale" `
  -Direction Inbound -Action Allow -Protocol TCP -LocalPort 7443 `
  -InterfaceAlias $adapter.Name `
  -RemoteAddress 100.64.0.0/10 `
  -Profile Any
```

Verify with `Get-NetFirewallRule -DisplayName "cordless via Tailscale"`. Do **not** create a
public-interface-wide rule for `7443`.

## Resume your sessions

Install the daemon as a per-user login service **once**, so it's always there when you open your machine:

```bash
npm install -g @naveenneog/cordless   # or: npm run build && npm run start from a clone
cordless install                      # auto-start at login (Task Scheduler / systemd --user / launchd)
cordless status
```

After you log in, cordless is already running in the background. Open **either**:

- **Desktop app:** launch *cordless* — one click on **🖥️ Connect to this computer**.
- **Browser / phone:** `http://localhost:7443` locally, or `http://<tailscale-100.x>:7443` from your phone.

The client automatically lists and reattaches to existing sessions. Phone/browser disconnects never stop
your PTYs — missed output is restored from the replay buffer (or a full-screen snapshot if you were away
too long).

After a **daemon restart or machine reboot**, cordless *reopens* the sessions in its restore manifest with
the same session IDs, profile, cwd, title, and dimensions. These are **fresh** PTYs, though: previously
running child processes, shell variables, and unsaved interactive state cannot survive a reboot.

## Security model

- **Per-device tokens** — each paired phone gets its own random 256-bit token; only its SHA-256 hash is
  stored on the dev box (`~/.cordless/devices.json`). Revoke any device with `cordless devices revoke <id>`.
- **Pairing** — single-use, 15-minute, rate-limited secrets. The secret travels in the QR/URL *fragment*,
  so it is never sent to (or logged by) the server. The permanent token is returned once and stored in
  the phone's local storage.
- **Loopback-only desktop credential** — the desktop app's "Connect to this computer" shortcut uses a
  `scope:"loopback"` token written to `~/.cordless/desktop-credential.json` (mode `0600`; the daemon keeps
  only its hash). The daemon accepts it **only** when the actual socket peer is `127.0.0.1`/`::1` — a
  Tailscale or LAN address is rejected — so it's a local convenience, never a remote bypass of QR pairing.
- **Origin allowlist** — WebSocket and pairing requests from foreign browser origins are rejected
  (defends against malicious pages / DNS-rebinding). Native app and same-origin requests are allowed.
- **Headers** — strict CSP (`script-src 'self'`, no inline scripts), `nosniff`, `frame-ancestors 'none'`,
  and `no-store` on credential-bearing responses.
- **Least privilege** — the daemon warns if run as root/Administrator. A paired device has the same
  shell access as your user account, so treat tokens like SSH keys.
- **Server-side validation** — only the allow-listed profiles (`shell`/`claude`/`codex`) can be launched;
  there is no arbitrary-command field.

## CLI

```
cordless                           open the dashboard (status + pairing QR + sessions)
cordless --once                    print one dashboard frame and exit (non-interactive)

cordless start [--foreground]      start the daemon (detached by default; --foreground = the service)
cordless stop                      stop the running daemon
cordless status                    is the daemon running?
cordless doctor                    diagnose daemon / Tailscale / firewall / profiles

cordless pair                      show a single-use pairing QR/code for a new device
cordless devices                   list paired devices
cordless devices revoke <id>       revoke a device's token

cordless sessions [--attention]    list sessions (or only those needing attention)
cordless new [shell|claude|codex]  start a session (--cwd <dir> --title <t>)
cordless attach <id>               attach to a session (detach: Ctrl-] then d)
cordless output <id> [--lines N] [--copy]   print/copy a session's last output
cordless search <id> <query>       search a session's retained scrollback
cordless kill <id>                 stop a session
cordless workspace <save|open|list|delete> [name]   named session templates

cordless notify [status|test]      attention notifications (ntfy / webhook)

cordless install                   run the daemon automatically at login (auto-start)
cordless uninstall [--purge]       remove the auto-start registration
```

**Attention state — juggle many agents.** cordless watches each session's output and infers whether it
is **working**, **idle**, or **waiting for you** (a confirmation prompt, a bell, or an agent that just
finished). The dashboard badges and sorts attention-first (`! waiting`, `‼ bell`, `✓ finished`), so across
eight Claude/Codex sessions you can see at a glance which one needs you; press `c` to mark it handled. It's
conservative — a silent build is *idle*, and a bare shell prompt is *readiness*, not a request. Opt into a
push when a session needs you by configuring **ntfy** or a **webhook** in `config.json` (`cordless notify
test` to verify) — no cloud owned by cordless, strict anti-spam.

**The dashboard** (`cordless`, no args) is a full-screen TUI and a *thin client* of the persistent
daemon — leaving it (`q` / `Ctrl‑C`) never stops the daemon, your PTYs, or the phone connection. It shows
daemon/Tailscale status, a **live single‑use pairing QR** (with a countdown; press `p` to regenerate), and
your attention-sorted session list; `↑/↓` selects, `Enter` attaches, `n` starts one, `c` marks handled,
`x` kills, `d` manages devices.

**Seamless resume:** run `cordless install` once and the daemon starts hidden at login. See
**[Resume your sessions](#resume-your-sessions)** for the full flow.

Config and state live in `~/.cordless/` (override with `CORDLESS_HOME`): `config.json`,
`devices.json`, `daemon.json`. Edit `config.json` to change `port`, `bindHost`, `maxSessions`,
`allowedOrigins`, or the `profiles`.

## Development / tests

```bash
npm --prefix agent test        # spins up an isolated daemon and runs every suite: pty smoke, dashboard
                               #   render, protocol E2E, security, desktop credential + loopback scope,
                               #   daemon-owned pairing, CLI client, and session restore across a restart
npm --prefix client run build  # rebuild the web client into agent/public
npm --prefix agent run sea     # build the self-contained cordless binary into agent/dist-sea
npm --prefix desktop test      # desktop credential/origin parsing unit tests
```

## Status

v0.7 — **CLI‑first with attention state.** `cordless` is a self‑contained binary (its own Node runtime +
`node-pty`, no prerequisite) that opens a full‑screen terminal **dashboard** with a live pairing QR,
in‑terminal attach, and — the differentiator — **per‑session attention state** (working / idle / waiting /
bell / finished) so you can juggle many Claude/Codex sessions and see which needs you. Plus optional
**ntfy/webhook notifications**, **copy last output** + **scrollback search**, and named **workspaces**.
Daemon‑owned single‑use pairing (loopback‑minted); persistent daemon with login autostart + session
restore. Ships the self‑contained CLI (Windows / Linux; macOS built but pending a `node-pty` fix), the
Android APK, and an optional Electron desktop app, all via CI. See `CONTEXT.md` for the architecture.

## License

[PolyForm Noncommercial 1.0.0](LICENSE) — source-available, free for noncommercial use.
