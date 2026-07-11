Three follow-up requirements from the user for cordless. Design/critique each with concrete decisions and
pitfalls; keep it tight and implementable. We're continuing from the shipped v0.3.1.

1. SEAMLESS RESUME + CLI DISTRIBUTION.
User: "one way to get back to the running things seamlessly when I open my system"; "Think of cordless own
distribution of cli if needed." My plan:
 (a) Make the agent a real installable CLI `cordless` with start/pair/devices + NEW `install`/`uninstall`
     (register OS autostart: Windows Task Scheduler via schtasks, systemd --user, launchd) + `stop`/`status`.
     Distribute via npm (`npm i -g cordless`) — but node-pty needs a native build on global install. Acceptable,
     or ship prebuilt / make node-pty an optionalDependency with a graceful fallback? Is `npx` viable?
 (b) SESSION RESTORE: PTYs die on daemon restart/reboot, so persist each live session's {profile, cwd, title}
     to disk and, on daemon start, relaunch the same set (fresh shells, like a browser reopening tabs), gated by
     a config flag. Combined with autostart + the app's existing auto-reconnect, opening my system brings the
     tabs back. Good enough for "seamless," or is there a materially better approach (e.g. detached session
     supervisor that truly survives daemon restarts but not reboot)? Windows Task Scheduler + node-pty prints a
     benign "AttachConsole failed" when run without a console — how do I run it cleanly windowless?

2. MOBILE TRUNCATION.
User: "when it is shown in the mobile UI, the long text to the right is getting truncated, the phone app should
show the details or way to give them either in a responsible way or scroll." Hypothesis: xterm fit sometimes
leaves cols wider than the pane, or programs emit lines wider than cols, and the pane (overflow hidden) clips
the right. Options: (a) guarantee fit on the active pane (rAF, non-zero size, on orientation/keyboard-resize)
so cols match width and xterm soft-wraps; (b) allow horizontal pan/scroll of the terminal for wide unwrapped
content; (c) responsive font size / a "fit width" control on narrow screens; (d) a details affordance for
truncated tab titles / long cwd. Which combination is right? Is enabling horizontal scroll on an xterm.js
terminal sane on mobile, or should I rely purely on reflow/soft-wrap? How do good mobile terminals (Termux,
Blink) handle wide output?

3. IN-APP QR SCANNER.
User: "The app should have internal scanner as it doesn't open for me now when scanned from system." The printed
pairing QR is http://<host>:<port>/#pair=<secret>; scanning it with the phone camera does NOT open the bundled
APK (different origin / no deep link). Plan: add an in-app "Scan QR" button on the pairing screen using a
Capacitor barcode scanner (MLKit), parse the scanned URL to extract the server origin + the #pair fragment
secret, then pair; native-only, PWA keeps tap-to-open (or BarcodeDetector if available). Questions:
 - In 2026, which is the robust pick: @capacitor/barcode-scanner vs @capacitor-mlkit/barcode-scanning? Any
   Gradle/AndroidManifest/permission gotchas, and does it need a Google Play Services / MLKit model download?
 - Should the daemon ALSO encode a custom deep-link (cordless://pair?server=...&secret=...) in the QR (or a
   second QR) so a SYSTEM-camera scan can open the app directly via an Android intent-filter, as a nicer path?
   If so, give the intent-filter + how the app reads the launch URL (Capacitor App.getLaunchUrl / appUrlOpen).

For each: the concrete decision, the exact packages/config, and the top gotchas. No fluff.