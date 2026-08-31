export const KNOWN_BROKER_TYPES = ["auth-session"] as const;
export type BrokerType = (typeof KNOWN_BROKER_TYPES)[number];

export const BROKER_OFFLINE_THRESHOLD_SECONDS = 300; // 5 missed 60s heartbeats

export function isKnownBrokerType(v: unknown): v is BrokerType {
  return typeof v === "string" && (KNOWN_BROKER_TYPES as readonly string[]).includes(v);
}

export function validateRegisterPayload(p: { name?: unknown; brokerType?: unknown; url?: unknown }):
  { ok: true; brokerType: BrokerType; url: string; name: string } | { ok: false; error: string } {
  if (typeof p.name !== "string" || !p.name) return { ok: false, error: "name required" };
  if (!isKnownBrokerType(p.brokerType)) return { ok: false, error: "unknown brokerType" };
  if (typeof p.url !== "string" || !isInternalBrokerUrl(p.url)) return { ok: false, error: "url must be internal http" };
  return { ok: true, brokerType: p.brokerType, url: p.url, name: p.name };
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

export function isBrokerFresh(lastSeenAt: Date | null, thresholdSeconds: number, now: Date): boolean {
  if (!lastSeenAt) return false;
  return now.getTime() - lastSeenAt.getTime() <= thresholdSeconds * 1000;
}

export function isInternalBrokerUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "http:") return false;
  const host = u.hostname.toLowerCase();
  if (host.includes(":")) return false; // reject IPv6 literals (e.g. [2001:db8::1]); brokers use IPv4 / DNS aliases
  if (host === "localhost") return true;
  if (isPrivateIpv4(host)) return true;
  if (host.endsWith(".internal") || host.endsWith(".local")) return true;
  if (!host.includes(".")) return true;              // single-label DNS (docker alias)
  return false;
}

import { storage } from "./storage";
import type { Broker } from "@shared/schema";
import { credentialForms, redactValues } from "@shared/credentials";

const mintSecretCache = new Map<number, string>();
export function cacheBrokerMintSecret(id: number, secret: string): void { mintSecretCache.set(id, secret); }
export function getCachedBrokerMintSecret(id: number): string | undefined { return mintSecretCache.get(id); }
export function hasBrokerMintSecret(id: number): boolean { return mintSecretCache.has(id); }
export function clearBrokerMintSecret(id: number): void { mintSecretCache.delete(id); }

export interface BrokerTarget { id: number; url: string; mintSecret: string; }

// Testable core: caller supplies the routable-broker lister (already freshness/state filtered).
export async function routeToBrokerWith(
  brokerType: BrokerType,
  list: (t: string, thr: number) => Promise<Broker[]>,
): Promise<BrokerTarget | null> {
  const candidates = await list(brokerType, BROKER_OFFLINE_THRESHOLD_SECONDS);
  for (const b of candidates) {              // list is ordered freshest-first
    const secret = mintSecretCache.get(b.id);
    if (secret) return { id: b.id, url: b.url, mintSecret: secret };
  }
  return null;
}

export function routeToBroker(brokerType: BrokerType): Promise<BrokerTarget | null> {
  return routeToBrokerWith(brokerType, (t, thr) => storage.getRoutableBrokers(t, thr));
}

export async function brokerAvailable(brokerType: BrokerType): Promise<boolean> {
  return (await routeToBroker(brokerType)) != null;
}

export async function mintViaBroker(
  target: BrokerTarget,
  req: { platformId: string; email: string; password: string },
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  // Bound the call. auth-session.ts's staleMintThresholdSeconds() is derived
  // from "mintTimeoutSeconds() + 15s, see mintViaBroker's AbortSignal" — that
  // signal did not exist, so a hung broker left this promise pending forever,
  // the row stuck in 'minting' until stale-reclaim, and ensureSession's catch
  // never fired. The env read is duplicated rather than imported because
  // auth-session.ts imports this module; keep the two in step.
  // Validate: AbortSignal.timeout takes [EnforceRange] unsigned long long, so a
  // NaN from a non-numeric env value throws a TypeError synchronously and would
  // take the whole mint path down — worse than the skewed
  // staleMintThresholdSeconds() a malformed value used to cause. A zero or
  // negative value would abort instantly, so both fall back to the default.
  const configured = Number.parseInt(process.env.WEB_SESSION_MINT_TIMEOUT_SECONDS || "180", 10);
  const seconds = Number.isFinite(configured) && configured > 0 ? configured : 180;
  const abortMs = (seconds + 15) * 1000;
  const res = await fetchImpl(`${target.url}/mint`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${target.mintSecret}` },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(abortMs),
  });
  if (!res.ok) {
    // Fold the broker's own diagnosis into the message. Without this the whole
    // selection/scrub/URL-reduction pipeline in auth-session-broker.ts only
    // ever reaches the sidecar's container log, and Core — plus everything
    // downstream of webSessions.lastError — still says only "502".
    // The body is already summarized, scrubbed and URL-reduced broker-side; cap
    // it anyway, since it is third-party text on a durable field.
    let detail = "";
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body?.error === "string") detail = body.error.slice(0, 500);
    } catch {
      /* non-JSON body — the status alone is all we can report */
    }
    // Re-redact with OUR copies rather than trusting the broker's scrub. Core
    // holds the plaintext pair and is the one writing the durable field, so a
    // stale or buggy broker echoing a credential must not become a leak here.
    // credentialForms, not the raw pair: a backstop that covers fewer encodings
    // than the layer it backstops is weakest exactly when it is needed — the
    // broker failing to scrub is the case where an escaped or URL-encoded
    // spelling arrives.
    detail = redactValues(detail, credentialForms([req.email, req.password]));
    throw new Error(`broker mint failed: ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return res.json();
}
