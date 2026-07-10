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

// Verify a hello frame. Returns the device record or null.
export function authenticate(deviceId, token) {
  const device = findActiveDevice(deviceId, token);
  if (!device) return null;
  touchDevice(deviceId);
  return device;
}
