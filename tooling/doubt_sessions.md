Reviewing my implementation plan for the cordless agent's session core. Answer each numbered doubt
concretely with the correct pattern and any bug you see. Node 22+/26, node-pty, @xterm/headless +
@xterm/addon-serialize, ws.

1. SNAPSHOT TIMING: @xterm/headless Terminal.write(data) is buffered and parsed asynchronously (WriteBuffer).
   On a cold reconnect I want to serialize the terminal state. If I call serialize.serialize() immediately
   after a bunch of term.write() calls, will it miss the most recent bytes? What is the correct way to get a
   consistent snapshot — do I need to await the write callback (term.write(data, cb)) and only serialize once
   the buffer is drained? Give the exact pattern.

2. RECONNECT ORDERING: my attach handler plans to be FULLY SYNCHRONOUS: compute latestSeq = nextSeq-1;
   serialize; send snapshot frame with seq=latestSeq (reset:true); THEN register the subscriber. My claim:
   because node-pty's onData fires on a later event-loop tick (never during my synchronous function), no live
   output can interleave, so the client always gets the snapshot before any seq>latestSeq live frame, in order.
   Is this reasoning correct for Node's single-threaded model? Any hole (e.g. ws.send ordering, microtasks)?

3. INPUT ENCODING: client captures xterm onData (a JS string) and sends base64(utf8Bytes). Server does
   Buffer.from(b64,'base64').toString('utf8') then pty.write(str). Is this correct for control chars
   (Ctrl-C=0x03, ESC, arrow keys ESC[A) and pasted UTF-8, on BOTH Unix PTY and Windows ConPTY? Any case where
   I must write raw bytes instead of a utf8 string to node-pty?

4. OUTPUT ENCODING: server never utf8-decodes pty output; it sends raw bytes as base64 per frame. Client
   base64-decodes to a Uint8Array and calls term.write(uint8array). Correct to avoid splitting multibyte
   sequences across frames? xterm.js write() accepts Uint8Array and reassembles — confirm.

5. FLOW CONTROL / BATCHING: to protect a phone from a noisy build, I coalesce pty onData chunks into a
   batched output frame every ~16ms or 32KiB, each batch carrying ONE seq number (not per-chunk). Replay/ack
   is at batch granularity. Is batch-granular seq fine for the reconnect-replay + ack scheme, or does anything
   break? Also: should I watch ws.bufferedAmount and drop/disconnect a slow client? Give the threshold logic.

Keep it tight — I'm about to write sessions.js.