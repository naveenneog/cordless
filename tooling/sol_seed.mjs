// Seed the persistent Sol conversation from the consults already made this session,
// so future turns carry full history. Run once.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");

const SYSTEM = `You are GPT-5.6 Sol, co-architect and code reviewer for "cordless" — a mobile app + Node
agent that manages many remote PTY / coding-agent (Claude Code, Codex) sessions like browser tabs, built
by @naveenneog with the GitHub Copilot CLI on a Windows dev box (Node 26). This is an ONGOING multi-turn
collaboration: remember every prior decision in this conversation and stay consistent with it. Be
concrete, terse, correct. Flag real bugs, races, and cross-platform (Windows ConPTY vs Unix) pitfalls.
Prefer boring, robust solutions. When you give code, make it drop-in. No fluff.`;

const ARCH_PROMPT = `Design cordless (mobile app managing many remote terminal/coding-agent sessions like
browser tabs). Cover: architecture (agent daemon + mobile client + optional relay), remote sessions
(many concurrent PTYs, scrollback, survive disconnects + replay, cross-platform, tmux or not), networking
(reach the dev box from anywhere; one primary path + LAN fallback; NAT/TLS/mobile changes; URL scheme),
security/pairing (auth, token issuance, QR pairing, what stops random hosts), protocol (exact WS JSON
schema for list/create/attach/input/output/resize/kill/reconnect-replay), mobile UX (tabs, terminal
renderer, touch key affordances), tech stack (agent Node libs, client web+xterm.js+Capacitor), MVP cut
line + next 2 increments, and top 5 risks/gotchas. Tight, buildable, concrete decisions.`;

const conversation = [
  { role: "system", content: SYSTEM },
  { role: "user", content: ARCH_PROMPT },
  { role: "assistant", content: read("sol_plan.md") },
  { role: "user", content: read("doubt_sessions.md") },
  { role: "assistant", content: read("answer_sessions.md") },
  { role: "user", content: read("doubt_client.md") },
  { role: "assistant", content: read("answer_client.md") },
];

fs.writeFileSync(path.join(dir, "sol_conversation.json"), JSON.stringify(conversation, null, 2));
console.log(`seeded sol_conversation.json with ${conversation.length} messages`);
