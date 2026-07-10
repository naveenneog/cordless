PROGRESS UPDATE — cordless is working end-to-end.

Done and browser-verified (Playwright, real Chromium against the live daemon on Windows/pwsh):
- Agent: pairing (token issue + bogus-secret reject + rate limit), hello auth, node-pty sessions
  (pwsh.exe auto-detected), 16ms/32KiB output batching (one seq/batch), 8MiB replay ring,
  @xterm/headless snapshots via a serialized op queue, reconnect incremental-replay-or-reset. E2E green.
- Client: pairing screen (auto-pairs from QR #pair= fragment), multi-tab UI, xterm per tab
  (visibility:hidden inactive, fit on activate), touch keybar (Esc/Tab/Ctrl/Alt latches/arrows/^C/^D
  /symbols/paste), reconnect with epoch guards + per-tab applyChain (reset ordered behind writes),
  appliedSeq acks, bounded hot-set (active + 3 bg) with session.detach, list-poll watchdog.
- Verified in-browser: create Shell + Claude sessions, type+echo, tab switch preserves content,
  keybar ↑ recalled history, page reload rediscovers sessions and restores the terminal via snapshot,
  auto-selects most-recent tab.

Two asks:

(A) BUG REVIEW of the final client connection layer. I'm pasting the full connection.ts below. Look
specifically for: reconnect/replay/ack races, epoch leaks, hot-set attach/detach correctness, resize
debounce bugs, ctrl/alt latch edge cases, memory leaks (terminals/timers), and anything that breaks
when the phone backgrounds mid-stream. Give concrete diffs/fixes, most-important first. If it's solid,
say so and don't invent nits.

(B) Remaining backlog priority. I still want to: (1) polish PWA install/fullscreen + safe areas,
(2) package an Android APK via Capacitor built in GitHub Actions CI (debug-signed, cordless-vX.Y.Z.apk),
(3) publish a public GitHub repo (PolyForm Noncommercial license) with a docs/ GitHub Pages landing page,
(4) auto-start scripts (systemd --user / launchd / Task Scheduler), (5) CONTEXT.md so the build resumes.
Given what's built, what's the highest-value order, and is there anything security-critical I must not
ship without? Keep it tight.

=== connection.ts ===
