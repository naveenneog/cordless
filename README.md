# cordless

**Manage many remote terminal / coding-agent sessions from your phone — like browser tabs.**

cordless runs a small daemon on your dev box or laptop that owns real PTY sessions (a shell, or
`claude` / `codex`), and a mobile web app that attaches to them like browser tabs. Sessions keep
running when you disconnect; reconnecting replays exactly where you left off.

**Site:** [naveenneog.github.io/cordless](https://naveenneog.github.io/cordless/) · **Download:** [Android APK](https://github.com/naveenneog/cordless/releases/latest) · [Desktop app](https://github.com/naveenneog/cordless/releases/latest) (Windows / macOS / Linux)

<p align="center"><img src="docs/screenshot.png" alt="cordless" width="820"></p>

- **Persistent sessions** — PTYs survive phone disconnects, network switches, and app backgrounding.
  Reconnect replays from your last-seen byte (or a full-screen snapshot if you were away too long).
- **Tabs for terminals** — run several Claude Code / Codex / shell sessions at once, switch instantly.
- **Touch-first** — an on-screen key bar (Esc, Tab, Ctrl/Alt, arrows, Ctrl-C/D, pipes, paste), pinch-free
  font zoom (A−/A+), soft-wrapping so long lines never truncate, and a details sheet for the full cwd /
  session id. The Android app has a built-in **QR scanner** for pairing.
- **Reach it from anywhere** — Tailscale is the recommended path; same-Wi-Fi LAN also works.
- **Secure by default** — per-device tokens, single-use QR pairing, Origin allowlist, CSP, and a
  daemon that only ever runs as *you*.

> Designed and code-reviewed in tandem with GPT-5.6 Sol. See `CONTEXT.md` for the architecture and the
> full design rationale.

---

## Prerequisites

**On your dev box / laptop (the machine your agents run on):**

- Windows 11, current macOS, or a modern Linux distro.
- **Node.js 22 LTS or newer** — <https://nodejs.org/en/download> (the daemon builds `node-pty`, so a
  C/C++ toolchain is needed: Visual Studio Build Tools on Windows, Xcode CLT on macOS, `build-essential` + `python3` on Linux).
- **Tailscale** (recommended, to reach your box from anywhere) — <https://tailscale.com/download>
- PowerShell 7 is recommended on Windows — <https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows>

Optional coding agents must already be installed and on the daemon's `PATH`:

```bash
claude --version
codex --version
```

**On your phone:**

- The cordless **Android APK** — [latest release](https://github.com/naveenneog/cordless/releases/latest).
- The **Tailscale Android app** — <https://tailscale.com/download/android>

Sign the phone and the dev box into the **same tailnet**.

---

## Quick start

### 1. On your dev box / laptop (the machine your agents run on)

```bash
git clone https://github.com/naveenneog/cordless
cd cordless
npm run setup      # installs agent + client deps (builds node-pty)
npm run build      # builds the web client into agent/public
npm start          # starts the daemon on :7443
```

### 2. Pair your phone

In another terminal:

```bash
npm run pair
```

This prints a QR code (valid 15 min, single use). **Scan it with your phone's camera** — it opens the
cordless app in your browser and pairs automatically. Or open the printed URL and paste the code.

- On the same Wi-Fi, the LAN URL just works.
- To reach your box from anywhere, put the dev box **and** your phone on the same Tailscale tailnet;
  `cordless pair` will then print a stable `100.x` / `*.ts.net` URL. See **[Tailscale setup](#tailscale-setup)**
  below for the `tailscale up`, ACL, and Windows-firewall steps.

### 3. Use it

Tap **＋** to start a `Shell`, `Claude Code`, or `Codex` session. Open several. Switch tabs. Close the
app, come back later — your sessions are still there.

> **Install as an app:** in your phone browser, "Add to Home Screen" for a full-screen PWA.

---

## Desktop app

Prefer a real window on your laptop/dev box? Grab the **[desktop app](https://github.com/naveenneog/cordless/releases/latest)**
(Windows `.exe`, macOS `.dmg`, Linux `.AppImage`/`.deb`). It's a hardened Electron shell that opens the
cordless UI in its own window and talks to your **local** daemon.

- It renders the exact same UI the daemon serves, so your sessions, tabs, and replay all work identically.
- **Pairing stays QR-first.** On top of that, when the local daemon is running the desktop app shows an
  extra **🖥️ Connect to this computer** button that signs in with a loopback-only credential — a one-click
  path for the machine you're sitting at. That credential is rejected for any non-loopback address (even a
  Tailscale IP), so it can never be used remotely.
- If the daemon isn't running, the app shows a **Start daemon / Retry** screen instead of a blank window.

Build it yourself from `desktop/`:

```bash
cd desktop
npm install
npm start                # run the app against your local daemon
npm run dist             # package installers for the current OS into desktop/release/
```

The desktop app is a **client only** — it never owns PTYs. Keep the daemon started separately with
`cordless install` (see [Resume your sessions](#resume-your-sessions)).

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
cordless start [--foreground]      run the daemon (serves the app + websocket on :7443)
cordless stop                      stop the running daemon
cordless status                    is the daemon running?
cordless pair                      create a single-use pairing QR/code for a new device
cordless devices                   list paired devices
cordless devices revoke <id>       revoke a device's token
cordless install                   run the daemon automatically at login (auto-start)
cordless uninstall [--purge]       remove the auto-start registration
```

**Seamless resume:** run `cordless install` once and the daemon starts hidden at login. See
**[Resume your sessions](#resume-your-sessions)** for the full flow.

Config and state live in `~/.cordless/` (override with `CORDLESS_HOME`): `config.json`,
`devices.json`, `daemon.json`. Edit `config.json` to change `port`, `bindHost`, `maxSessions`,
`allowedOrigins`, or the `profiles`.

## Development / tests

```bash
npm test                       # spins up an isolated daemon and runs every suite:
                               #   pty smoke, protocol E2E (pair->attach->input->reconnect->kill),
                               #   security headers/Origin, desktop loopback credential + scope
                               #   enforcement, and session restore across a daemon restart
npm --prefix client run build  # rebuild the web client into agent/public
npm --prefix desktop test      # desktop credential/origin parsing unit tests
```

## Status

v0.5 — persistent sessions, touch-first mobile client, in-app QR scanner, seamless login resume, a `>_<`
brand logo, and a hardened **Electron desktop app** (Windows / macOS / Linux). Runs on a Windows / macOS /
Linux dev box with an Android or iOS phone browser. The Android APK (Capacitor) and desktop installers are
built via CI. See `CONTEXT.md` for the architecture and roadmap.

## License

[PolyForm Noncommercial 1.0.0](LICENSE) — source-available, free for noncommercial use.
