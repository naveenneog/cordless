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

const ENDPOINT = "https://REDACTED-AZURE-RESOURCE.cognitiveservices.azure.com";
const DEPLOYMENT = "gpt-5.6-sol";
const API_VERSION = "2025-04-01-preview";

const dir = path.dirname(fileURLToPath(import.meta.url));
const CONV = path.join(dir, "sol_conversation.json");

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

const url = `${ENDPOINT}/openai/deployments/${DEPLOYMENT}/chat/completions?api-version=${API_VERSION}`;
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
