Starting a focused v0.7 sprint on cordless: stabilize + add features that are genuinely useful to CODERS and competitive. You know the whole design. Be decisive and concrete — this is the plan I build from.

Where we are (v0.6, shipped): CLI-first. `cordless` opens a full-screen TUI dashboard (thin client of a persistent daemon) with daemon/Tailscale status, a live single-use pairing QR, and a session list; Enter attaches a PTY straight into the host terminal (detach Ctrl-] d). Daemon owns PTYs + pairing (loopback-only mint). Sessions: shell / claude / codex profiles. Self-contained cordless.exe via Node SEA (own Node + node-pty, no prerequisite), Windows+Linux binaries + APK shipped. Phone app (Capacitor) connects over Tailscale/LAN and shows the same sessions with a touch keybar. Replay ring + headless-xterm snapshots for reconnect.

The PURPOSE (owner's words): manage MANY Claude Code / Codex / shell sessions "like browser tabs" from the phone and the terminal. So the differentiator is juggling lots of long-running coding-agent sessions.

DEBATE + ANSWER concretely:

Q1 - PRIORITIZED v0.7 FEATURE SET. Rank the highest-leverage features that make cordless genuinely useful to coders and competitive vs tmux, Warp, sshx, VS Code tunnels/Remote, mosh. My candidates:
  (a) Per-session ATTENTION STATE (working / idle / waiting-for-input / finished / bell) surfaced in the dashboard + phone list + as a badge — so across 8 agent sessions you can see at a glance "Codex in ~/api is waiting for you." I think this is THE differentiator.
  (b) NOTIFICATIONS/push when a session needs attention (agent finished or is waiting) — the payoff of "manage them on my app": get pinged instead of babysitting.
  (c) Scrollback SEARCH / find-in-session.
  (d) FILE up/download to a session's cwd.
  (e) `cordless run "<cmd>"` one-shot in a session (scriptable).
  (f) Named sessions / workspaces / reopen-closed.
  Pick the top 3-4 for v0.7 and say what to defer. Bias toward the agent-juggling use case.

Q2 - ATTENTION-STATE DETECTION (the technically interesting core). I want the SERVER to infer each session's state from PTY output, cross-platform, WITHOUT requiring shell integration or OSC hooks (though I can use them if present). Design a robust, low-false-positive heuristic:
  - "working": output produced within the last N seconds.
  - "idle": no output for N seconds after having been active.
  - "waiting-for-input": harder. Ideas: the PTY emitted a prompt-like tail and then went quiet; detect a trailing prompt via the headless-xterm buffer's last non-empty line (regex for common shells + Claude Code / Codex "Do you want to proceed?/(y/n)" style prompts); or bytes-idle + cursor at a prompt. How would you detect "the agent is asking me something" reliably enough to notify, with few false positives?
  - "bell": the PTY wrote 0x07 (BEL) — a strong explicit signal; many CLIs ring the bell on completion/attention.
  - "finished/exited": process exit.
  Give a concrete algorithm (timers, thresholds, what to read from the @xterm/headless serialize/buffer), where it lives (SessionManager), how it's debounced, and how state changes are pushed to clients (a new `session.state`/`session.activity` frame + inclusion in session.list). Watch for false positives (a long silent build is "idle" not "waiting"; pagers; TUIs like vim/htop that repaint constantly).

Q3 - NOTIFICATIONS architecture for v0.7. The phone should get pinged when a session needs attention. Options: (i) in-app unread/attention badges from the state above (already useful), (ii) OS notifications from the desktop dashboard, (iii) real push to the phone. For a Capacitor Android app + a self-hosted daemon with no cloud, what's the pragmatic path — local notifications when the app is foreground/backgrounded via the WS, an optional user-configured ntfy.sh topic or generic webhook the daemon POSTs to, and/or Web Push? Recommend a v0.7 cut that works without standing up cloud infra, plus how to avoid notification spam (per-session cooldown, only notify on transitions to waiting/finished/bell, respect a quiet toggle).

Q4 - Anything I'm missing that coders would love and is cheap to add given the existing replay-ring + snapshot + WS protocol? (e.g., session activity in the tab title, "copy last output", input broadcast to selected sessions, a read-only share link.)

Keep it tight and implementable. I'll build the top items on separate feature branches with tests.
