// Unit tests for the CLI help registry — pure, no daemon. Guards that every command is documented
// and that top-level + per-command help render without gaps.
import { COMMANDS, topLevelHelp, commandHelp, findCommand } from "../src/cli/help.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log("FAIL:", m); } };

const top = topLevelHelp();
ok(top.includes("USAGE") && /cordless v\d/.test(top), "top-level help has a header + USAGE");

// Every command appears in the overview and has renderable detail with a USAGE section.
for (const c of COMMANDS) {
  const label = c.invocation || c.name;
  ok(top.includes(label), `overview lists ${c.name}`);
  const detail = commandHelp(c.name);
  ok(typeof detail === "string" && detail.includes("USAGE"), `commandHelp(${c.name}) renders with USAGE`);
  ok(detail.includes(c.summary), `commandHelp(${c.name}) includes its summary`);
}

// Aliases resolve to their command.
ok(findCommand("ws") && findCommand("ws").name === "workspace", "alias 'ws' -> workspace");
ok(findCommand("groups") && findCommand("groups").name === "group", "alias 'groups' -> group");
ok(findCommand("--help") && findCommand("--help").name === "help", "alias '--help' -> help");

// Unknown topics are reported, not crashed.
ok(findCommand("nope") === null, "unknown command resolves to null");
ok(commandHelp("nope") === null, "commandHelp(unknown) returns null");

// A couple of specific option/flag docs are present (regression on the recent features).
ok(commandHelp("attach").includes("--new-window"), "attach help documents --new-window");
ok(commandHelp("start").includes("--foreground"), "start help documents --foreground");

console.log(`\n=== HELP ${fail === 0 ? "PASS" : "FAIL"} (${pass} ok, ${fail} bad) ===`);
process.exit(fail === 0 ? 0 : 1);
