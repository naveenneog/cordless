// Pure unit tests for the attention heuristics (no daemon). Fixtures cover shells, pagers, and
// Claude/Codex-style prompts, plus the false-positive traps (shell readiness, alt-screen, bells).
import assert from "node:assert";
import {
  looksLikePrompt,
  hasBell,
  isMeaningfulOutput,
  altScreenAfter,
  isShellPrompt,
  isPagerOrStatus,
} from "../src/attention.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log("FAIL:", m); } };
const isPrompt = (line, opts) => looksLikePrompt([line], opts).match;

// --- high-confidence prompts SHOULD match ---
for (const line of [
  "Do you want to proceed? (y/n)",
  "Continue? [y/N]",
  "Overwrite existing file? (y/n)",
  "Press ENTER to continue",
  "Enter your password:",
  "Please enter your choice:",
  "Select an option: ",
  "Proceed with deployment? (yes/no)",
]) ok(isPrompt(line), "prompt should match: " + line);

// --- coding-agent prompts SHOULD match ---
for (const line of [
  "Do you want me to apply these changes? (y/n)",
  "Should I run the tests?",
  "Would you like me to continue?",
  "Allow this command? (y/n)",
]) ok(isPrompt(line), "agent prompt should match: " + line);

// --- shell readiness / normal output should NOT match (idle, not waiting) ---
for (const line of [
  "PS C:\\Users\\navg>",
  "navg@devbox:~/src/app$ ",
  "~/src/api ❯ ",
  "$ ",
  "# ",
  "Compiling module 42 of 100...",
  "info: build succeeded in 3.4s",
]) ok(!isPrompt(line), "should NOT match: " + line);

// --- pager / status tails should NOT match ---
for (const line of ["--More--", "(END)", "  50%", ":", "Press q to quit"]) {
  ok(!isPrompt(line), "pager should NOT match: " + line);
  ok(isPagerOrStatus(line), "isPagerOrStatus true: " + line);
}

// --- alternate screen suppresses everything (vim/htop/less) ---
ok(!isPrompt("Do you want to proceed? (y/n)", { alternateScreen: true }), "alt-screen suppresses prompt");

// --- shell prompt detection helper ---
ok(isShellPrompt("navg@devbox:~$ "), "shell prompt detected");
ok(!isShellPrompt("Do you want to proceed? (y/n)"), "confirm prompt is not a shell prompt");

// --- last non-empty line is what matters (trailing blanks ignored) ---
ok(looksLikePrompt(["building...", "Continue? (y/n)", "", "  "]).match, "uses last non-empty line");

// --- bell detection ---
ok(hasBell(Buffer.from([0x41, 0x07, 0x42])), "BEL detected");
ok(!hasBell(Buffer.from("hello world")), "no BEL");

// --- meaningfulness ---
ok(isMeaningfulOutput(Buffer.from("hello")), "printable is meaningful");
ok(!isMeaningfulOutput(Buffer.from("\x1b[2J\x1b[H")), "pure clear/home is not meaningful");
ok(!isMeaningfulOutput(Buffer.from("   \r\n  ")), "whitespace is not meaningful");

// --- alt-screen tracking across batches ---
ok(altScreenAfter(Buffer.from("\x1b[?1049h"), false) === true, "enter alt screen");
ok(altScreenAfter(Buffer.from("\x1b[?1049l"), true) === false, "leave alt screen");
ok(altScreenAfter(Buffer.from("plain text"), true) === true, "alt state persists without a toggle");

console.log(`\n=== ATTENTION ${fail === 0 ? "PASS" : "FAIL"} (${pass} ok, ${fail} bad) ===`);
process.exit(fail === 0 ? 0 : 1);
