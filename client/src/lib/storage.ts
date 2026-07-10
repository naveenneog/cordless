export interface Creds {
  deviceId: string;
  token: string;
  daemonId?: string;
}

const KEY_CREDS = "cordless.creds";
const KEY_SERVER = "cordless.server";

export function loadCreds(): Creds | null {
  try {
    const s = localStorage.getItem(KEY_CREDS);
    return s ? (JSON.parse(s) as Creds) : null;
  } catch {
    return null;
  }
}

export function saveCreds(c: Creds): void {
  localStorage.setItem(KEY_CREDS, JSON.stringify(c));
}

export function clearCreds(): void {
  localStorage.removeItem(KEY_CREDS);
}

// The agent that serves this client is the default server (same origin). Override persists
// so a Capacitor-bundled build can target a specific dev box.
export function getServerBase(): string {
  return localStorage.getItem(KEY_SERVER) || location.origin;
}

export function setServerBase(url: string): void {
  localStorage.setItem(KEY_SERVER, url);
}

export function wsUrl(base: string): string {
  const u = new URL(base);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/v1/ws";
  u.search = "";
  u.hash = "";
  return u.toString();
}

export function defaultDeviceName(): string {
  const ua = navigator.userAgent || "";
  let os = "device";
  if (/Android/i.test(ua)) os = "Android";
  else if (/iPhone|iPad|iPod/i.test(ua)) os = "iOS";
  else if (/Mac/i.test(ua)) os = "Mac";
  else if (/Win/i.test(ua)) os = "Windows";
  else if (/Linux/i.test(ua)) os = "Linux";
  return `${os} · cordless`;
}
