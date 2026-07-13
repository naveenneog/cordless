# Status + next-stage design consult

## Done since last time (v0.7.1 prep, all tested, per-feature branches merged --no-ff)
1. **Seamless resume bug fixed.** Root cause: the dashboard's 1s refresh `setInterval` called `render()` during an attach (it only checked `mode`, not whether the dashboard screen was active), repainting the dashboard over the attached PTY. Fix: guard the timer with `!state.interactive` (set false between `leave()` and `enter()` during attach). Added `cordless resume` / `cordless attach` (no-arg) = jump into the most-recently-active running session.
2. **Regression test for it (phase C):** drives the *real* path through a node-pty — open dashboard → Enter to attach → type into the live session while the refresh timer keeps ticking → assert the unique dashboard footer `enter attach` never reappears over the session → detach → dashboard returns. 18/18 harness green, stable across repeated runs.
3. **`cordless setup` self-installer** (installs the binary to a stable dir, adds it to User PATH idempotently, registers autostart) + `Install cordless.cmd` in the zip. Also made `pty_smoke`/`output`/attention tests robust (wait-for-prompt + poll instead of fixed sleeps).
4. Bumped to **0.7.1**.

Attach already replays a snapshot on connect (`session.attach fromSeq:null` → daemon sends `reset:true` + retained buffer), so you see your prior scrollback. Across a **daemon restart** the session is restored (same id, new generation, re-opened PTY) — but the pre-restart scrollback is in-memory and NOT persisted, so after a restart the snapshot shows a fresh prompt, not the old output. **Q1: is that acceptable for "seamless", or should I persist a capped scrollback to disk per session so resume-after-reboot shows history? If yes, what cap (e.g. last 2000 lines / 256KB) and where — alongside the session manifest?**

## Roadmap to design now (the user asked for these, in priority order)
Please give me a concrete recommendation (data model + UX + edge cases) for each. Keep it CLI-first; the phone is a thin client of the same daemon.

**A. Custom launchers.** Today profiles are hardcoded (`shell`, `claude`, `codex`). I want user-defined ones in `~/.cordless/config.json`, e.g.
```json
"profiles": {
  "copilot": { "command": "copilot", "args": [], "cwd": null, "env": {} },
  "my-repo": { "command": "pwsh", "args": ["-NoLogo"], "cwd": "C:/src/app" }
}
```
Q2: merge strategy with built-ins (user overrides win?), validation (reject if `command` not on PATH? warn only?), and how `cordless new <profile>` + the dashboard "n new" picker should surface them. Any security note beyond "it's the user's own box"?

**B. "Agency Copilot" = GitHub Copilot CLI as a default profile.** I want to ship a built-in `copilot` profile alongside `claude`/`codex`. Q3: what launch command/args are correct for the GitHub Copilot CLI, and should its "attention" detection (waiting-for-input) reuse the same prompt heuristics as claude/codex or does it need its own?

**C. Rename tabs later.** Add `session.rename {sessionId, title}` over WS, persist in the manifest, dashboard key `e` to edit inline (free key), phone long-press. Q4: anything to watch for — title length cap, sanitizing control chars, broadcasting the rename to other connected clients?

**D. Chrome-mobile-style tab groups when >10 sessions.** This is the big one. Q5: what grouping model do you recommend — auto-group by `profile` and/or `cwd`/workspace, manual named groups, or both? How should groups render in a **TUI dashboard** (collapse/expand? a group header row?) vs the **phone** (Chrome-like grid with group chips)? Give me the session/group data model (do groups live in the manifest as `groupId` on each session + a `groups` map?) and the minimal first version to ship.

## Sequencing
Q6: ship **0.7.1 now** (the resume + installer fixes) and do A–D as **0.8.0**, or bundle? I'm leaning: release 0.7.1 immediately, then A, B, C as small features and D as its own bigger feature, each on a branch, culminating in 0.8.0. Push back if you'd order differently.

Be concrete and terse — I'll implement directly from your answer.
