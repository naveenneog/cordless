// Unit tests for the notifier: anti-spam decisions + ntfy/webhook delivery (injected fetch, no network).
import { Notifier } from "../src/notifier.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log("FAIL:", m); } };
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0); // fixed noon UTC for deterministic quiet-hours

const on = (extra = {}) => ({ enabled: true, provider: "ntfy", url: "https://ntfy.sh", topic: "secret-topic", events: ["prompt", "bell", "finished"], ...extra });
const sess = (id, rev) => ({ id, attentionRevision: rev, title: "t", profile: "codex", cwd: "/x", attentionConfidence: "high" });

// --- decide(): gating logic ---
ok(new Notifier({ enabled: false }).decide(sess("a", 1), "prompt", NOW).why === "disabled", "disabled");
ok(new Notifier(on({ events: ["prompt"] })).decide(sess("a", 1), "bell", NOW).why === "event-filtered", "event filtered");
ok(new Notifier(on()).decide(sess("a", 1), "prompt", NOW).ok === true, "first notify allowed");
{
  const n = new Notifier(on());
  n._perSession.set("a", { rev: 5, at: NOW - 1000 });
  ok(n.decide(sess("a", 5), "prompt", NOW).why === "same-revision", "same revision suppressed");
  ok(n.decide(sess("a", 6), "prompt", NOW).why === "cooldown", "per-session 60s cooldown");
  ok(n.decide(sess("a", 6), "prompt", NOW + 61_000).ok === true, "allowed after cooldown");
}
{
  const n = new Notifier(on());
  for (let i = 0; i < 5; i++) n._recent.push(NOW - 1000);
  ok(n.decide(sess("b", 1), "prompt", NOW).why === "burst", "global burst cap (5/min)");
}
{
  const n = new Notifier(on({ quietHours: { start: "08:00", end: "18:00" } }));
  ok(n.decide(sess("c", 1), "prompt", NOW).why === "quiet-hours", "quiet hours (noon inside 08-18)");
  const n2 = new Notifier(on({ quietHours: { start: "22:00", end: "07:00" } }));
  ok(n2.decide(sess("c", 1), "prompt", NOW).ok === true, "overnight quiet window excludes noon");
}

// --- delivery: ntfy ---
{
  const calls = [];
  const n = new Notifier(on({ token: "tok" }), { fetchImpl: async (url, opts) => { calls.push({ url, opts }); return { ok: true }; } });
  const r = await n.maybeNotify(sess("d", 1), "prompt");
  ok(r.ok, "ntfy maybeNotify ok");
  ok(calls.length === 1 && calls[0].url === "https://ntfy.sh/secret-topic", "posts to <url>/<topic>");
  ok(calls[0].opts.headers.Title.includes("cordless"), "sets Title header");
  ok(calls[0].opts.headers.Priority === "high", "prompt is high priority");
  ok(calls[0].opts.headers.Authorization === "Bearer tok", "sends bearer token");
  ok(/Waiting for input/.test(calls[0].opts.body), "body describes the reason");
  // second call, same revision -> no send
  const r2 = await n.maybeNotify(sess("d", 1), "prompt");
  ok(!r2.ok && r2.why === "same-revision" && calls.length === 1, "no duplicate for same revision");
}

// --- delivery: webhook ---
{
  const calls = [];
  const n = new Notifier(on({ provider: "webhook", webhookUrl: "https://hook.example/x" }), { fetchImpl: async (url, opts) => { calls.push({ url, opts }); return { ok: true }; } });
  await n.maybeNotify(sess("e", 1), "finished");
  ok(calls.length === 1 && calls[0].url === "https://hook.example/x", "posts to webhookUrl");
  const body = JSON.parse(calls[0].opts.body);
  ok(body.event === "session.attention" && body.attention === "finished" && body.sessionId === "e", "webhook JSON payload");
  ok(!("output" in body) && !("lastLine" in body), "no terminal output in webhook by default");
}

// --- no target configured -> graceful failure ---
{
  const n = new Notifier(on({ topic: "" }), { fetchImpl: async () => ({ ok: true }) });
  const r = await n.maybeNotify(sess("f", 1), "prompt");
  ok(!r.ok && r.why === "send-failed", "missing ntfy topic -> send-failed (not a crash)");
}

console.log(`\n=== NOTIFIER ${fail === 0 ? "PASS" : "FAIL"} (${pass} ok, ${fail} bad) ===`);
process.exit(fail === 0 ? 0 : 1);
