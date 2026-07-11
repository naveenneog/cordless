import { useEffect, useRef, useState } from "react";
import { Creds, saveCreds, getServerBase, setServerBase, defaultDeviceName } from "../lib/storage";
import { isNativePlatform, scanPairingQr, parsePairPayload } from "../lib/scan";

export function Pairing({
  onPaired,
  prefill,
}: {
  onPaired: (c: Creds) => void;
  prefill?: { server: string; secret: string } | null;
}) {
  const [server, setServer] = useState(getServerBase());
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const autoTried = useRef(false);
  const native = isNativePlatform();

  useEffect(() => {
    // 1) same-origin PWA QR (#pair=…) auto-pair
    const m = (location.hash || "").match(/pair=([A-Za-z0-9_-]+)/);
    if (m && !autoTried.current) {
      autoTried.current = true;
      setSecret(m[1]);
      void pair(getServerBase(), m[1]);
      return;
    }
    // 2) deep-link prefill (cordless://) — fill + auto-pair
    if (prefill && !autoTried.current) {
      autoTried.current = true;
      setServer(prefill.server);
      setSecret(prefill.secret);
      void pair(prefill.server, prefill.secret);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);

  async function pair(base: string, sec: string) {
    const clean = base.replace(/\/$/, "");
    setBusy(true);
    setError("");
    try {
      const res = await fetch(clean + "/v1/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pairSecret: sec.trim(), deviceName: defaultDeviceName() }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "pairing failed");
      setServerBase(clean);
      const creds: Creds = { deviceId: data.deviceId, token: data.token, daemonId: data.daemonId };
      saveCreds(creds);
      history.replaceState(null, "", location.pathname + location.search);
      onPaired(creds);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onScan() {
    setError("");
    try {
      const raw = await scanPairingQr();
      const { serverBase, secret: sec } = parsePairPayload(raw);
      setServer(serverBase);
      setSecret(sec);
      if (confirm(`Pair with ${serverBase}?`)) await pair(serverBase, sec);
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (!/cancel/i.test(msg)) setError(msg);
    }
  }

  return (
    <div className="pairing">
      <div className="pairing-card">
        <div className="brand">cordless</div>
        <p className="tagline">Your remote terminals, in your pocket.</p>
        <ol className="steps">
          <li>
            On your dev box: <code>cordless pair</code>
          </li>
          <li>{native ? "Tap Scan QR, or enter the code below." : "Scan the QR (opens this screen), or enter the code below."}</li>
        </ol>

        {native && (
          <button className="scan" onClick={onScan} disabled={busy}>
            📷 Scan QR
          </button>
        )}

        <label>Server</label>
        <input
          value={server}
          onChange={(e) => setServer(e.target.value)}
          placeholder="http://100.x.y.z:7443"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <label>Pairing code</label>
        <input
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder="paste pairing code"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <button className="primary" disabled={busy || !secret} onClick={() => pair(server, secret)}>
          {busy ? "Pairing…" : "Pair device"}
        </button>
        {error && <div className="error">{error}</div>}
      </div>
    </div>
  );
}
