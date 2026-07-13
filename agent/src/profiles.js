// Profile model + resolution for cordless sessions.
//
// A profile is a named launcher. Built-ins ship in DEFAULT_CONFIG; users add their own under
// `profiles` in ~/.cordless/config.json (user entries override built-ins of the same name). Two
// launch shapes are supported:
//   - direct   { command, args?, cwd?, env?, title?, attentionPreset? }  -> spawn the exe directly
//   - shell    { label?, initCommand? }                                   -> spawn the shell, then
//                                                                             type initCommand (legacy
//                                                                             claude/codex) or nothing
//
// Security: a remote client only ever selects a profile by NAME. It can never submit an executable or
// argv — those live only in the daemon's config. The config file is intentionally code-execution, so
// treat it as trusted local input (user-only perms) and never let remote clients edit it.
import path from "node:path";
import fs from "node:fs";
import { BUILTIN_PROFILE_NAMES, loadRawUserProfiles } from "./state.js";

export const PROFILE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,31}$/;
const ATTENTION_PRESETS = new Set(["shell", "agent", "none"]);
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

// Which launch shape a profile uses.
export function profileKind(p) {
  if (p && p.command) return "command";
  if (p && p.initCommand) return "shell+command";
  return "shell";
}

// The executable whose presence determines availability (null for a bare shell — always available).
export function profileExecutable(p) {
  if (!p) return null;
  if (p.command) return p.command;
  if (p.initCommand) return String(p.initCommand).trim().split(/\s+/)[0] || null;
  return null;
}

// Validate + normalize a user profile. Returns { ok, errors, profile }. Never throws.
export function validateProfile(name, raw) {
  const errors = [];
  if (!PROFILE_NAME_RE.test(name)) errors.push(`invalid profile name "${name}" (use letters/digits/._- , <=32 chars)`);
  const p = raw && typeof raw === "object" ? raw : {};
  const out = {};
  if (p.command != null) {
    if (typeof p.command !== "string" || !p.command.trim()) errors.push("command must be a non-empty string");
    else if (CONTROL_CHARS.test(p.command)) errors.push("command contains control characters");
    else out.command = p.command.trim();
  }
  if (p.args != null) {
    if (!Array.isArray(p.args)) errors.push("args must be an array");
    else if (p.args.length > 64) errors.push("args has too many entries (max 64)");
    else if (p.args.some((a) => typeof a !== "string" || CONTROL_CHARS.test(a))) errors.push("args must be strings without control characters");
    else out.args = p.args.slice();
  }
  if (p.env != null) {
    if (typeof p.env !== "object" || Array.isArray(p.env)) errors.push("env must be an object of string values");
    else {
      out.env = {};
      for (const [k, v] of Object.entries(p.env)) {
        if (typeof v !== "string") errors.push(`env.${k} must be a string`);
        else out.env[k] = v;
      }
    }
  }
  if (p.cwd != null) {
    if (typeof p.cwd !== "string") errors.push("cwd must be a string");
    else out.cwd = p.cwd;
  }
  if (p.title != null) out.title = String(p.title).slice(0, 200);
  if (p.label != null) out.label = String(p.label).slice(0, 80);
  if (p.initCommand != null) {
    if (typeof p.initCommand !== "string" || CONTROL_CHARS.test(p.initCommand.replace(/[\r\n\t]/g, ""))) errors.push("initCommand must be a string");
    else out.initCommand = p.initCommand;
  }
  if (p.attentionPreset != null) {
    if (!ATTENTION_PRESETS.has(p.attentionPreset)) errors.push(`attentionPreset must be one of ${[...ATTENTION_PRESETS].join(", ")}`);
    else out.attentionPreset = p.attentionPreset;
  }
  if (p.restore === false) out.restore = false;
  return { ok: errors.length === 0, errors, profile: out };
}

// Expand a leading ~ to the home dir.
export function expandHome(p) {
  if (typeof p !== "string") return p;
  if (p === "~") return path.join(process.env.HOME || process.env.USERPROFILE || "", "");
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(process.env.HOME || process.env.USERPROFILE || "", p.slice(2));
  return p;
}

// Resolve an executable name/path against the given environment (PATH + Windows PATHEXT). Returns the
// resolved absolute path, or null if not found. Used to decide profile availability from the DAEMON's
// environment (autostart PATH often differs from the interactive shell).
export function resolveExecutable(command, env = process.env) {
  if (!command || typeof command !== "string") return null;
  const isWin = process.platform === "win32";
  const hasExt = !!path.extname(command);
  const exts = isWin ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.trim()).filter(Boolean) : [""];
  const tryFile = (full) => {
    try {
      return fs.existsSync(full) && fs.statSync(full).isFile() ? full : null;
    } catch {
      return null;
    }
  };
  const candidates = (base) => (hasExt || !isWin ? [base] : exts.map((e) => base + e));
  // Explicit path (absolute or containing a separator): check directly.
  if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    for (const c of candidates(command)) {
      const hit = tryFile(c);
      if (hit) return hit;
    }
    return null;
  }
  const dirs = (env.PATH || env.Path || "").split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    for (const c of candidates(path.join(d, command))) {
      const hit = tryFile(c);
      if (hit) return hit;
    }
  }
  return null;
}

// Where a profile came from, for display.
export function profileSource(name) {
  const isBuiltin = BUILTIN_PROFILE_NAMES.includes(name);
  let userNames = [];
  try {
    userNames = Object.keys(loadRawUserProfiles());
  } catch {
    /* ignore */
  }
  const isUser = userNames.includes(name);
  if (isUser && isBuiltin) return "override";
  if (isUser) return "user";
  return "built-in";
}

// The effective profiles (cfg.profiles is already built-ins merged with user overrides), annotated
// with kind, source, validity and availability against `env`. Sorted built-ins first, then alpha.
export function describeProfiles(cfg, env = process.env) {
  const names = Object.keys(cfg.profiles || {});
  const rows = names.map((name) => {
    const p = cfg.profiles[name] || {};
    const { ok: valid, errors } = validateProfile(name, p);
    const exe = profileExecutable(p);
    const resolved = valid && exe ? resolveExecutable(exe, env) : null;
    return {
      name,
      label: p.label || name,
      kind: profileKind(p),
      source: profileSource(name),
      command: exe,
      valid,
      available: valid && (exe ? !!resolved : true), // a bare shell is always available
      resolved,
      reason: !valid ? errors.join("; ") : exe && !resolved ? `executable "${exe}" was not found in the daemon PATH` : null,
    };
  });
  rows.sort((a, b) => {
    const ab = a.source === "built-in" ? 0 : 1;
    const bb = b.source === "built-in" ? 0 : 1;
    return ab - bb || a.name.localeCompare(b.name);
  });
  return rows;
}
