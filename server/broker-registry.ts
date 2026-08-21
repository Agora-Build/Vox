export const KNOWN_BROKER_TYPES = ["auth-session"] as const;
export type BrokerType = (typeof KNOWN_BROKER_TYPES)[number];

export const BROKER_OFFLINE_THRESHOLD_SECONDS = 90; // 3 missed 30s heartbeats

export function isKnownBrokerType(v: unknown): v is BrokerType {
  return typeof v === "string" && (KNOWN_BROKER_TYPES as readonly string[]).includes(v);
}

function isPrivateIpv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const o = m.slice(1, 5).map(Number);
  if (o.some((n) => n > 255)) return false;
  if (o[0] === 127) return true;                    // loopback
  if (o[0] === 10) return true;                      // 10/8
  if (o[0] === 192 && o[1] === 168) return true;     // 192.168/16
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true; // 172.16/12
  return false;
}

export function isInternalBrokerUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "http:") return false;
  const host = u.hostname.toLowerCase();
  if (host === "localhost") return true;
  if (isPrivateIpv4(host)) return true;
  if (host.endsWith(".internal") || host.endsWith(".local")) return true;
  if (!host.includes(".")) return true;              // single-label DNS (docker alias)
  return false;
}
