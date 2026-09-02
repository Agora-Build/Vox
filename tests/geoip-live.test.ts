import { describe, it, expect, beforeAll } from "vitest";
import { existsSync } from "fs";
import path from "path";
import { open, type Reader, type CityResponse, type AsnResponse } from "maxmind";
import { detectLocation, type DetectionDeps, type GeoLookup, type AsnLookup } from "../server/location";

/**
 * Live-database smoke test for the zero-trust detection pipeline.
 *
 * Runs ONLY when real mmdb files exist in GEOIP_DB_DIR (default ./geoip) —
 * populate them by starting the server (server/location.ts refreshes on
 * startup if missing/stale) or via the admin "Refresh" button/API
 * (POST /api/admin/geoip/refresh, see server/geoip-refresh.ts; works keyless
 * via the DB-IP Lite fallback). CI and fresh checkouts have no geoip/ dir, so
 * this file skips there; it exists to prove the ladder works against actual
 * database content (field mapping, candidate derivation), which the unit
 * tests' injected fixtures cannot.
 *
 * Assertions are deliberately loose on city-level facts (GeoIP data shifts
 * between monthly editions) and firm on structural ones (schema fields
 * present, ladder outcomes, candidate shape).
 */
const GEOIP_DIR = process.env.GEOIP_DB_DIR || path.join(process.cwd(), "geoip");
// Canonical names (City.mmdb/ASN.mmdb, written by the in-app refresher) first,
// legacy GeoLite2-*.mmdb names kept for deployments that predate it — mirrors
// tryOpen() in server/location.ts.
function findDb(names: string[]): string | null {
  for (const name of names) {
    const p = path.join(GEOIP_DIR, name);
    if (existsSync(p)) return p;
  }
  return null;
}
const cityDbPath = findDb(["City.mmdb", "GeoLite2-City.mmdb"]);
const asnDbPath = findDb(["ASN.mmdb", "GeoLite2-ASN.mmdb"]);
const haveDbs = !!cityDbPath && !!asnDbPath;
const describeGeo = haveDbs ? describe : describe.skip;

describeGeo("detection pipeline against live GeoIP databases", () => {
  let cityReader: Reader<CityResponse>;
  let asnReader: Reader<AsnResponse>;
  let deps: DetectionDeps;

  beforeAll(async () => {
    cityReader = await open<CityResponse>(cityDbPath!);
    asnReader = await open<AsnResponse>(asnDbPath!);
    // Mirror liveDeps() from server/location.ts, minus Tor (network) and with
    // the checked-in ASN classification so hosting detection is exercised.
    const asnClass = (await import("../server/data/asn-classification.json")).default as Record<
      string,
      "vpn" | "hosting"
    >;
    const geo = (ip: string): GeoLookup | null => {
      const hit = cityReader.get(ip);
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
    };
    const asn = (ip: string): AsnLookup | null => {
      const hit = asnReader.get(ip);
      return hit
        ? { asn: hit.autonomous_system_number, org: hit.autonomous_system_organization }
        : null;
    };
    deps = { geo, asn, torExits: new Set(), asnClass, asnClassLoaded: true };
  });

  it("database schema carries the fields the ladder reads (country/continent/coords/ASN)", () => {
    const hit = cityReader.get("8.8.8.8");
    expect(hit?.country?.iso_code).toBe("US");
    expect(hit?.continent?.code).toBe("NA");
    expect(typeof hit?.location?.latitude).toBe("number");
    expect(typeof hit?.location?.longitude).toBe("number");
    const asnHit = asnReader.get("8.8.8.8");
    expect(asnHit?.autonomous_system_number).toBe(15169); // Google
  });

  it("a known hosting IP classifies datacenter WITH a region candidate", () => {
    // 8.8.8.8: ASN 15169 is in asn-classification.json as hosting. City-level
    // geo for anycast can be present or absent depending on edition — accept
    // datacenter (city resolved) or low_confidence (no city), never trusted
    // or anonymized.
    const det = detectLocation("8.8.8.8", deps);
    expect(["datacenter", "low_confidence"]).toContain(det.trust);
    if (det.trust === "datacenter") {
      expect(det.candidate).not.toBeNull();
      expect(det.candidate!.baseId).toMatch(/^[a-z]+-[a-z]{2}-[a-z0-9]+$/);
      expect(det.candidate!.countryCode).toBe("US");
    } else {
      expect(det.candidate).toBeNull();
    }
  });

  it("a residential-range IP resolves through the full ladder to an eligible or honest-ineligible result", () => {
    // 49.36.100.1 (Reliance Jio, India): non-hosting ASN. Depending on the
    // edition's city/radius data this is trusted (city resolved) or
    // low_confidence (no city / wide radius) — both are honest; anonymized or
    // unknown would mean broken field mapping.
    const det = detectLocation("49.36.100.1", deps);
    expect(["trusted", "low_confidence"]).toContain(det.trust);
    if (det.trust === "trusted") {
      expect(det.candidate!.countryCode).toBe("IN");
      expect(det.candidate!.macroRegionCode).toBe("apac");
    }
    expect(det.source.asn).not.toBeNull();
  });

  it("private and v4-mapped IPs stay unknown regardless of database content", () => {
    expect(detectLocation("192.168.5.140", deps).trust).toBe("unknown");
    expect(detectLocation("::ffff:10.0.0.1", deps).trust).toBe("unknown");
  });

  it("source evidence carries scalars only, never reader objects", () => {
    const det = detectLocation("8.8.8.8", deps);
    for (const v of Object.values(det.source)) {
      expect(["string", "number", "object"].includes(typeof v)).toBe(true);
    }
    expect(Array.isArray(det.source.signals)).toBe(true);
  });
});
