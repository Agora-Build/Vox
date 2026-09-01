import { REGION_ELIGIBLE_TRUST, type LocationTrust } from "@shared/schema";
import { open as maxmindOpen, type Reader, type CityResponse, type AsnResponse } from "maxmind";
import { readFileSync } from "fs";
import path from "path";
import { storage } from "./storage";
import { getMarketplace } from "./marketplace";
import type { RegionCandidate } from "@shared/regions";

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
  asnClass: "vpn" | "hosting" | null;
}
export interface Detection {
  trust: LocationTrust;
  candidate: RegionCandidate | null; // non-null iff trust is region-eligible
  source: {
    city: string | null; countryCode: string | null;
    lat: number | null; lon: number | null; accuracyKm: number | null;
    asn: number | null; asnOrg: string | null; signals: string[];
  };
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
export const LOCATION_RECHECK_HOURS = 24;

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

export function isPublicIp(ip: string): boolean {
  if (!ip) return false;
  const bare = ip.startsWith("::ffff:") ? ip.slice(7) : ip; // v4-mapped v6
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
      ...(signals.asnClass ? [`asn:${signals.asnClass}`] : []),
    ],
  };
  const done = (trust: LocationTrust, candidate: RegionCandidate | null = null): Detection =>
    ({ trust, candidate, source });

  // Ladder — first match wins (spec: detection pipeline).
  if (!isPublicIp(ip)) return done("unknown");
  if (signals.isTorExit || signals.asnClass === "vpn") return done("anonymized");
  if (!signals.geo || !signals.geo.city
    || (signals.geo.accuracyKm !== undefined && signals.geo.accuracyKm > MAX_CITY_ACCURACY_KM)) {
    return done("low_confidence");
  }
  const candidate = deriveRegionCandidate(signals.geo);
  if (!candidate) return done("low_confidence");
  if (signals.asnClass === "hosting") return done("datacenter", candidate);
  return done("trusted", candidate);
}

export function decideLocationTransition(
  agent: { region: string | null; pendingRegion: string | null; pendingRegionCount: number },
  det: { trust: LocationTrust; baseId: string | null },
  opts: { immediate: boolean },
): LocationNextState {
  const eligible = REGION_ELIGIBLE_TRUST.includes(det.trust) && det.baseId !== null;
  if (!eligible) {
    // Distrust fast: clear at once; pending state is meaningless now.
    return { region: null, changed: agent.region !== null, pendingRegion: null, pendingRegionCount: 0 };
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
  asnClass: Readonly<Record<string, "vpn" | "hosting">>;
}

const GEOIP_DIR = process.env.GEOIP_DB_DIR || path.join(process.cwd(), "geoip");
let cityReader: Reader<CityResponse> | null = null;
let asnReader: Reader<AsnResponse> | null = null;
let torExits: Set<string> = new Set();
let asnClassification: Record<string, "vpn" | "hosting"> = {};
let warnedPrivateIp = false;

export function startLocationServices(): void {
  void (async () => {
    try { cityReader = await maxmindOpen<CityResponse>(path.join(GEOIP_DIR, "GeoLite2-City.mmdb")); }
    catch { console.log("[location] GeoLite2-City.mmdb not found — geolocation disabled (all agents Unverified)"); }
    try { asnReader = await maxmindOpen<AsnResponse>(path.join(GEOIP_DIR, "GeoLite2-ASN.mmdb")); }
    catch { console.log("[location] GeoLite2-ASN.mmdb not found — ASN signals disabled"); }
  })();
  try {
    asnClassification = JSON.parse(readFileSync(path.join(process.cwd(), "server/data/asn-classification.json"), "utf8"));
    delete (asnClassification as Record<string, unknown>)._comment;
  } catch { console.log("[location] asn-classification.json not readable — ASN class signals disabled"); }
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

function liveDeps(): DetectionDeps {
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
    asnClass: asnClassification,
  };
}

export function detectLocation(ip: string, deps: DetectionDeps = liveDeps()): Detection {
  if (!isPublicIp(ip)) {
    // Deployment tripwire (spec): a private IP in production means the proxy
    // hop count is likely wrong — every agent would geolocate to nothing.
    if (process.env.NODE_ENV === "production" && !warnedPrivateIp) {
      warnedPrivateIp = true;
      console.warn(`[location] observed a private client IP (${ip}) in production — trust-proxy hop count likely misconfigured; agents will stay Unverified`);
    }
    return classifyLocation(ip, { geo: null, asn: null, isTorExit: false, asnClass: null });
  }
  const asnInfo = deps.asn(ip);
  return classifyLocation(ip, {
    geo: deps.geo(ip),
    asn: asnInfo,
    isTorExit: deps.torExits.has(ip),
    asnClass: asnInfo?.asn !== undefined ? deps.asnClass[String(asnInfo.asn)] ?? null : null,
  });
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
}): Promise<{ region: string | null; siteId: string | null; locationTrust: LocationTrust }> {
  const det = detectLocation(opts.ip ?? "");
  const now = new Date();

  if (opts.token.dispatchTier === "public") {
    // Configured identity is trusted; detection is observability only.
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
    const marketplace = getMarketplace();
    if (marketplace) await marketplace.updateListingRegion(opts.token.id, siteId);
  }
  return { region: next.region, siteId, locationTrust: det.trust };
}
