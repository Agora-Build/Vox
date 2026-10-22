/**
 * Agent network signals — the agent's side of "Last mile vs datacenter
 * (access)" in designs/2026-10-22-network-tags-design.md (Part-2 Task 3).
 * Reported on every register/heartbeat, refreshed each beat (cloud metadata
 * is cached 10 minutes since it almost never changes mid-process).
 *
 * Two independent signals, both only ever able to push Core's classifier
 * AWAY from "lastmile" (server/access-class.ts):
 * - `cloudMetadata`: true if a cloud provider's instance-metadata service
 *   answers at all — even a 401 (AWS IMDSv1 without a token) still proves a
 *   metadata service is there to answer.
 * - `publicIpOnInterface`: true if the default-route interface itself holds
 *   a public (non-private) address — a NAT'd lastmile host never sees this,
 *   a server with a routable IP directly on the NIC does.
 *
 * Injectable (fetch/env/platform/sysRoot/exec/clock) so detection never
 * touches the real network or filesystem in tests — same shape as
 * `DetectLinkTypeDeps` in ./link-type.ts, which this module deliberately
 * does not import from: duplicating the few lines of default-route-interface
 * logic keeps this module's tests from being able to break Part-1's.
 *
 * Container caveat (reuses Part-1's container-detection idea): inside a
 * container, the cloud-metadata HTTP probes work fine (they're an outbound
 * HTTP call Docker doesn't touch), but the interface check would see the
 * container's own veth, not the host's NIC — so without an explicit
 * `VOX_PUBLIC_IP_ON_IFACE` override, `publicIpOnInterface` reports
 * `undefined` (omitted on the wire) rather than a wrong answer about a
 * virtual interface. `cloudMetadata` has no such caveat and is detected
 * normally in a container.
 */
import fs from "fs";
import path from "path";

export interface NetSignals {
  cloudMetadata?: boolean;
  publicIpOnInterface?: boolean;
}

// ---------------------------------------------------------------------------
// Cloud metadata
// ---------------------------------------------------------------------------

/** Fetch-shaped: real usage passes global `fetch`; tests pass a fake that
 *  resolves/rejects per probe without any real network or timer wait. */
export type FetchLike = (
  url: string,
  init: { headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<{ status: number }>;

export interface CloudMetadataDeps {
  fetch: FetchLike;
  /** Clock in ms, like `Date.now` — injectable so the 10-minute cache is testable without a real wait. */
  now: () => number;
}

const PROBE_TIMEOUT_MS = 500;
export const CLOUD_METADATA_CACHE_MS = 10 * 60 * 1000;

interface CloudMetadataProbeSpec {
  url: string;
  headers?: Record<string, string>;
}

// AWS IMDSv1 may 401 (token required under IMDSv2) — a 401 still proves a
// metadata service answered, so only a thrown error (timeout, connection
// refused, DNS failure) counts as "no answer" for any of these three.
const CLOUD_METADATA_PROBES: readonly CloudMetadataProbeSpec[] = [
  { url: "http://169.254.169.254/latest/meta-data/" }, // AWS
  { url: "http://169.254.169.254/metadata/instance?api-version=2021-02-01", headers: { Metadata: "true" } }, // Azure
  { url: "http://metadata.google.internal/computeMetadata/v1/", headers: { "Metadata-Flavor": "Google" } }, // GCP
];

async function probeOnce(fetchFn: FetchLike, probe: CloudMetadataProbeSpec): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetchFn(probe.url, { headers: probe.headers, signal: controller.signal });
    return typeof res.status === "number";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** One pass over all three cloud-metadata probes, uncached. Any of the three
 *  answering (status code, including 401) → true; all failing/timing out → false. */
export async function probeCloudMetadata(deps: CloudMetadataDeps): Promise<boolean> {
  const results = await Promise.all(CLOUD_METADATA_PROBES.map((probe) => probeOnce(deps.fetch, probe)));
  return results.some(Boolean);
}

/** Caches `probeCloudMetadata` for 10 minutes (per instance) — register fires
 *  once, heartbeats fire often; no need to re-probe every beat. */
export class CloudMetadataCache {
  private cached: { value: boolean; expiresAt: number } | null = null;

  async get(deps: CloudMetadataDeps): Promise<boolean> {
    const nowMs = deps.now();
    if (this.cached && nowMs < this.cached.expiresAt) return this.cached.value;
    const value = await probeCloudMetadata(deps);
    this.cached = { value, expiresAt: nowMs + CLOUD_METADATA_CACHE_MS };
    return value;
  }
}

// ---------------------------------------------------------------------------
// Public IP on the default-route interface
// ---------------------------------------------------------------------------

export interface PublicIpDeps {
  env: Record<string, string | undefined>;
  /** `process.platform`-shaped: only `"linux"` and `"darwin"` are detected; anything else → undefined. */
  platform: string;
  /** Prefixed before `/sys/class/net/...` and `/.dockerenv` — `""` for the real root, a temp dir in tests. */
  sysRoot: string;
  /** Runs a shell command and returns its stdout, or throws on failure. */
  exec: (cmd: string) => string;
}

function defaultRouteInterfaceLinux(exec: PublicIpDeps["exec"]): string | undefined {
  const out = exec("ip route get 1.1.1.1");
  return out.match(/\bdev\s+(\S+)/)?.[1];
}

/** Same idea as Part-1's link-type virtual-interface check: a container sees
 *  only its own veth, never the host's real NIC, so without an explicit
 *  override there is nothing meaningful to report. */
function isContainer(deps: PublicIpDeps): boolean {
  if (fs.existsSync(path.join(deps.sysRoot, "/.dockerenv"))) return true;
  if (deps.platform !== "linux") return false;
  try {
    const iface = defaultRouteInterfaceLinux(deps.exec);
    if (!iface) return false;
    const deviceLink = path.join(deps.sysRoot, "/sys/class/net", iface, "device");
    return !fs.existsSync(deviceLink);
  } catch {
    return false;
  }
}

function isPublicIPv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false;
  const [a, b] = parts;
  if (a === 10) return false; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return false; // RFC1918
  if (a === 192 && b === 168) return false; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT, RFC6598
  if (a === 169 && b === 254) return false; // link-local
  if (a === 127) return false; // loopback
  return true;
}

function isPublicIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === "::1") return false; // loopback
  if (/^fe[89ab][0-9a-f]:/.test(normalized)) return false; // link-local, fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return false; // unique local, fc00::/7
  const firstHextet = parseInt(normalized.split(":")[0] || "", 16);
  if (Number.isNaN(firstHextet)) return false;
  return firstHextet >= 0x2000 && firstHextet <= 0x3fff; // global unicast, 2000::/3
}

function hasPublicAddress(out: string): boolean {
  const v4 = [...out.matchAll(/\binet\s+(\d+\.\d+\.\d+\.\d+)/g)].map((m) => m[1]);
  const v6 = [...out.matchAll(/\binet6\s+([0-9a-fA-F:]+)/g)].map((m) => m[1].split("%")[0]);
  return v4.some(isPublicIPv4) || v6.some(isPublicIPv6);
}

function detectLinuxPublicIp(deps: PublicIpDeps): boolean | undefined {
  const iface = defaultRouteInterfaceLinux(deps.exec);
  if (!iface) return undefined;
  const out = deps.exec(`ip -o addr show dev ${iface}`);
  return hasPublicAddress(out);
}

function detectDarwinPublicIp(deps: PublicIpDeps): boolean | undefined {
  const routeOut = deps.exec("route -n get default");
  const iface = routeOut.match(/^\s*interface:\s*(\S+)/m)?.[1];
  if (!iface) return undefined;
  const out = deps.exec(`ifconfig ${iface}`);
  return hasPublicAddress(out);
}

/**
 * `VOX_PUBLIC_IP_ON_IFACE=true|false` in the environment wins outright
 * (vox-upgrade.sh sets it from the HOST's own detection, since a container
 * only sees its own veth). Otherwise: inside a container, `undefined`
 * (nothing meaningful to report); on the host, Linux/macOS detection;
 * anything else, or any detection failure, → `undefined`.
 */
export function detectPublicIpOnInterface(deps: PublicIpDeps): boolean | undefined {
  const override = deps.env.VOX_PUBLIC_IP_ON_IFACE;
  if (override === "true") return true;
  if (override === "false") return false;

  if (isContainer(deps)) return undefined;

  try {
    if (deps.platform === "linux") return detectLinuxPublicIp(deps);
    if (deps.platform === "darwin") return detectDarwinPublicIp(deps);
    return undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Combined detection + wire helper
// ---------------------------------------------------------------------------

export type NetSignalsDeps = CloudMetadataDeps & PublicIpDeps;

/** Holds the 10-minute cloud-metadata cache across repeated calls (one
 *  instance lives for the daemon's whole process, like `dialfProbeCache`). */
export class NetSignalsDetector {
  private cloudMetadataCache = new CloudMetadataCache();

  async detect(deps: NetSignalsDeps): Promise<NetSignals> {
    const [cloudMetadata, publicIpOnInterface] = await Promise.all([
      this.cloudMetadataCache.get(deps),
      Promise.resolve(detectPublicIpOnInterface(deps)),
    ]);
    return { cloudMetadata, publicIpOnInterface };
  }
}

/**
 * Add `netSignals` to a register/heartbeat body — but only the fields that
 * were actually detected, and only if at least one was (mirrors
 * `withLinkType` in ./link-type.ts). `undefined` means "couldn't tell this
 * time" and must be OMITTED, never sent as `null`.
 */
export function withNetSignals<T extends Record<string, unknown>>(
  body: T,
  signals: NetSignals
): T & { netSignals?: NetSignals } {
  const entries = Object.entries(signals).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return body;
  return { ...body, netSignals: Object.fromEntries(entries) as NetSignals };
}
