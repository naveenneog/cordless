# cordless

**A CLI-first remote terminal.** Run `cordless` on your dev box, scan the QR, and drive many
**Claude Code**, **Codex**, **GitHub Copilot**, and shell sessions from your phone — like browser
tabs for your terminal.

- 🖥️ **CLI-first** — a full-screen dashboard: daemon status, a live pairing QR, and your sessions.
- 👀 **Attention state** — infers which agent is *working*, *idle*, or *waiting for you*, and can ping
  your phone (ntfy / webhook).
- ♾️ **Persistent sessions** — PTYs survive disconnects and reboots; reconnect replays where you left off.
- 🗂️ **Tabs & groups** — open a session in a new terminal tab (`o`), group them Chrome-mobile-style.
- 🔒 **Secure by default** — per-device hashed tokens, single-use pairing codes, Origin allowlist, and a
  daemon that only ever runs as you. Reach it over Tailscale or LAN — never the public internet.

## Quick start

```bash
# try it without installing
npx @naveenneog/cordless          # opens the dashboard + a pairing QR

# or install the command globally
npm install -g @naveenneog/cordless
cordless                           # dashboard + pairing QR
```

Then install the phone app from the [releases](https://github.com/naveenneog/cordless/releases/latest),
tap **Scan QR**, and your sessions are in your pocket.

```bash
cordless help            # full command reference
cordless new claude      # start a Claude Code session
cordless attach <id>     # attach in this terminal (detach: Ctrl-] then d)
cordless install         # start the daemon automatically at login
```

## Requirements

Node.js **≥ 20**. cordless depends on [`node-pty`](https://www.npmjs.com/package/node-pty), which ships
prebuilt binaries for common platforms (Windows / macOS / Linux, x64 / arm64) — so `npx` and
`npm install` work without a compiler. On an unsupported platform, `node-pty` builds from source, which
needs Python and a C/C++ toolchain.

> **Tip:** `npx` runs from a temporary cache — great for trying cordless or one-off use. For a daemon
> that autostarts at login, install globally (`npm i -g @naveenneog/cordless`) then run `cordless install`.
> A self-contained binary (no Node needed), a Chocolatey package, a desktop app, and an Android APK are
> also on the [releases page](https://github.com/naveenneog/cordless/releases/latest).

## Links

- 🌐 **Site:** https://naveenneog.github.io/cordless/
- 💻 **Source:** https://github.com/naveenneog/cordless
- 📦 **Releases** (CLI binary / desktop / APK): https://github.com/naveenneog/cordless/releases/latest

## License

[PolyForm Noncommercial 1.0.0](https://github.com/naveenneog/cordless/blob/main/LICENSE) — free for
noncommercial use.
