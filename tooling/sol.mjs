// Stateful conversation with GPT-5.6 Sol (Azure AI Foundry) for the cordless build.
// Maintains full message history in sol_conversation.json — every call appends the user turn and
// Sol's reply, so Sol stays consistent with all prior decisions.
//
// Usage:
//   node tooling/sol.mjs <promptFile>       # send the file contents as the next user turn
//   node tooling/sol.mjs -m "inline text"   # send an inline message
// Auto-fetches an AAD token via `az` if AZ_TOKEN is not set.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const dir = path.dirname(fileURLToPath(import.meta.url));
const CONV = path.join(dir, "sol_conversation.json");

// Azure endpoint/deployment are NOT hardcoded (they're your private resource). Provide them via
// env (CORDLESS_AZURE_ENDPOINT / CORDLESS_SOL_DEPLOYMENT / CORDLESS_AZURE_API_VERSION) or a
// gitignored tooling/sol.local.json { "endpoint": "...", "deployment": "...", "apiVersion": "..." }.
function solConfig() {
  let cfg = {};
  const local = path.join(dir, "sol.local.json");
  if (fs.existsSync(local)) {
    try { cfg = JSON.parse(fs.readFileSync(local, "utf8")); } catch { /* ignore */ }
  }
  const endpoint = process.env.CORDLESS_AZURE_ENDPOINT || cfg.endpoint;
  const deployment = process.env.CORDLESS_SOL_DEPLOYMENT || cfg.deployment || "gpt-5.6-sol";
  const apiVersion = process.env.CORDLESS_AZURE_API_VERSION || cfg.apiVersion || "2025-04-01-preview";
  if (!endpoint) {
    console.error("Set CORDLESS_AZURE_ENDPOINT (or create tooling/sol.local.json with {endpoint,deployment}).");
    process.exit(1);
  }
  return { endpoint: endpoint.replace(/\/$/, ""), deployment, apiVersion };
}
const SOL = solConfig();

function token() {
  if (process.env.AZ_TOKEN) return process.env.AZ_TOKEN;
  return execSync(
    "az account get-access-token --resource https://cognitiveservices.azure.com --query accessToken -o tsv",
    { encoding: "utf8" }
  ).trim();
}

const args = process.argv.slice(2);
let message;
if (args[0] === "-m") message = args.slice(1).join(" ");
else if (args[0]) message = fs.readFileSync(args[0], "utf8");
else {
  console.error("usage: node sol.mjs <promptFile> | -m \"text\"");
  process.exit(1);
}

if (!fs.existsSync(CONV)) {
  console.error("no sol_conversation.json — run sol_seed.mjs first");
  process.exit(1);
}

const conv = JSON.parse(fs.readFileSync(CONV, "utf8"));
conv.push({ role: "user", content: message });

const url = `${SOL.endpoint}/openai/deployments/${SOL.deployment}/chat/completions?api-version=${SOL.apiVersion}`;
const res = await fetch(url, {
  method: "POST",
  headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
  body: JSON.stringify({ messages: conv, max_completion_tokens: 16000 }),
});
const txt = await res.text();
if (!res.ok) {
  console.error("HTTP", res.status, txt.slice(0, 2000));
  process.exit(2);
}
const data = JSON.parse(txt);
const out = data.choices?.[0]?.message?.content;
console.error(
  `[sol] turn=${conv.length} finish=${data.choices?.[0]?.finish_reason} reasoning=${data.usage?.completion_tokens_details?.reasoning_tokens} prompt=${data.usage?.prompt_tokens}`
);
if (!out) {
  console.error("EMPTY:", JSON.stringify(data.choices?.[0]).slice(0, 1500));
  process.exit(3);
}
conv.push({ role: "assistant", content: out });
fs.writeFileSync(CONV, JSON.stringify(conv, null, 2));
console.log(out);
