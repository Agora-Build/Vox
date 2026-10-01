// "auth-session" = login-session minting (browser + aeval); "restful" = trusted
// HTTP execution for restful.* steps referencing broker-class secrets (design
// 2026-09-21 §5). One list gates secret classification (resolveBrokerType),
// broker registration, and routeToBroker — adding a type here unlocks all three.
export const KNOWN_BROKER_TYPES = ["auth-session", "restful"] as const;
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
import { credentialForms, redactValues, reduceUrlsSafely } from "@shared/credentials";

export { mintTimeoutSeconds } from "@shared/mint-timeout";
import { mintTimeoutSeconds } from "@shared/mint-timeout";

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

// ---- restful broker (design 2026-09-21 §5) ---------------------------------
// The trusted-execution twin of mintViaBroker: Core resolves the request
// template from the frozen snapshot, the broker performs the HTTP call, and
// everything returned to an agent is redacted with CORE's copies of the
// resolved secret values (never trusting the broker) then capped.

export interface RestExecRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  expectStatus?: number[];
  timeoutMs?: number;
}
export interface RestExecResult { status: number; ok: boolean; bodyExcerpt: string }

const REST_EXEC_DEFAULT_TIMEOUT_MS = 30_000;
const REST_EXEC_EXCERPT_CAP = 2048;

export async function executeViaBroker(
  target: BrokerTarget,
  req: RestExecRequest,
  redactNeedles: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<RestExecResult> {
  const abortMs = (req.timeoutMs ?? REST_EXEC_DEFAULT_TIMEOUT_MS) + 15_000;
  const res = await callBroker("REST", `${target.url}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${target.mintSecret}` },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(abortMs),
  }, fetchImpl);
  const needles = credentialForms(redactNeedles.filter(Boolean));
  if (!res.ok) {
    let detail = "";
    try {
      const raw = (await res.text()).slice(0, 8192);
      const body = JSON.parse(raw) as { error?: unknown };
      if (typeof body?.error === "string") detail = body.error;
    } catch { /* non-JSON body — status alone */ }
    // Redact BEFORE truncating (a slice-first can leave a partial credential
    // matching no whole needle) — same ordering as mintViaBroker.
    detail = redactValues(detail, needles).slice(0, 500);
    throw new Error(`broker exec failed: ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  const parsed = (await res.json()) as { status?: unknown; bodyExcerpt?: unknown };
  const status = typeof parsed.status === "number" ? parsed.status : 0;
  const excerptRaw = typeof parsed.bodyExcerpt === "string" ? parsed.bodyExcerpt : "";
  const bodyExcerpt = redactValues(excerptRaw, needles).slice(0, REST_EXEC_EXCERPT_CAP);
  const ok = req.expectStatus && req.expectStatus.length > 0
    ? req.expectStatus.includes(status)
    : status >= 200 && status < 300;
  return { status, ok, bodyExcerpt };
}

/**
 * What a failed fetch to a broker means, in words (#129). undici throws a bare
 * "fetch failed" TypeError and keeps the reason in `cause`; that bare text is
 * what users saw as "target login failed: fetch failed" when Core couldn't even
 * resolve the broker's hostname.
 */
export function describeFetchFailure(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "no answer in time";
  const code = e?.cause?.code;
  switch (code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `its hostname doesn't resolve from Core (${code})`;
    case "ECONNREFUSED":
      return "connection refused (nothing listening at its advertised address)";
    case "ECONNRESET":
    case "UND_ERR_SOCKET":
      return `connection dropped (${code})`;
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return `host unreachable (${code})`;
  }
  return code ? `${e?.cause?.message ?? e?.message ?? "network error"} (${code})` : (e?.message ?? String(err));
}

const PROBE_TIMEOUT_MS = 5_000;

/**
 * #129: can Core reach this broker? Heartbeats prove only broker→Core; a mint
 * needs Core→broker, and a wrong BROKER_ADVERTISE_URL used to look healthy
 * until the first mint. Both brokers serve an unauthenticated GET /health.
 * Returns null when reachable, else why not.
 */
export async function probeBroker(url: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return res.ok ? null : `GET /health answered HTTP ${res.status}`;
  } catch (err) {
    return describeFetchFailure(err);
  }
}

/**
 * Probe a broker and record the answer on its row. Logs only when the answer
 * changes (or on the first probe of an unreachable one), so a broker that
 * stays down says so once rather than every minute. Never throws.
 */
export async function probeAndRecordBroker(
  broker: Pick<Broker, "id" | "name" | "url" | "reachabilityCheckedAt" | "reachabilityError">,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const error = await probeBroker(broker.url, fetchImpl);
  try {
    await storage.recordBrokerReachability(broker.id, broker.url, error);
  } catch (err) {
    console.error(`[Broker] recording reachability of broker ${broker.id} failed:`, err instanceof Error ? err.message : err);
  }
  const wasReachable = broker.reachabilityCheckedAt != null && broker.reachabilityError == null;
  if (error && error !== broker.reachabilityError) {
    console.warn(`[Broker] "${broker.name}" (#${broker.id}) is not reachable from Core at ${broker.url}: ${error}. Mints and REST calls routed to it will fail — check its BROKER_ADVERTISE_URL.`);
  } else if (!error && !wasReachable && broker.reachabilityCheckedAt != null) {
    console.log(`[Broker] "${broker.name}" (#${broker.id}) is reachable from Core again at ${broker.url}`);
  }
  return error;
}

/** Fetch to a broker, turning a transport failure into a stated cause. */
async function callBroker(what: string, url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (err) {
    throw new Error(`Core couldn't reach the ${what} broker: ${describeFetchFailure(err)}`);
  }
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
  // never fired.
  const abortMs = (mintTimeoutSeconds() + 15) * 1000;
  const res = await callBroker("session", `${target.url}/mint`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${target.mintSecret}` },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(abortMs),
  }, fetchImpl);
  if (res.status === 401 || res.status === 403) {
    // The broker doesn't know Core's mint secret: it restarted and hasn't
    // re-registered yet (it does on its next heartbeat). Not a login failure.
    throw new Error(`the session broker refused Core (HTTP ${res.status}); it re-registers within a minute — retry then`);
  }
  if (!res.ok) {
    // Fold the broker's own diagnosis into the message. Without this the whole
    // selection/scrub/URL-reduction pipeline in auth-session-broker.ts only
    // ever reaches the sidecar's container log, and Core — plus everything
    // downstream of webSessions.lastError — still says only "502".
    // The body is already summarized, scrubbed and URL-reduced broker-side; cap
    // it anyway, since it is third-party text on a durable field.
    let detail = "";
    try {
      // Bounds what is RETAINED, not what is allocated: res.text() buffers the
      // whole body first. The peer is an internal, authenticated sidecar and
      // AbortSignal.timeout bounds the read, so that is an accepted limit — the
      // cap is here to keep a large body out of the durable error, not to
      // defend Core's heap. 8 KiB is far more than a summarized error needs.
      const raw = (await res.text()).slice(0, 8192);
      const body = JSON.parse(raw) as { error?: unknown };
      if (typeof body?.error === "string") detail = body.error;
    } catch {
      /* non-JSON or truncated body — the status alone is all we can report */
    }
    // Re-redact with OUR copies rather than trusting the broker's scrub. Core
    // holds the plaintext pair and is the one writing the durable field, so a
    // stale or buggy broker echoing a credential must not become a leak here.
    // credentialForms, not the raw pair: a backstop that covers fewer encodings
    // than the layer it backstops is weakest exactly when it is needed — the
    // broker failing to scrub is the case where an escaped or URL-encoded
    // spelling arrives.
    // Redact BEFORE truncating, the ordering this whole change argues for
    // elsewhere: slicing first can leave a partial credential that matches no
    // whole needle, and this string is persisted to web_sessions.last_error.
    // URL-reduced too, as the broker does (#139): a broker that failed to scrub
    // also failed to reduce, and a full URL can carry the account in its query
    // (login_hint=) in a spelling no needle covers. reduceUrlsSafely redacts a
    // URL-shaped credential before the reduction could cut it apart.
    const forms = credentialForms([req.email, req.password]);
    // Redact before the reduction as well as after: a credential echoed inside
    // a URL can contain a character that ends the URL run (" ' < > space), so
    // the reduction would cut it in two and neither half would match a needle.
    // Not the URL-shaped forms, though — reduceUrlsSafely redacts those itself
    // together with the rest of their URL; replacing just the needle first
    // would strand its query (?access_token=…) outside anything URL-like.
    // URL schemes are kept out of that first pass: a credential that is, or
    // ends like, a scheme ("https") would otherwise turn
    // https://host/?access_token=… into [redacted]://host/…, which no longer
    // looks like a URL, so its path and query would survive the reduction.
    // Split at the schemes and redact only the text between them — positional,
    // so no marker character exists for a credential to collide with.
    const nonUrlForms = forms.filter((f) => !f.includes("://"));
    const pre = detail
      .split(/((?:https?|wss?):\/\/)/i) // odd indices are the schemes themselves
      .map((part, i) => (i % 2 === 1 ? part : redactValues(part, nonUrlForms)))
      .join("");
    detail = redactValues(reduceUrlsSafely(pre, forms), forms).slice(0, 500);
    // 502 is the broker's "the login itself failed" (aeval ran and the target
    // refused or never finished); say so, so it isn't read as a broker fault.
    throw new Error(res.status === 502
      ? `target login failed${detail ? `: ${detail}` : " (HTTP 502)"}`
      : `the session broker failed: HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return res.json();
}
