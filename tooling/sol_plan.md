## 1. ARCHITECTURE

- **Agent daemon: `cordlessd`**
  - Runs as a user-level service on each dev box.
  - Owns all PTYs, session metadata, replay buffers, authentication, TLS, and WebSocket connections.
  - Exposes one HTTPS/WSS listener on port `7443`.
  - Profiles are allowlisted: `shell`, `claude`, `codex`.
  - Advertises itself on LAN with mDNS as `_cordless._tcp`.
  - Auto-start:
    - macOS: `launchd`
    - Linux: `systemd --user`
    - Windows: Task Scheduler at login

- **Mobile client**
  - React/Vite web app wrapped with Capacitor.
  - Native pinned-TLS WebSocket plugin; messages are passed to the WebView.
  - One local xterm.js instance per open tab.
  - Stores device token and pinned daemon certificate in OS secure storage.

- **Optional relay**
  - Not part of MVP; Tailscale is the primary remote path.
  - Future relay accepts an outbound daemon tunnel and a phone connection when Tailscale cannot be installed.
  - Do not ship it until protocol traffic is end-to-end encrypted; the relay must not see terminal contents.

- **Data flow**
  1. Phone opens one WSS connection to `cordlessd`.
  2. Client authenticates with its device token.
  3. Client lists sessions and attaches the active tab.
  4. `cordlessd` reads PTY bytes, assigns sequence numbers, stores them, updates a headless terminal state, and broadcasts output.
  5. Client decodes output and writes it into xterm.js.
  6. Keystrokes and resize events travel back over the same socket.
  7. On disconnect, PTYs continue running. The client reconnects and requests output after its last applied sequence.

---

## 2. REMOTE SESSIONS

- Use **`node-pty` directly; do not use tmux**.
  - `node-pty` uses Unix PTYs on macOS/Linux and ConPTY on modern Windows.
  - `cordlessd` is already the multiplexer.
  - tmux is not consistently available on Windows and adds nested terminal state, sizing, escaping, and installation problems.
  - MVP guarantees survival of **client disconnects**, not daemon crashes or machine reboots.

- **Session process model**
  - Each session owns:
    ```ts
    {
      id: UUID,
      profile: "shell" | "claude" | "codex",
      cwd: string,
      pty: IPty,
      cols: number,
      rows: number,
      createdAt: string,
      lastActivityAt: string,
      state: "running" | "exited",
      exitCode: number | null,
      nextSeq: number,
      outputRing: OutputChunk[],
      terminalModel: HeadlessXterm
    }
    ```
  - Spawn the user’s interactive shell:
    - macOS/Linux: `$SHELL` or `/bin/bash`, login/interactive mode.
    - Windows: PowerShell 7 if present, otherwise `powershell.exe`.
  - For `claude` or `codex`, start the shell and write `claude\r` or `codex\r` after PTY creation. When the agent exits, the shell remains available.
  - `cwd` must exist and be a directory. No arbitrary executable field in MVP.

- **Concurrency**
  - One PTY per session.
  - Default maximum: 20 live sessions, configurable.
  - All PTY callbacks are event-driven; no polling.
  - A session may have multiple attached clients, but all are controllers. Show “2 devices attached” to make concurrent input visible.

- **Scrollback and replay**
  - Every PTY output callback becomes one chunk:
    ```ts
    { seq: 421, bytes: Buffer, timestamp: 1750000000000 }
    ```
  - Keep the newest **8 MiB of raw PTY output per session** in memory.
  - Also feed output into `@xterm/headless` with 10,000 scrollback lines.
  - If the requested sequence still exists, replay raw chunks after that sequence.
  - If it has expired—or this is a cold attach—serialize the headless terminal with `@xterm/addon-serialize` and send a reset snapshot.
  - Client records `lastSeq` only after xterm.js’s write callback completes.

- **Disconnect behavior**
  - Closing the socket only removes subscriptions; it never closes PTYs.
  - Closing a mobile tab detaches by default.
  - Killing a session is an explicit action.
  - On daemon shutdown, send SIGHUP/terminate to children. Daemon-crash persistence is deferred.

- **Resize**
  - The actively attached tab controls PTY dimensions.
  - Last resize wins if multiple devices are attached.
  - Clamp to `20..300` columns and `5..120` rows.

---

## 3. NETWORKING

- **Primary path: Tailscale**
  - Install Tailscale on the dev box and phone.
  - Tailscale handles NAT traversal, WireGuard encryption, changing mobile IPs, and DERP fallback.
  - Use MagicDNS:
    ```text
    wss://<machine>.<tailnet>.ts.net:7443/v1/ws
    ```
  - Example:
    ```text
    wss://workstation.tail1234.ts.net:7443/v1/ws
    ```
  - Restrict port `7443` with Tailscale ACLs to the owner’s devices.

- **LAN fallback: direct pinned TLS**
  - Discover `_cordless._tcp.local` via mDNS or use the LAN IP from the pairing QR.
  - URL:
    ```text
    wss://<lan-ip>:7443/v1/ws
    ```
  - Example:
    ```text
    wss://192.168.1.42:7443/v1/ws
    ```
  - `cordlessd` generates a long-lived local TLS key/certificate at install time.
  - The app pins the certificate’s SHA-256 SPKI fingerprint from pairing. The native WebSocket transport validates the pin instead of public-CA hostname validation.
  - Firewall installer permits `7443` only on Tailscale and private LAN interfaces, never the public interface.

- **Mobile network changes**
  - Capacitor Network/App events trigger reconnect.
  - Retry at `0, 1, 2, 5, 10, 20` seconds, then every 30 seconds with jitter.
  - Try the last successful URL first, then the other paired URL.
  - Reconnect uses the same session IDs and each tab’s `lastSeq`.

---

## 4. SECURITY / PAIRING

- **Daemon identity**
  - On first run, generate:
    - Ed25519 TLS private key and certificate.
    - Stable daemon UUID.
    - SHA-256 SPKI fingerprint.
  - Private key permissions:
    - Unix: `0600`
    - Windows: user-only ACL

- **Device authentication**
  - Each paired phone gets an independent random 256-bit bearer token.
  - Store only:
    ```ts
    {
      deviceId,
      deviceName,
      tokenHash: SHA256(token),
      createdAt,
      lastSeenAt,
      revokedAt
    }
    ```
  - Tokens are stored on the phone in Android Keystore/iOS Keychain.
  - Tokens can be individually listed and revoked from `cordless devices`.

- **Pairing UX**
  1. User runs:
     ```bash
     cordless pair
     ```
  2. CLI displays a QR containing:
     ```json
     {
       "v": 1,
       "daemonId": "uuid",
       "urls": [
         "wss://workstation.tail1234.ts.net:7443/v1/ws",
         "wss://192.168.1.42:7443/v1/ws"
       ],
       "spkiSha256": "base64...",
       "pairSecret": "base64url-256-bit",
       "expiresAt": "2026-07-10T14:05:00Z"
     }
     ```
  3. QR secret is single-use and expires after five minutes.
  4. Phone connects using the certificate pin and submits the pairing secret plus device name.
  5. Daemon prints a six-digit confirmation code; phone shows the same code and the user confirms.
  6. Daemon returns the permanent device token.

- **What blocks random attachment**
  - Tailscale makes the primary endpoint inaccessible outside the tailnet.
  - Tailscale ACL limits which tailnet devices can reach port `7443`.
  - TLS certificate pinning prevents daemon impersonation.
  - Every protocol connection requires a per-device 256-bit token.
  - Pairing secrets are short-lived and single-use.
  - Five failed authentications from an IP cause a 10-minute in-memory block.
  - Never place permanent tokens in URLs, logs, QR codes, or localStorage.

---

## 5. PROTOCOL

- JSON text frames over:
  ```text
  wss://host:7443/v1/ws
  ```
- Base envelope:
  ```ts
  type Request = {
    type: string;
    requestId: string;
    [key: string]: unknown;
  };

  type Response = {
    type: string;
    requestId: string;
    ok: boolean;
    error?: { code: string; message: string };
    [key: string]: unknown;
  };
  ```

- **Authenticate immediately after connection**
  ```json
  {
    "type": "hello",
    "requestId": "r1",
    "protocol": 1,
    "deviceId": "device-uuid",
    "token": "base64url-token"
  }
  ```
  ```json
  {
    "type": "hello.result",
    "requestId": "r1",
    "ok": true,
    "connectionId": "connection-uuid",
    "serverTime": "2026-07-10T14:00:00Z"
  }
  ```
  - Close with code `4401` if authentication fails.
  - No other request is accepted before `hello.result`.

- **List sessions**
  ```json
  {
    "type": "session.list",
    "requestId": "r2"
  }
  ```
  ```json
  {
    "type": "session.list.result",
    "requestId": "r2",
    "ok": true,
    "sessions": [{
      "sessionId": "uuid",
      "title": "claude · ~/src/app",
      "profile": "claude",
      "cwd": "/Users/me/src/app",
      "state": "running",
      "cols": 100,
      "rows": 30,
      "createdAt": "2026-07-10T13:00:00Z",
      "lastActivityAt": "2026-07-10T13:59:50Z",
      "latestSeq": 421,
      "attachedDevices": 1,
      "exitCode": null
    }]
  }
  ```

- **Create**
  ```json
  {
    "type": "session.create",
    "requestId": "r3",
    "profile": "claude",
    "cwd": "/Users/me/src/app",
    "cols": 100,
    "rows": 30,
    "title": "frontend"
  }
  ```
  ```json
  {
    "type": "session.create.result",
    "requestId": "r3",
    "ok": true,
    "sessionId": "uuid"
  }
  ```

- **Attach / reconnect with replay**
  - `fromSeq` is the last sequence fully applied by the client.
  - Use `null` for a cold attach.
  ```json
  {
    "type": "session.attach",
    "requestId": "r4",
    "sessionId": "uuid",
    "fromSeq": 390
  }
  ```
  ```json
  {
    "type": "session.attach.result",
    "requestId": "r4",
    "ok": true,
    "sessionId": "uuid",
    "replayMode": "incremental",
    "latestSeq": 421
  }
  ```

- **Output**
  - Raw PTY bytes are base64; do not assume callback boundaries are valid UTF-8.
  ```json
  {
    "type": "session.output",
    "sessionId": "uuid",
    "seq": 391,
    "data": "G1szMW0...",
    "replay": true,
    "reset": false
  }
  ```
  - If replay history is unavailable, send one serialized terminal snapshot:
  ```json
  {
    "type": "session.output",
    "sessionId": "uuid",
    "seq": 421,
    "data": "G1syShtI...",
    "replay": true,
    "reset": true
  }
  ```
  - On `reset:true`, client calls `terminal.reset()`, writes the decoded snapshot, then sets `lastSeq` to `seq`.

- **Acknowledge applied output**
  ```json
  {
    "type": "session.ack",
    "sessionId": "uuid",
    "seq": 421
  }
  ```
  - Send at most every 250 ms and when the app backgrounds.

- **Input**
  ```json
  {
    "type": "session.input",
    "requestId": "r5",
    "sessionId": "uuid",
    "data": "A2M="
  }
  ```
  ```json
  {
    "type": "session.input.result",
    "requestId": "r5",
    "ok": true
  }
  ```

- **Resize**
  ```json
  {
    "type": "session.resize",
    "requestId": "r6",
    "sessionId": "uuid",
    "cols": 112,
    "rows": 34
  }
  ```
  ```json
  {
    "type": "session.resize.result",
    "requestId": "r6",
    "ok": true
  }
  ```

- **Detach**
  ```json
  {
    "type": "session.detach",
    "requestId": "r7",
    "sessionId": "uuid"
  }
  ```

- **Kill**
  ```json
  {
    "type": "session.kill",
    "requestId": "r8",
    "sessionId": "uuid",
    "mode": "graceful"
  }
  ```
  ```json
  {
    "type": "session.kill.result",
    "requestId": "r8",
    "ok": true
  }
  ```
  - `graceful`: send SIGTERM on Unix or terminate the ConPTY process tree; force after five seconds.
  - `force`: immediate process-tree termination.

- **Asynchronous exit**
  ```json
  {
    "type": "session.exit",
    "sessionId": "uuid",
    "exitCode": 0,
    "signal": null,
    "at": "2026-07-10T14:10:00Z"
  }
  ```

---

## 6. MOBILE UX

- **Tab model**
  - Top horizontal tab strip: title, running/exited indicator, unread-output dot.
  - `+` opens a sheet for profile, recent working directory, title, and Create.
  - Closing a tab only detaches it.
  - “Kill session” is a separate long-press/menu action with confirmation.
  - A session drawer lists all live sessions, including those without an open tab.

- **Switching tabs**
  - Preserve one xterm.js instance and `lastSeq` per open tab.
  - On switch:
    1. Detach the old tab from server output.
    2. Attach the new tab from its `lastSeq`.
    3. Fit and send resize.
    4. Focus terminal input.
  - PTYs continue running while hidden.
  - Backgrounding the app closes the socket after acknowledging output; reconnect all open tabs when foregrounded, attaching only the visible tab immediately.

- **Terminal rendering**
  - Use xterm.js with WebGL renderer when available; fall back to canvas.
  - Fixed monospace font, configurable 12–18 px.
  - Pinch adjusts font size, then fits and resizes the PTY.
  - Two-finger vertical gesture scrolls terminal history without sending arrow keys.
  - Long press opens native copy/paste selection actions.

- **Touch key bar**
  - Horizontally scrollable, always above the software keyboard:
    ```text
    Esc  Tab  Ctrl  Alt  ↑  ↓  ←  →  PgUp  PgDn
    |  /  \  ~  `  -  _  =  { }  [ ]  ( )  :  ;
    ```
  - `Ctrl` and `Alt` are one-shot latches; double-tap locks them.
  - Dedicated `Ctrl-C` and `Ctrl-D` actions.
  - Paste button with confirmation when pasted text contains newlines.
  - Disable autocorrect, capitalization, smart quotes, and text suggestions.
  - Hardware keyboards pass through xterm.js normally.

---

## 7. TECH STACK

- **Agent**
  - Node.js 22 LTS + TypeScript.
  - `node-pty`: Unix PTY and Windows ConPTY.
  - `ws`: small, proven WebSocket server.
  - Node built-in `https`: TLS listener.
  - `@xterm/headless`: server-side terminal state and scrollback.
  - `@xterm/addon-serialize`: reconnect snapshots.
  - `zod`: validate every incoming message and config file.
  - `better-sqlite3`: device records, token hashes, session metadata, recent directories.
  - `pino`: structured logs with token/input/output redaction.
  - `bonjour-service`: LAN mDNS advertisement.
  - `qrcode-terminal`: CLI pairing QR.
  - `chokidar`: optional config reload; not required for PTY operation.
  - Use `child_process` only for shell/profile discovery, never to proxy terminal I/O.

- **Client**
  - React + TypeScript + Vite.
  - Capacitor.
  - `@xterm/xterm`
  - `@xterm/addon-fit`
  - `@xterm/addon-webgl`
  - `@xterm/addon-web-links`
  - Zustand for tabs, connection state, and session metadata.
  - `zod` for protocol validation.
  - Capacitor App, Network, Keyboard, Clipboard, Haptics, and Barcode Scanner plugins.
  - OS secure storage via `capacitor-secure-storage-plugin`.
  - Small custom Capacitor plugin:
    - Android: OkHttp `WebSocket`
    - iOS: `URLSessionWebSocketTask`
    - Enforces the paired SPKI pin and bridges frames to JavaScript.
  - Do not use a WebView-native `WebSocket` for LAN fallback; dynamic self-signed pinning is unreliable there.

---

## 8. MVP CUT LINE

- **MVP: genuinely useful**
  - One dev box and one Android phone.
  - Tailscale connection only.
  - QR pairing and one revocable device token.
  - Profiles: `shell`, `claude`, `codex`.
  - Create, list, attach, input, resize, detach, kill.
  - Multiple concurrent PTYs.
  - Disconnect survival and sequence-based replay.
  - xterm.js tab UI and essential touch key bar.
  - In-memory replay ring; headless snapshot support.
  - No relay, file browser, notifications, or daemon-restart persistence.

- **Increment 1**
  - LAN discovery and pinned-TLS fallback.
  - Multiple phones/dev boxes.
  - Device management/revocation.
  - Better session drawer, titles, recent directories, unread indicators.
  - Android background/foreground hardening and battery testing.

- **Increment 2**
  - iOS packaging.
  - Push notification hooks for agent attention/completion.
  - Optional end-to-end-encrypted relay.
  - File upload/download and “open repository” shortcuts.
  - Persisted session transcripts and searchable history; still do not promise live PTY survival across daemon reboot.

---

## 9. RISKS & GOTCHAS

1. **PTY behavior differs by OS**
   - ConPTY quoting, shell startup, signals, UTF-8, and process-tree killing differ from Unix.
   - Test Windows 11, macOS, and Ubuntu from week one. Keep platform-specific spawn/kill adapters and use real interactive integration tests.

2. **Replay can corrupt terminal state**
   - Replaying only a truncated ANSI suffix is invalid because cursor, modes, colors, and alternate-screen state may depend on older output.
   - Use sequence replay only while the requested chunk remains buffered; otherwise send a serialized headless-terminal reset snapshot.

3. **WebView TLS and background sockets are unreliable**
   - Self-signed certificates and mobile sleep behavior vary by WebView/OS.
   - Use the native pinned WebSocket plugin, assume sockets die in background, and make reconnect/replay the normal path rather than an exception.

4. **Flow control and noisy sessions can exhaust memory**
   - Builds and agents can emit output faster than a phone can render it.
   - Bound each raw ring to 8 MiB, batch output for up to 16 ms/32 KiB, monitor buffered socket bytes, disconnect slow consumers, and let them resume from replay/snapshot.

5. **Terminal input is effectively remote code execution**
   - Token theft grants the same authority as the logged-in user.
   - Bind only approved interfaces, use Tailscale ACLs, pin TLS, hash tokens, redact logs, provide device revocation, run `cordlessd` as the normal user, and never run it as root or Administrator.