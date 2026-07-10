// Consult GPT-5.6 Sol (Azure AI Foundry) to co-design the cordless architecture.
// Auth: AAD bearer via `az account get-access-token --resource https://cognitiveservices.azure.com`.
import fs from "node:fs";

const ENDPOINT = "https://REDACTED-AZURE-RESOURCE.cognitiveservices.azure.com";
const DEPLOYMENT = "gpt-5.6-sol";
const TOKEN = process.env.AZ_TOKEN;
if (!TOKEN) { console.error("Missing AZ_TOKEN env"); process.exit(1); }

const system = `You are a principal engineer helping design "cordless": a mobile app that manages
multiple remote terminal / coding-agent sessions (Claude Code, Codex) running on a personal dev box or
laptop, presented like browser tabs. You must be concrete, pragmatic, and buildable in a first iteration.
Prefer boring, robust tech. The owner already ships web apps wrapped as Android APKs via Capacitor and
knows Node.js. Answer densely, no fluff.`;

const user = `Design cordless. Cover exactly these sections with concrete decisions (not menus of options):

1. ARCHITECTURE: components (agent daemon on dev box, mobile client, optional relay), and the data flow.
2. REMOTE SESSIONS: how to spawn/manage many concurrent PTY sessions (shell + \`claude\`/\`codex\`),
   multiplex them, keep scrollback, and make them SURVIVE client disconnects and reconnect with replay.
   Cross-platform (Windows dev box + macOS/Linux laptop). tmux: yes or no, and why.
3. NETWORKING: how the phone reaches the dev box from anywhere. Pick ONE primary path and one LAN
   fallback. Address NAT, TLS, and mobile network changes. Give the exact connection URL scheme.
4. SECURITY / PAIRING: auth model, token issuance, device pairing UX (QR?), and what stops a random
   internet host from attaching to my agent.
5. PROTOCOL: the exact WebSocket message schema (JSON) between client and agent for: list sessions,
   create session, attach, input keystrokes, output stream, resize, kill, and reconnect-with-replay.
6. MOBILE UX: tab model, terminal rendering choice, the on-screen key affordances a touch terminal needs
   (esc, ctrl, arrows, tab, pipe, etc.), and how switching tabs behaves.
7. TECH STACK: exact libraries for agent (Node) and client (web + xterm.js + Capacitor), and why.
8. MVP CUT LINE: the smallest thing to build first that is genuinely useful, then the next 2 increments.
9. RISKS & GOTCHAS: the top 5 things that will bite during implementation and how to avoid them.

Keep it tight. Use short bullet points and code-ish schema. This plan will be executed immediately.`;

const body = {
  messages: [
    { role: "system", content: system },
    { role: "user", content: user },
  ],
  max_completion_tokens: 16000,
};

const url = `${ENDPOINT}/openai/deployments/${DEPLOYMENT}/chat/completions?api-version=2025-04-01-preview`;

const res = await fetch(url, {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(body),
});

const txt = await res.text();
if (!res.ok) {
  console.error("HTTP", res.status, txt.slice(0, 2000));
  process.exit(2);
}
const data = JSON.parse(txt);
console.error("finish_reason:", data.choices?.[0]?.finish_reason, "usage:", JSON.stringify(data.usage));
const out = data.choices?.[0]?.message?.content;
if (!out) {
  console.error("EMPTY content. Full choice:", JSON.stringify(data.choices?.[0], null, 2).slice(0, 3000));
  process.exit(3);
}
fs.writeFileSync("tooling/sol_plan.md", out, "utf8");
console.log(out);
