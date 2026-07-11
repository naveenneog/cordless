Desktop app — one architecture decision before I implement, continuing our cordless work.

Constraint locked in by the owner: **QR / pairing-code stays the app's default auth.** I already implemented the loopback-scoped desktop credential exactly as you specified (daemon writes ~/.cordless/desktop-credential.json mode 0600, stores only the token hash, device scope:"loopback", and authenticate() rejects that token unless the socket peer is 127.0.0.1/::1 — verified with a test: a Tailscale 100.64.x IP is rejected). In the client's Pairing screen I added an EXPLICIT opt-in button "🖥️ Connect to this computer" that only appears when window.cordless.getLocalCredential() (Electron preload bridge) returns a credential — QR remains the default. All 7 agent test suites pass.

Now the Electron shell. Two options for what the BrowserWindow loads:

(A) Load the LOCAL daemon's served page directly: win.loadURL("http://127.0.0.1:<port>"). Same-origin to the daemon, so ZERO changes to CORS/WS-Origin/CSP. Reuses the exact client the daemon already serves (with the new >_< logo). Cost: a local daemon must be running just to render the UI; to view a REMOTE dev box the laptop must also run its own local daemon and point the Server field at the remote. Fallback screen when no local daemon (health-check fails) → "Run: cordless start" + Retry.

(B) Bundle client/dist INTO the Electron app, load via a custom scheme (cordless-app://). No local daemon needed to render UI, so a laptop with no daemon can manage a remote dev box directly. Cost: cross-origin to every daemon → I must add the Electron origin to allowedOrigins in the daemon's originAllowed() AND the bundled client's CSP connect-src must permit ws://<any-tailscale-ip>:7443. More moving parts; harder for me to verify headlessly.

My lean: ship (A) now (simplest, fully same-origin, QR preserved, verifiable), and note (B) as a future enhancement. For the primary use case — sitting at or remoting into the dev box that runs the sessions — (A) is exactly right.

Questions:
1. Do you agree (A) is the right v1, or is the "laptop needs a local daemon to view a remote box" limitation bad enough to justify (B) now?
2. If (A): confirm the secure BrowserWindow config and preload surface. My plan: BrowserWindow({ webPreferences: { preload, contextIsolation:true, nodeIntegration:false, sandbox:true, webSecurity:true } }); preload exposes ONLY { platform:"desktop", getLocalCredential(): reads ~/.cordless/desktop-credential.json via ipcRenderer.invoke and returns {deviceId,token,server}, startDaemon(): optional, invokes the installed cordless CLI path }. setWindowOpenHandler → deny all new windows; block in-page navigation to anything other than the loopback origin (will-navigate guard). Anything you'd add or forbid?
3. The port: should the desktop app read the port from desktop-credential.json (it has server/port) and loadURL that, falling back to 7443? That couples UI load to the credential file existing. Or health-check 7443 first, then read credential for the button only? I lean: health-check the configured port (default 7443, overridable), load it if healthy, else fallback screen — and expose the credential purely for the opt-in button.

Keep it concise and concrete — I'm implementing right after this.
