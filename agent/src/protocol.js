// Wire protocol between cordless client and agent. JSON text frames over WebSocket.
// Incoming (client -> agent) messages are validated with zod. Outgoing frames are built by helpers.
import { z } from "zod";

export const PROTOCOL_VERSION = 1;

const requestId = z.string().min(1).max(128);
const sessionId = z.string().min(1).max(128);

const Hello = z.object({
  type: z.literal("hello"),
  requestId,
  protocol: z.number().int().optional(),
  deviceId: z.string().min(1),
  token: z.string().min(1),
});

const SessionList = z.object({ type: z.literal("session.list"), requestId });

const SessionCreate = z.object({
  type: z.literal("session.create"),
  requestId,
  profile: z.string().min(1).max(64),
  cwd: z.string().max(4096).optional(),
  cols: z.number().int().min(20).max(300).optional(),
  rows: z.number().int().min(5).max(120).optional(),
  title: z.string().max(200).optional(),
});

const SessionAttach = z.object({
  type: z.literal("session.attach"),
  requestId,
  sessionId,
  fromSeq: z.number().int().nonnegative().nullable().optional(),
});

const SessionInput = z.object({
  type: z.literal("session.input"),
  requestId: requestId.optional(),
  sessionId,
  data: z.string(), // base64 of utf8 keystrokes
});

const SessionResize = z.object({
  type: z.literal("session.resize"),
  requestId: requestId.optional(),
  sessionId,
  cols: z.number().int().min(20).max(300),
  rows: z.number().int().min(5).max(120),
});

const SessionDetach = z.object({
  type: z.literal("session.detach"),
  requestId: requestId.optional(),
  sessionId,
});

const SessionKill = z.object({
  type: z.literal("session.kill"),
  requestId: requestId.optional(),
  sessionId,
  mode: z.enum(["graceful", "force"]).optional(),
});

const SessionAck = z.object({
  type: z.literal("session.ack"),
  sessionId,
  seq: z.number().int().nonnegative(),
});

// Mint a single-use pairing secret + return reachable phone URLs. Loopback-scoped only (server-enforced).
const PairingCreate = z.object({
  type: z.literal("pairing.create"),
  requestId,
  allowLan: z.boolean().optional(),
});
const PairingCancel = z.object({
  type: z.literal("pairing.cancel"),
  requestId,
  pairingId: z.string().min(1).max(128),
});

// "Mark handled" — dismiss a session's attention (waiting/bell/finished) badge.
const SessionAttentionClear = z.object({
  type: z.literal("session.attention.clear"),
  requestId: requestId.optional(),
  sessionId,
  revision: z.number().int().nonnegative().optional(),
});

// Read the last N lines of a session's retained buffer (copy last output).
const SessionTail = z.object({
  type: z.literal("session.tail"),
  requestId,
  sessionId,
  lines: z.number().int().min(1).max(5000).optional(),
});

// Search a session's retained scrollback.
const SessionSearch = z.object({
  type: z.literal("session.search"),
  requestId,
  sessionId,
  query: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(1000).optional(),
});

// Clear persisted (on-disk) session history. No sessionId = clear all. Loopback-scoped (server-enforced).
const HistoryClear = z.object({
  type: z.literal("history.clear"),
  requestId,
  sessionId: sessionId.optional(),
});

// List which sessions have persisted history on disk. Loopback-scoped (server-enforced).
const HistoryList = z.object({ type: z.literal("history.list"), requestId });

// List the effective launch profiles (built-ins + user), with availability. Read-only.
const ProfilesList = z.object({ type: z.literal("profiles.list"), requestId });

export const ClientMessage = z.discriminatedUnion("type", [
  Hello,
  SessionList,
  SessionCreate,
  SessionAttach,
  SessionInput,
  SessionResize,
  SessionDetach,
  SessionKill,
  SessionAck,
  PairingCreate,
  PairingCancel,
  SessionAttentionClear,
  SessionTail,
  SessionSearch,
  HistoryClear,
  HistoryList,
  ProfilesList,
]);

// ---- Outgoing frame builders ----
export const out = {
  helloResult: (requestId, { connectionId, daemonId }) => ({
    type: "hello.result",
    requestId,
    ok: true,
    connectionId,
    daemonId,
    protocol: PROTOCOL_VERSION,
    serverTime: new Date().toISOString(),
  }),
  result: (type, requestId, extra = {}) => ({ type, requestId, ok: true, ...extra }),
  error: (type, requestId, code, message) => ({
    type,
    requestId: requestId ?? null,
    ok: false,
    error: { code, message },
  }),
  sessionList: (requestId, sessions) => ({
    type: "session.list.result",
    requestId,
    ok: true,
    sessions,
  }),
  output: (sessionId, seq, dataB64, { replay = false, reset = false } = {}) => ({
    type: "session.output",
    sessionId,
    seq,
    data: dataB64,
    replay,
    reset,
  }),
  exit: (sessionId, exitCode, signal) => ({
    type: "session.exit",
    sessionId,
    exitCode,
    signal: signal ?? null,
    at: new Date().toISOString(),
  }),
  // Attention/activity transition pushed to all clients (badges + notifications).
  activity: ({ sessionId, activity, attention, attentionSince, attentionConfidence, attentionRevision }) => ({
    type: "session.activity",
    sessionId,
    activity,
    attention,
    attentionSince,
    attentionConfidence,
    attentionRevision,
  }),
  sessionTail: (requestId, sessionId, text) => ({ type: "session.tail.result", requestId, ok: true, sessionId, text }),
  sessionSearch: (requestId, sessionId, matches) => ({ type: "session.search.result", requestId, ok: true, sessionId, matches }),
  historyClearResult: (requestId, cleared) => ({ type: "history.clear.result", requestId, ok: true, cleared }),
  historyList: (requestId, items) => ({ type: "history.list.result", requestId, ok: true, items }),
  profilesList: (requestId, profiles) => ({ type: "profiles.list.result", requestId, ok: true, profiles }),
  pairingCreateResult: (requestId, { pairingId, urls, preferredUrl, code, route, expiresAt }) => ({
    type: "pairing.create.result",
    requestId,
    ok: true,
    pairingId,
    urls,
    preferredUrl,
    code,
    route,
    expiresAt,
  }),
};
