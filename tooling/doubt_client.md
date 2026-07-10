I've finished and end-to-end tested the cordless AGENT (Node): pairing->token, hello auth, PTY sessions
via node-pty, 16ms/32KiB output batching with one seq per batch, 8MiB replay ring, @xterm/headless
snapshots through a serialized op queue, reconnect with incremental-replay-or-reset. All green.

Now I'm building the CLIENT (Vite + React + TS + @xterm/xterm, served by the agent same-origin;
later wrapped with Capacitor for Android). Review my client plan for correctness and give concrete
fixes. Then answer the Capacitor question.

CLIENT CONNECTION LAYER PLAN:
- One WebSocket to wss/ws://<host>/v1/ws. On open -> send hello{deviceId,token}; wait hello.result.
- Reconnect backoff [0,1,2,5,10,20, then 30s+jitter]; reconnect on 'close', on window 'online', and on
  document visibilitychange->visible.
- Tabs: Map<sessionId, Tab>. Tab = { term: Terminal, fit: FitAddon, lastSeq: number|null, unread, state }.
  Each Tab's xterm is opened ONCE into its own <div>. Inactive tab divs are display:none; active is shown.
  Only the active tab is fit()'d (hidden divs have 0 size). On tab switch: show div, fit(), send
  session.resize, focus.
- On (re)connect: for EVERY known tab send session.attach{sessionId, fromSeq:lastSeq}. Active tab first.
- Incoming session.output: decode base64 -> Uint8Array. If reset:true -> term.reset() then
  term.write(bytes, cb). Else term.write(bytes, cb). In the write CALLBACK: tab.lastSeq = frame.seq;
  scheduleAck(tab). If tab not active, tab.unread=true.
- Ack throttle: per tab, send session.ack{sessionId, seq:lastSeq} at most every 250ms, and immediately
  on visibilitychange->hidden.
- Terminal onData -> session.input{data: base64(utf8)}. Terminal onResize(from fit) -> session.resize.
- Requests use a requestId->resolver map with a timeout.

QUESTIONS:
1. Is writing to an xterm.js Terminal whose container is display:none safe (buffer updates, no crash),
   so background tabs stay current for unread + instant switch? Or must I keep them attached but visible
   offscreen? Give the robust pattern for "many live terminals, one visible".
2. Setting tab.lastSeq inside the term.write() callback: are xterm write callbacks guaranteed to fire in
   write order, so lastSeq advances monotonically and acks are correct? Any reset:true edge cases (does
   reset() need to be awaited before the following write)?
3. Attaching ALL tabs on reconnect (not just visible) so background sessions keep streaming for unread —
   is that sane, or will a noisy background build starve the UI? My server already batches 16ms/32KiB,
   8MiB ring, and drops slow sockets at 4MiB buffered. Recommend a policy.
4. Any race between reconnect re-attach (which may send reset snapshot) and queued acks/inputs from the
   previous connection? How to cleanly reset per-tab connection state on socket close.
5. resize storm: fit() on every window resize / keyboard show. Debounce policy and clamp?

CAPACITOR QUESTION (decide, don't list options):
The agent serves the web client and the phone reaches it over Tailscale as http://<tailscale-ip>:7443
(ws:// on same origin; WireGuard already encrypts). For the Android APK via Capacitor, what's the
SIMPLEST correct networking setup so the packaged app can hit ws://<tailscale-ip>:7443? Capacitor
Android serves the app from https://localhost by default, which would make ws:// mixed-content/cleartext
blocked. Give the exact capacitor.config + AndroidManifest/network-security-config needed, OR tell me to
point Capacitor server.url at the agent. I build APKs via GitHub Actions CI (debug-signed). Keep it to
the concrete config.

Terse. Concrete fixes and exact config only.