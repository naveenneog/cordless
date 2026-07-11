// Attention-state heuristics for cordless sessions.
//
// The daemon infers, purely from a session's PTY output, whether it is actively working, idle, or
// (the useful bit for juggling many coding-agent sessions) *waiting for the user*. These are pure,
// side-effect-free helpers so they can be unit-tested against recorded terminal fixtures. The timing
// / state-machine glue lives in sessions.js (SessionManager); this file only classifies text + bytes.
//
// Design (validated with GPT-5.6 Sol):
//   activity : "working" | "idle" | "exited"          (execution status)
//   attention: "prompt" | "bell" | "finished" | null  (does it need me?)
// Attention is deliberately conservative: a silent build or a sleeping process is *idle*, not
// waiting. A trailing shell prompt ($ # > ❯ %) means "ready", NOT "needs attention". We only raise
// attention:"prompt" on high-confidence confirmation/agent prompts, on an explicit BEL, or (for
// agent profiles) on a heuristic "finished" — and we suppress heuristics on the alternate screen
// (vim/htop/less/full-screen TUIs) to avoid noise.

/** Timing thresholds (ms). Exposed for reuse + tests; the idle threshold is overridable via config. */
export const THRESHOLDS = {
  IDLE_AFTER_MS: 5_000, // no output for this long after being active -> idle
  PROMPT_QUIET_MS: 1_500, // quiet window before we inspect the tail for a prompt
  FINISHED_QUIET_MS: 10_000, // quiet window before an agent session is heuristically "finished"
  INPUT_GRACE_MS: 2_000, // ignore prompt detection right after the user typed
  BELL_HOLD_MS: 30_000, // how long a bell badge is held if nothing else happens
  BELL_INPUT_GUARD_MS: 500, // ignore a BEL fired right after a keypress (likely an invalid-key beep)
};

/** High-confidence "please answer me" prompts (confirmations, choices, credential requests). */
export const CONFIRM_PATTERNS = [
  /\b(?:y\/n|yes\/no|y\/N|Y\/n)\s*[)?:]?\s*$/i,
  /\b(?:continue|proceed|confirm|approve|allow|accept|overwrite|retry)\b.*[?:]\s*$/i,
  /\bpress\s+(?:enter|return|any key)\b.*$/i,
  /\bselect\s+(?:an option|one|a[n]? \w+)\b.*[:?]\s*$/i,
  /\benter\s+(?:your\s+)?(?:choice|selection|value|password|passphrase|token|otp|code)\b.*[:?]?\s*$/i,
  /\[[yY](?:es)?\/[nN]o?\]\s*[:?]?\s*$/,
];

/** Coding-agent style questions (Claude Code / Codex asking permission or a yes/no). */
export const AGENT_PATTERNS = [
  /\bdo you want (?:me )?to\b.*\?\s*$/i,
  /\bwould you like (?:me )?to\b.*\?\s*$/i,
  /\bshould i\b.*\?\s*$/i,
  /\bpermission\b.*\b(?:allow|deny|approve|grant)\b.*$/i,
  /\b(?:allow|approve|apply) (?:this |these )?(?:change|edit|command|action|patch|diff)s?\b.*[?:]\s*$/i,
];

/** Pager / full-screen status tails that must NOT be treated as prompts. */
export const PAGER_TAILS = [
  /^--\s?more\s?--/i,
  /^\(END\)\s*$/i,
  /^:\s*$/, // less/man command line
  /^\s*\d{1,3}%\s*$/, // percentage status
  /press\s+q\s+to\s+quit/i,
];

/** A trailing shell prompt = readiness, not attention. Kept separate so we can label activity. */
const SHELL_PROMPT = /(?:[$#%>]|❯|»|➜)\s*$/;

/** Does an output batch contain a BEL (0x07)? A strong, explicit attention signal. */
export function hasBell(buf) {
  return Buffer.isBuffer(buf) ? buf.includes(0x07) : Buffer.from(String(buf)).includes(0x07);
}

// Rough ANSI/control stripper — only used to decide "did anything printable happen?" (meaningfulness),
// never for display. Perfect parsing is unnecessary here.
const ANSI = /\x1b[[\]P][0-9;?=!"'>]*[ -/]*[@-~]?|\x1b[@-Z\\-_]|[\x00-\x08\x0b-\x1f\x7f]/g;

/** True if a batch contains real printable content (not just cursor moves / repaint / whitespace). */
export function isMeaningfulOutput(buf) {
  const s = (Buffer.isBuffer(buf) ? buf.toString("latin1") : String(buf)).replace(ANSI, "");
  return /\S/.test(s);
}

/** Track alternate-screen enter/exit across a batch; returns the new alt-screen flag. */
export function altScreenAfter(buf, current) {
  const s = Buffer.isBuffer(buf) ? buf.toString("latin1") : String(buf);
  let alt = current;
  const re = /\x1b\[\?(1049|1047|47)([hl])/g;
  let m;
  while ((m = re.exec(s))) alt = m[2] === "h";
  return alt;
}

/** Is this tail line a pager/status line (to be ignored for prompt detection)? */
export function isPagerOrStatus(line) {
  return PAGER_TAILS.some((re) => re.test(line));
}

/** Is this tail line just a ready shell prompt (idle, not waiting)? */
export function isShellPrompt(line) {
  return SHELL_PROMPT.test(line) && !CONFIRM_PATTERNS.some((re) => re.test(line));
}

/**
 * Classify the terminal tail (an array of the last few logical lines, cursor line last) as a
 * high-confidence "waiting for input" prompt. Conservative by design.
 * @returns {{ match: boolean, confidence: "high"|null }}
 */
export function looksLikePrompt(tailLines, { alternateScreen = false } = {}) {
  if (alternateScreen) return { match: false, confidence: null }; // suppress TUI/pager noise
  const nonEmpty = (tailLines || []).map((s) => String(s).replace(/\s+$/, "")).filter((s) => s.length);
  if (!nonEmpty.length) return { match: false, confidence: null };
  const last = nonEmpty[nonEmpty.length - 1];
  if (last.length > 400 || isPagerOrStatus(last)) return { match: false, confidence: null };
  for (const re of CONFIRM_PATTERNS) if (re.test(last)) return { match: true, confidence: "high" };
  for (const re of AGENT_PATTERNS) if (re.test(last)) return { match: true, confidence: "high" };
  return { match: false, confidence: null };
}
