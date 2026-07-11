// Connection auth + brute-force throttling for cordlessd.
import { findActiveDevice, touchDevice } from "./state.js";

const MAX_FAILS = 5;
const BLOCK_MS = 10 * 60 * 1000;
const fails = new Map(); // ip -> { count, until }

export function isBlocked(ip) {
  const f = fails.get(ip);
  if (!f) return false;
  if (f.until && f.until > Date.now()) return true;
  if (f.until && f.until <= Date.now()) fails.delete(ip);
  return false;
}

export function recordFail(ip) {
  const f = fails.get(ip) || { count: 0, until: 0 };
  f.count += 1;
  if (f.count >= MAX_FAILS) f.until = Date.now() + BLOCK_MS;
  fails.set(ip, f);
}

export function recordSuccess(ip) {
  fails.delete(ip);
}

function isLoopback(ip) {
  if (!ip) return false;
  const a = String(ip).replace(/^::ffff:/, "");
  return a === "::1" || a === "127.0.0.1" || a.startsWith("127.");
}
export { isLoopback };

// Verify a hello frame. Returns the device record or null. Loopback-scoped tokens (the desktop
// app's local credential) are only accepted from 127.0.0.1 / ::1.
export function authenticate(deviceId, token, ip) {
  const device = findActiveDevice(deviceId, token);
  if (!device) return null;
  if (device.scope === "loopback" && !isLoopback(ip)) return null;
  touchDevice(deviceId);
  return device;
}
