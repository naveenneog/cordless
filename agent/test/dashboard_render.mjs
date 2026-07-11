// Pure render tests for the dashboard (no daemon needed). NO_COLOR set before importing render.
process.env.NO_COLOR = "1";
const { buildFrame, countdown, qrLines } = await import("../src/cli/render.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log("FAIL:", m); } };

ok(/^01:\d\d$/.test(countdown(new Date(Date.now() + 90_000).toISOString())), "countdown formats MM:SS");
ok(countdown(new Date(Date.now() - 1000).toISOString()) === "expired", "countdown reports expired");
ok(qrLines("http://x/#pair=abc").length > 5, "qrLines returns QR rows");

const state = {
  daemon: { running: true, version: "0.6.0" },
  port: "7443",
  tailscale: { connected: true, host: "100.1.2.3" },
  reachUrl: "http://100.1.2.3:7443",
  pairing: {
    preferredUrl: "http://100.1.2.3:7443/#pair=thesecret",
    code: "thesecret",
    route: { kind: "tailscale", host: "100.1.2.3" },
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  },
  pairingError: null,
  sessions: [{ sessionId: "abc12345", profile: "claude", title: "api", state: "running" }],
  selected: 0,
  message: null,
  now: Date.now(),
};

const frame = buildFrame(state, 80, 40).join("\n");
ok(frame.includes("cordless"), "frame shows the brand");
ok(frame.includes("Pair a phone"), "frame has the pairing section");
ok(frame.includes("Sessions (1)"), "frame shows the session count");
ok(frame.includes("claude"), "frame lists the session profile");
ok(frame.includes("100.1.2.3"), "frame shows the reachable host");
ok(!frame.includes("\x1b["), "NO_COLOR: frame has no ANSI escape codes");

const small = buildFrame(state, 40, 20).join("\n");
ok(small.includes("enlarge"), "small terminal hides the QR and prompts to enlarge");

console.log(`\n=== DASHBOARD-RENDER ${fail === 0 ? "PASS" : "FAIL"} (${pass} ok, ${fail} bad) ===`);
process.exit(fail === 0 ? 0 : 1);
