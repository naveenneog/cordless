// Wire types shared with the agent (see agent/src/protocol.js).

export type SessionState = "running" | "exited";
export type ReplayMode = "incremental" | "reset" | "fresh";

export interface SessionSummary {
  sessionId: string;
  title: string;
  titleRevision?: number;
  groupId?: string | null;
  groupOrder?: number;
  profile: string;
  cwd: string;
  generation?: string;
  state: SessionState;
  cols: number;
  rows: number;
  createdAt: string;
  lastActivityAt: string;
  latestSeq: number;
  attachedDevices: number;
  exitCode: number | null;
}

export interface SessionGroup {
  id: string;
  name: string;
  color: string;
  order: number;
  revision: number;
}

export interface OutputFrame {
  type: "session.output";
  sessionId: string;
  seq: number;
  data: string; // base64 raw bytes
  replay: boolean;
  reset: boolean;
}

export interface ExitFrame {
  type: "session.exit";
  sessionId: string;
  exitCode: number | null;
  signal: string | null;
  at: string;
}

export interface HelloResult {
  type: "hello.result";
  requestId: string;
  ok: boolean;
  connectionId?: string;
  daemonId?: string;
  protocol?: number;
  error?: { code: string; message: string };
}

export interface GenericResult {
  type: string;
  requestId: string;
  ok: boolean;
  error?: { code: string; message: string };
  [k: string]: unknown;
}

export type ServerFrame = OutputFrame | ExitFrame | HelloResult | GenericResult;

export interface ProfileInfo {
  id: string;
  label: string;
  glyph: string; // short icon glyph shown in a colored badge (icons instead of names)
  color: string; // brand-ish accent for the badge
}

// Built-in launch profiles, shown as colored icon badges in the app.
export const PROFILES: ProfileInfo[] = [
  { id: "shell", label: "Shell", glyph: ">_", color: "#6b7280" },
  { id: "claude", label: "Claude Code", glyph: "✳", color: "#d97757" },
  { id: "codex", label: "Codex", glyph: "❋", color: "#10a37f" },
  { id: "copilot", label: "GitHub Copilot", glyph: "◉", color: "#2f81f7" },
];

// Icon/label for a session's profile (falls back to a generic shell badge for unknown/custom ones).
export function agentMeta(id: string): ProfileInfo {
  return PROFILES.find((p) => p.id === id) || { id, label: id || "shell", glyph: ">_", color: "#6b7280" };
}
