// Reusable helper to consult GPT-5.6 Sol (Azure AI Foundry) during the build.
// Usage:
//   node tooling/ask_sol.mjs <promptFile> [systemFile]
// Auto-fetches an AAD token via `az` if AZ_TOKEN is not set.
import fs from "node:fs";
import { execSync } from "node:child_process";

const ENDPOINT = "https://REDACTED-AZURE-RESOURCE.cognitiveservices.azure.com";
const DEPLOYMENT = "gpt-5.6-sol";
const API_VERSION = "2025-04-01-preview";

function token() {
  if (process.env.AZ_TOKEN) return process.env.AZ_TOKEN;
  return execSync(
    "az account get-access-token --resource https://cognitiveservices.azure.com --query accessToken -o tsv",
    { encoding: "utf8" }
  ).trim();
}

const promptFile = process.argv[2];
const systemFile = process.argv[3];
if (!promptFile) { console.error("usage: node ask_sol.mjs <promptFile> [systemFile]"); process.exit(1); }

const user = fs.readFileSync(promptFile, "utf8");
const system = systemFile
  ? fs.readFileSync(systemFile, "utf8")
  : `You are a principal engineer acting as a design/code reviewer for "cordless": a mobile app + Node
agent that manages many remote PTY / coding-agent (Claude Code, Codex) sessions like browser tabs.
Be concrete, terse, and correct. Point out real bugs, race conditions, and cross-platform (Windows
ConPTY vs Unix) pitfalls. Prefer boring, robust solutions. No fluff.`;

const url = `${ENDPOINT}/openai/deployments/${DEPLOYMENT}/chat/completions?api-version=${API_VERSION}`;
const res = await fetch(url, {
  method: "POST",
  headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_completion_tokens: 16000,
  }),
});
const txt = await res.text();
if (!res.ok) { console.error("HTTP", res.status, txt.slice(0, 2000)); process.exit(2); }
const data = JSON.parse(txt);
const out = data.choices?.[0]?.message?.content;
console.error(`[sol] finish=${data.choices?.[0]?.finish_reason} reasoning_tokens=${data.usage?.completion_tokens_details?.reasoning_tokens}`);
if (!out) { console.error("EMPTY:", JSON.stringify(data.choices?.[0]).slice(0, 1500)); process.exit(3); }
console.log(out);
