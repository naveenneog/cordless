import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";
import { CapacitorBarcodeScanner, CapacitorBarcodeScannerTypeHint } from "@capacitor/barcode-scanner";

export function isNativePlatform(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

// Native QR scan → raw string (throws if cancelled / nothing found).
export async function scanPairingQr(): Promise<string> {
  const r = await CapacitorBarcodeScanner.scanBarcode({
    hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
    scanInstructions: "Point at the cordless pairing QR",
  });
  if (!r?.ScanResult) throw new Error("No QR code detected");
  return r.ScanResult;
}

// Parse both the primary QR (http://host:7443/#pair=<secret>) and the deep link
// (cordless://pair?server=<encoded>#pair=<secret>). Strict validation (Sol review).
export function parsePairPayload(raw: string): { serverBase: string; secret: string } {
  const s = (raw || "").trim();
  if (!s || s.length > 512) throw new Error("Invalid QR");
  const url = new URL(s);

  let serverBase: string;
  let secret: string | null;

  if (url.protocol === "cordless:") {
    if (url.hostname !== "pair") throw new Error("Not a cordless pairing link");
    const server = url.searchParams.get("server");
    if (!server) throw new Error("Missing server");
    const su = new URL(server);
    if (su.protocol !== "http:" && su.protocol !== "https:") throw new Error("Unsupported server");
    if (su.username || su.password) throw new Error("Rejected credentialed URL");
    serverBase = su.origin;
    secret = new URLSearchParams(url.hash.slice(1)).get("pair") || url.searchParams.get("secret");
  } else if (url.protocol === "http:" || url.protocol === "https:") {
    if (url.username || url.password) throw new Error("Rejected credentialed URL");
    serverBase = url.origin;
    secret = new URLSearchParams(url.hash.slice(1)).get("pair");
  } else {
    throw new Error("Unsupported pairing URL");
  }

  secret = (secret || "").trim();
  if (!secret || !/^[A-Za-z0-9_-]{8,256}$/.test(secret)) throw new Error("Missing/invalid pairing code");
  return { serverBase, secret };
}

// Handle cordless:// deep links (cold launch + while running). Returns an unsubscribe fn.
export async function installDeepLinkHandler(handle: (url: string) => void): Promise<() => void> {
  try {
    const launch = await App.getLaunchUrl();
    if (launch?.url) handle(launch.url);
  } catch {
    /* web / not available */
  }
  try {
    const sub = await App.addListener("appUrlOpen", (e) => handle(e.url));
    return () => {
      void sub.remove();
    };
  } catch {
    return () => {};
  }
}
