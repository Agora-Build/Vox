import { REGION_ELIGIBLE_TRUST, type LocationTrust } from "@shared/schema";
import { open as maxmindOpen, type Reader, type Response as MmdbResponse, type CityResponse, type AsnResponse } from "maxmind";
import { readFileSync } from "fs";
import path from "path";
import { storage } from "./storage";
import { getMarketplace } from "./marketplace";
import type { RegionCandidate } from "@shared/regions";
import { refreshGeoipDatabases, type GeoipSource } from "./geoip-refresh";
import { getAccessData, reloadAccessData, networkClassOf } from "./access-data";
import { refreshAccessData, accessDataNeedsRefresh, scheduleAccessRetry, ACCESS_REFRESH_INTERVAL_MS } from "./access-data-refresh";
import { geoipAttributionForSource } from "@shared/geoip-attribution";

export type { RegionCandidate };

export interface GeoLookup {
  city?: string; countryCode?: string; countryName?: string; continentCode?: string;
  lat?: number; lon?: number; accuracyKm?: number;
}
export interface AsnLookup { asn?: number; org?: string }
export interface LocationSignals {
  geo: GeoLookup | null;
  asn: AsnLookup | null;
  isTorExit: boolean;
  netClass: "vpn" | "hosting" | null;
}
export interface Detection {
  trust: LocationTrust;
  candidate: RegionCandidate | null; // non-null iff trust is region-eligible
  source: {
    city: string | null; countryCode: string | null;
    lat: number | null; lon: number | null; accuracyKm: number | null;
    asn: number | null; asnOrg: string | null; signals: string[];
  };
  /**
   * Set when `trust` is low_confidence only because the VPN/datacenter data
   * hasn't loaded (detection would otherwise have said trusted/datacenter).
   * An ambiguous answer: runAgentLocationCheck records it but moves no region.
   */
  capped?: true;
}
export interface LocationNextState {
  region: string | null;      // next region baseId (null = Unverified)
  changed: boolean;           // true → caller must (re)allocate or clear siteId
  pendingRegion: string | null;
  pendingRegionCount: number;
}
export const MAX_CITY_ACCURACY_KM = 100;
export const CATALOG_MATCH_KM = 100;
export const REGION_CHANGE_STABILITY = 3;
// How stale an agent's last location check may get before a heartbeat re-runs
// detection (IP changes and pending hysteresis re-check regardless). A check is
// a sub-ms local mmdb lookup + one row update, so a short window is cheap; flap
// protection lives in REGION_CHANGE_STABILITY, not here.
export const LOCATION_RECHECK_HOURS = 2;

const PRIVATE_V4: Array<[number, number]> = [
  // [network as u32, prefix length] — RFC1918 + loopback + link-local + CGNAT
  [0x0a000000, 8],    // 10/8
  [0xac100000, 12],   // 172.16/12
  [0xc0a80000, 16],   // 192.168/16
  [0x7f000000, 8],    // 127/8
  [0xa9fe0000, 16],   // 169.254/16
  [0x64400000, 10],   // 100.64/10 (CGNAT)
];

function v4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

// v4-mapped v6 (::ffff:a.b.c.d) reduced to its bare form, so callers matching
// against a plain-v4 set (Tor exit list, geo/ASN mmdb lookups) don't silently
// miss a hit just because the request arrived through a v4-mapped socket.
export function normalizeIp(ip: string): string {
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

export function isPublicIp(ip: string): boolean {
  if (!ip) return false;
  const bare = normalizeIp(ip);
  const v4 = v4ToInt(bare);
  if (v4 !== null) {
    return !PRIVATE_V4.some(([net, bits]) => (v4 >>> (32 - bits)) === (net >>> (32 - bits)));
  }
  if (!bare.includes(":")) return false; // neither valid v4 nor v6
  const lower = bare.toLowerCase();
  if (lower === "::1" || lower === "::") return false;
  // fc00::/7 (unique local), fe80::/10 (link-local)
  if (/^f[cd]/.test(lower) || lower.startsWith("fe8") || lower.startsWith("fe9")
    || lower.startsWith("fea") || lower.startsWith("feb")) return false;
  return true;
}

export function slugCity(city: string): string {
  return city.normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]/g, "");
}

const MACROS: Record<string, { code: string; name: string }> = {
  NA: { code: "na", name: "North America" },
  SA: { code: "sa", name: "South America" },
  EU: { code: "eu", name: "Europe" },
  AS: { code: "apac", name: "Asia Pacific" },
  OC: { code: "apac", name: "Asia Pacific" },
  AF: { code: "af", name: "Africa" },
};

export function macroForContinent(continentCode: string): { code: string; name: string } | null {
  return MACROS[continentCode] ?? null;
}

export function deriveRegionCandidate(geo: GeoLookup): RegionCandidate | null {
  if (!geo.city || !geo.countryCode || !geo.continentCode
    || geo.lat === undefined || geo.lon === undefined) return null;
  const macro = macroForContinent(geo.continentCode);
  if (!macro) return null;
  const slug = slugCity(geo.city);
  if (!slug) return null;
  return {
    baseId: `${macro.code}-${geo.countryCode.toLowerCase()}-${slug}`,
    displayName: geo.city,
    city: geo.city,
    countryCode: geo.countryCode.toUpperCase(),
    countryName: geo.countryName ?? geo.countryCode.toUpperCase(),
    macroRegionCode: macro.code,
    macroRegionName: macro.name,
    latitude: geo.lat,
    longitude: geo.lon,
  };
}

// haversineKm lives in shared/regions.ts (dependency-free) because
// server/storage.ts also needs it and storage must NOT import from
// ./location (location imports storage — cycle). Re-export it here:
export { haversineKm } from "@shared/regions";

export function classifyLocation(ip: string, signals: LocationSignals): Detection {
  const source = {
    city: signals.geo?.city ?? null,
    countryCode: signals.geo?.countryCode ?? null,
    lat: signals.geo?.lat ?? null,
    lon: signals.geo?.lon ?? null,
    accuracyKm: signals.geo?.accuracyKm ?? null,
    asn: signals.asn?.asn ?? null,
    asnOrg: signals.asn?.org ?? null,
    signals: [
      ...(signals.isTorExit ? ["tor-exit"] : []),
      ...(signals.netClass ? [`net:${signals.netClass}`] : []),
    ],
  };
  const done = (trust: LocationTrust, candidate: RegionCandidate | null = null): Detection =>
    ({ trust, candidate, source });

  // Ladder — first match wins (spec: detection pipeline).
  if (!isPublicIp(ip)) return done("unknown");
  if (signals.isTorExit || signals.netClass === "vpn") return done("anonymized");
  if (!signals.geo || !signals.geo.city
    || (signals.geo.accuracyKm !== undefined && signals.geo.accuracyKm > MAX_CITY_ACCURACY_KM)) {
    return done("low_confidence");
  }
  const candidate = deriveRegionCandidate(signals.geo);
  if (!candidate) return done("low_confidence");
  if (signals.netClass === "hosting") return done("datacenter", candidate);
  return done("trusted", candidate);
}

export function decideLocationTransition(
  agent: { region: string | null; siteId: string | null; pendingRegion: string | null; pendingRegionCount: number },
  det: { trust: LocationTrust; baseId: string | null },
  opts: { immediate: boolean },
): LocationNextState {
  const eligible = REGION_ELIGIBLE_TRUST.includes(det.trust) && det.baseId !== null;
  if (!eligible) {
    // Distrust fast: clear at once; pending state is meaningless now. A
    // formerly-public agent can have region already null while still
    // carrying a REAL siteId from its old public-tier configuration — that
    // stale site must be cleared too, or it survives and can match
    // site-pinned claims even though the agent is now Unverified.
    return {
      region: null,
      changed: agent.region !== null || agent.siteId !== null,
      pendingRegion: null, pendingRegionCount: 0,
    };
  }
  if (det.baseId === agent.region) {
    return { region: agent.region, changed: false, pendingRegion: null, pendingRegionCount: 0 };
  }
  if (opts.immediate) {
    // Registration is a fresh process — apply without hysteresis (spec).
    return { region: det.baseId, changed: true, pendingRegion: null, pendingRegionCount: 0 };
  }
  const count = det.baseId === agent.pendingRegion ? agent.pendingRegionCount + 1 : 1;
  if (count >= REGION_CHANGE_STABILITY) {
    return { region: det.baseId, changed: true, pendingRegion: null, pendingRegionCount: 0 };
  }
  return { region: agent.region, changed: false, pendingRegion: det.baseId, pendingRegionCount: count };
}

// ==================== DETECTION SHELL ====================
// Live mmdb/Tor/ASN loaders + injectable deps for tests. Missing GeoIP DBs or
// Tor fetch failures must degrade gracefully — never crash startup/registration.

export interface DetectionDeps {
  geo: (ip: string) => GeoLookup | null;
  asn: (ip: string) => AsnLookup | null;
  torExits: ReadonlySet<string>;
  // VPN / hosting class of an IP (+ its ASN) from the downloaded access data
  // (server/access-data.ts: X4BNet/ipcat ranges, PeeringDB Content).
  networkClass: (ip: string, asn: number | undefined) => "vpn" | "hosting" | null;
  // Whether the VPN + datacenter data actually loaded. Unloaded data answers
  // null for every IP, identical to a LOADED-BUT-CLEAN lookup — without this
  // flag a first boot (or every download failing with no copy on disk) fails
  // open: a datacenter/VPN egress with clean geo would score "trusted" purely
  // because there was nothing to classify it against. See detectLocation.
  networkClassLoaded: boolean;
}

// Duplicated (not imported) from server/geoip-refresh.ts on purpose — see the
// import-direction note at the top of that file. geoip-refresh.ts never
// imports this module, so this module is the one that may import it back.
const GEOIP_DIR = process.env.GEOIP_DB_DIR || path.join(process.cwd(), "geoip");
const GEOIP_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const GEOIP_REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

let cityReader: Reader<CityResponse> | null = null;
let asnReader: Reader<AsnResponse> | null = null;
let torExits: Set<string> = new Set();
let warnedPrivateIp = false;
// Derived from loaded readers, with geoip-meta.json as a fallback for an
// unrecognized database header. Both DB-IP Lite and GeoLite2 require public
// attribution. Exposed via /api/config → footer.
let geoipAttribution: string | null = null;

export function getGeoipAttribution(): string | null {
  return geoipAttribution;
}

interface LoadedGeoReader<T extends MmdbResponse> {
  reader: Reader<T>;
  source: GeoipSource | null;
}

async function tryOpen<T extends MmdbResponse>(names: string[], opener: (p: string) => Promise<Reader<T>>): Promise<LoadedGeoReader<T> | null> {
  for (const name of names) {
    try {
      const reader = await opener(path.join(GEOIP_DIR, name));
      const databaseType = reader.metadata?.databaseType?.toLowerCase() ?? "";
      const source = databaseType.startsWith("geolite2") ? "geolite2"
        : databaseType.startsWith("dbip") ? "dbip"
        : name.startsWith("GeoLite2-") ? "geolite2" : null;
      return { reader, source };
    }
    catch { /* try the next name */ }
  }
  return null;
}

function refreshAttribution(sources: Array<GeoipSource | null>): void {
  const activeSources = new Set(sources.filter((source): source is GeoipSource => source !== null));
  if (sources.includes(null)) {
    try {
      const meta = JSON.parse(readFileSync(path.join(GEOIP_DIR, "geoip-meta.json"), "utf8")) as { source?: unknown };
      if (meta.source === "dbip" || meta.source === "geolite2") activeSources.add(meta.source);
    } catch { /* Legacy/manual databases may have no refresh metadata. */ }
  }
  geoipAttribution = Array.from(activeSources).map(geoipAttributionForSource).join("; ") || null;
}

/**
 * Re-opens the mmdb readers from disk and swaps the module-level refs. Safe
 * to call when the files are absent (readers become null; agents stay
 * Unverified rather than the process crashing). Called once at startup and
 * again after every successful refreshGeoipDatabases() call — it is the
 * `reload` dependency startLocationServices() and the admin refresh route
 * inject into refreshGeoipDatabases().
 */
export async function reloadGeoReaders(): Promise<void> {
  // Canonical names first (City.mmdb/ASN.mmdb, written by the in-app
  // refresher); GeoLite2-*.mmdb kept as a fallback for existing deployments
  // that still have files under the old script's names.
  const city = await tryOpen<CityResponse>(["City.mmdb", "GeoLite2-City.mmdb"], maxmindOpen);
  if (!city) console.log("[location] no City mmdb found — geolocation disabled (all agents Unverified)");
  cityReader = city?.reader ?? null;

  const asn = await tryOpen<AsnResponse>(["ASN.mmdb", "GeoLite2-ASN.mmdb"], maxmindOpen);
  if (!asn) console.log("[location] no ASN mmdb found — ASN signals disabled");
  asnReader = asn?.reader ?? null;

  const loaded = [city, asn].filter((reader) => reader !== null);
  refreshAttribution(loaded.map((reader) => reader.source));
}

export function startLocationServices(): void {
  void (async () => {
    await reloadGeoReaders();
    let stale = true;
    try {
      const meta = JSON.parse(readFileSync(path.join(GEOIP_DIR, "geoip-meta.json"), "utf8")) as { fetchedAt?: string };
      const fetchedAt = meta.fetchedAt ? new Date(meta.fetchedAt).getTime() : NaN;
      stale = !(Number.isFinite(fetchedAt) && Date.now() - fetchedAt < GEOIP_STALE_MS);
    } catch { stale = true; }
    const missing = !cityReader || !asnReader;
    if (missing || stale) {
      console.log(`[location] geoip refresh triggered at startup (${missing ? "database(s) missing" : "data older than 7 days"})`);
      void refreshGeoipDatabases({ reload: reloadGeoReaders });
    }
  })();
  setInterval(() => { void refreshGeoipDatabases({ reload: reloadGeoReaders }); }, GEOIP_REFRESH_INTERVAL_MS).unref();

  // Network access data (VPN/datacenter ranges, APNIC, mobile ASNs): load
  // what's on disk, download when missing or older than 7 days, weekly after.
  // Until the VPN + datacenter lists have loaded, detectLocation caps trust
  // at low_confidence (fail closed).
  const accessClassLoaded = () => { const d = getAccessData(); return d.loaded.datacenter && d.loaded.vpn; };
  const refreshAccess = async () => {
    const result = await refreshAccessData();
    if (Object.values(result.sources).some((s) => s?.ok)) await reloadAccessData(GEOIP_DIR);
  };
  void (async () => {
    const data = await reloadAccessData(GEOIP_DIR);
    if (!data.loaded.datacenter || !data.loaded.vpn) {
      console.log("[location] VPN/datacenter data not loaded — location trust capped at low_confidence until downloaded");
    }
    if (accessDataNeedsRefresh(GEOIP_DIR)) {
      console.log("[location] access data refresh triggered at startup (missing or older than 7 days)");
      await refreshAccess().catch(() => {});
    }
    if (!accessClassLoaded()) {
      // No usable copy: retry with backoff (15 → 60 min) until the VPN and
      // datacenter lists load, rather than waiting for the weekly timer.
      scheduleAccessRetry(async () => { await refreshAccess(); return accessClassLoaded(); });
    }
  })().catch((err) => console.error(`[location] access data startup failed: ${err instanceof Error ? err.message : String(err)}`));
  setInterval(() => { void refreshAccess().catch(() => {}); }, ACCESS_REFRESH_INTERVAL_MS).unref();
  const refreshTor = async () => {
    try {
      const res = await fetch("https://check.torproject.org/torbulkexitlist");
      if (res.ok) {
        torExits = new Set((await res.text()).split("\n").map(l => l.trim()).filter(Boolean));
      } else {
        console.warn(`[location] Tor exit list refresh failed (HTTP ${res.status}) — keeping previous list`);
      }
    } catch (err) {
      console.warn(`[location] Tor exit list refresh failed (${err instanceof Error ? err.message : String(err)}) — keeping previous list`);
    }
  };
  void refreshTor();
  setInterval(refreshTor, 12 * 60 * 60 * 1000).unref();
}

/** The live detection deps (exported for tests: proves the fail-closed default). */
export function liveDetectionDeps(): DetectionDeps {
  return liveDeps();
}

function liveDeps(): DetectionDeps {
  const access = getAccessData();
  return {
    geo: (ip) => {
      const hit = cityReader?.get(ip);
      if (!hit) return null;
      return {
        city: hit.city?.names?.en,
        countryCode: hit.country?.iso_code,
        countryName: hit.country?.names?.en,
        continentCode: hit.continent?.code,
        lat: hit.location?.latitude,
        lon: hit.location?.longitude,
        accuracyKm: hit.location?.accuracy_radius,
      };
    },
    asn: (ip) => {
      const hit = asnReader?.get(ip);
      return hit ? { asn: hit.autonomous_system_number, org: hit.autonomous_system_organization } : null;
    },
    torExits,
    networkClass: (ip, asn) => networkClassOf(access, ip, asn),
    networkClassLoaded: access.loaded.datacenter && access.loaded.vpn,
  };
}

/**
 * ASN of one IP from the shipped ASN database — for the detected `isp` tag
 * frozen at claim (server/job-tags.ts). Null when the database isn't loaded,
 * the IP isn't public, or the reader rejects it: no answer, never a throw,
 * because a claim must not fail over a missing tag.
 */
export function lookupAsn(ip: string): AsnLookup | null {
  const bare = normalizeIp(ip);
  if (!isPublicIp(bare)) return null;
  try {
    return liveDeps().asn(bare);
  } catch {
    return null;
  }
}

export function detectLocation(ip: string, deps: DetectionDeps = liveDeps()): Detection {
  const bare = normalizeIp(ip);
  if (!isPublicIp(bare)) {
    // Deployment tripwire (spec): a private IP in production means the proxy
    // hop count is likely wrong — every agent would geolocate to nothing.
    if (process.env.NODE_ENV === "production" && !warnedPrivateIp) {
      warnedPrivateIp = true;
      console.warn(`[location] observed a private client IP (${ip}) in production — trust-proxy hop count likely misconfigured; agents will stay Unverified`);
    }
    return classifyLocation(bare, { geo: null, asn: null, isTorExit: false, netClass: null });
  }
  const asnInfo = deps.asn(bare);
  const det = classifyLocation(bare, {
    geo: deps.geo(bare),
    asn: asnInfo,
    isTorExit: deps.torExits.has(bare),
    netClass: deps.networkClass(bare, asnInfo?.asn),
  });
  // VPN/datacenter data never loaded — an unloaded lookup is indistinguishable
  // from a clean one, so "trusted"/"datacenter" here would be failing open on
  // exactly the signal meant to catch VPN/hosting egress. Cap at
  // low_confidence instead (never region-eligible — see REGION_ELIGIBLE_TRUST).
  if (!deps.networkClassLoaded && (det.trust === "trusted" || det.trust === "datacenter")) {
    return { trust: "low_confidence", candidate: null, source: det.source, capped: true };
  }
  return det;
}

export async function resolveCatalogRegion(candidate: RegionCandidate): Promise<string> {
  const near = await storage.findNearestActiveRegion(candidate.latitude, candidate.longitude, CATALOG_MATCH_KM);
  if (near) return near.baseId;
  return (await storage.createDetectedRegionLocation(candidate)).baseId;
}

// ==================== ORCHESTRATOR ====================
// Ties detection + the hysteresis state machine + catalog resolution + storage
// application together. Called at agent registration (immediate=true) and on
// periodic re-checks (immediate=false).

export async function runAgentLocationCheck(opts: {
  agent: { id: number; region: string | null; siteId: string | null; pendingRegion: string | null; pendingRegionCount: number };
  token: { id: number; dispatchTier: string };
  ip: string | undefined;
  immediate: boolean;
  /** Injected in tests; live loaders otherwise. */
  deps?: DetectionDeps;
}): Promise<{ region: string | null; siteId: string | null; locationTrust: LocationTrust }> {
  const deps = opts.deps ?? liveDeps();
  const det = detectLocation(opts.ip ?? "", deps);
  const now = new Date();

  // Public tier: configured identity is trusted; detection is observability
  // only. Same for a result capped only because the VPN/datacenter data
  // hasn't loaded (first boot on an ephemeral filesystem, downloads failing):
  // detection can't tell, so it must not move the region either way —
  // clearing it would drop the siteId (a new sequence number on recovery) and
  // rewrite shared listings on every deploy. Stored region, siteId and pending
  // state are kept; an agent with no region stays Unverified (still fail
  // closed). Unambiguous outcomes — a Tor exit, private IP, no geo — still go
  // through the transition below and fast-distrust as always.
  if (opts.token.dispatchTier === "public" || det.capped) {
    await storage.updateEvalAgentLocationObservability(opts.agent.id, {
      locationTrust: det.trust, locationCheckedAt: now, locationSource: det.source,
    });
    return { region: opts.agent.region, siteId: opts.agent.siteId, locationTrust: det.trust };
  }

  const baseId = det.candidate ? await resolveCatalogRegion(det.candidate) : null;
  const next = decideLocationTransition(opts.agent, { trust: det.trust, baseId }, { immediate: opts.immediate });
  let siteId = opts.agent.siteId;
  if (next.changed) {
    siteId = next.region ? await storage.allocateSiteId(next.region) : null;
  }
  await storage.updateEvalAgentLocation(opts.agent.id, {
    region: next.region, siteId, locationTrust: det.trust,
    locationCheckedAt: now, locationSource: det.source,
    pendingRegion: next.pendingRegion, pendingRegionCount: next.pendingRegionCount,
  });
  if (next.changed && opts.token.dispatchTier === "shared") {
    // Shared listings advertise the agent's siteId; keep the plugin in sync.
    // The Plugin/Core boundary is duck-typed by design (server/index.ts casts
    // the registered service to EvalMarketplace unchecked) — a plugin build
    // that hasn't shipped this method yet must never 500 Core; warn once and
    // move on instead of throwing.
    const marketplace = getMarketplace();
    if (marketplace && typeof marketplace.updateListingRegion === "function") {
      await marketplace.updateListingRegion(opts.token.id, siteId);
    } else if (marketplace) {
      console.warn(`[location] marketplace plugin lacks updateListingRegion — listing region not refreshed for token ${opts.token.id}`);
    }
  }
  return { region: next.region, siteId, locationTrust: det.trust };
}
