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
};
