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
}

// Profiles are fixed in the MVP agent config.
export const PROFILES: ProfileInfo[] = [
  { id: "shell", label: "Shell" },
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
];
