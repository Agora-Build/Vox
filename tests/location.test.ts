import { describe, it, expect } from "vitest";
import {
  isPublicIp, classifyLocation, slugCity, macroForContinent, deriveRegionCandidate,
  haversineKm, decideLocationTransition, REGION_CHANGE_STABILITY,
  type LocationSignals, type GeoLookup,
} from "../server/location";

const geoMumbai: GeoLookup = {
  city: "Mumbai", countryCode: "IN", countryName: "India", continentCode: "AS",
  lat: 19.076, lon: 72.877, accuracyKm: 20,
};
const signals = (over: Partial<LocationSignals> = {}): LocationSignals => ({
  geo: geoMumbai, asn: { asn: 55836, org: "Reliance Jio" }, isTorExit: false, asnClass: null, ...over,
});

describe("isPublicIp", () => {
  it.each([
    ["10.1.2.3", false], ["172.16.0.1", false], ["192.168.5.140", false],
    ["127.0.0.1", false], ["169.254.1.1", false], ["100.64.0.1", false],
    ["::1", false], ["fc00::1", false], ["fe80::1", false],
    ["8.8.8.8", true], ["49.36.100.1", true], ["2001:4860:4860::8888", true],
    ["not-an-ip", false], ["", false],
  ])("%s → %s", (ip, expected) => expect(isPublicIp(ip)).toBe(expected));
});

describe("classifyLocation trust ladder (first match wins)", () => {
  it("private IP → unknown, no candidate", () => {
    const d = classifyLocation("192.168.1.1", signals());
    expect(d.trust).toBe("unknown");
    expect(d.candidate).toBeNull();
  });
  it("Tor exit → anonymized even with clean geo", () => {
    expect(classifyLocation("49.36.100.1", signals({ isTorExit: true })).trust).toBe("anonymized");
  });
  it("vpn ASN → anonymized", () => {
    expect(classifyLocation("49.36.100.1", signals({ asnClass: "vpn" })).trust).toBe("anonymized");
  });
  it("geo miss → low_confidence", () => {
    expect(classifyLocation("49.36.100.1", signals({ geo: null })).trust).toBe("low_confidence");
  });
  it("no city → low_confidence", () => {
    expect(classifyLocation("49.36.100.1", signals({ geo: { ...geoMumbai, city: undefined } })).trust).toBe("low_confidence");
  });
  it("accuracy radius > 100km → low_confidence", () => {
    expect(classifyLocation("49.36.100.1", signals({ geo: { ...geoMumbai, accuracyKm: 500 } })).trust).toBe("low_confidence");
  });
  it("hosting ASN → datacenter WITH a candidate (location trusted)", () => {
    const d = classifyLocation("3.6.100.1", signals({ asnClass: "hosting" }));
    expect(d.trust).toBe("datacenter");
    expect(d.candidate?.baseId).toBe("apac-in-mumbai");
  });
  it("clean residential → trusted with candidate", () => {
    const d = classifyLocation("49.36.100.1", signals());
    expect(d.trust).toBe("trusted");
    expect(d.candidate).toMatchObject({ baseId: "apac-in-mumbai", macroRegionCode: "apac", countryCode: "IN" });
  });
  it("anonymized/low_confidence/unknown never carry a candidate", () => {
    for (const d of [
      classifyLocation("49.36.100.1", signals({ isTorExit: true })),
      classifyLocation("49.36.100.1", signals({ geo: null })),
      classifyLocation("10.0.0.1", signals()),
    ]) expect(d.candidate).toBeNull();
  });
  it("source never contains the raw signals objects, only scalars + signal names", () => {
    const d = classifyLocation("49.36.100.1", signals());
    expect(d.source).toEqual({
      city: "Mumbai", countryCode: "IN", lat: 19.076, lon: 72.877,
      accuracyKm: 20, asn: 55836, asnOrg: "Reliance Jio", signals: [],
    });
  });
});

describe("baseId derivation", () => {
  it("slugCity lowercases, folds accents, strips non-alphanumerics", () => {
    expect(slugCity("Santa Clara")).toBe("santaclara");
    expect(slugCity("São Paulo")).toBe("saopaulo");
    expect(slugCity("Frankfurt am Main")).toBe("frankfurtammain");
  });
  it("macroForContinent maps per spec", () => {
    expect(macroForContinent("NA")).toEqual({ code: "na", name: "North America" });
    expect(macroForContinent("SA")).toEqual({ code: "sa", name: "South America" });
    expect(macroForContinent("EU")).toEqual({ code: "eu", name: "Europe" });
    expect(macroForContinent("AS")).toEqual({ code: "apac", name: "Asia Pacific" });
    expect(macroForContinent("OC")).toEqual({ code: "apac", name: "Asia Pacific" });
    expect(macroForContinent("AF")).toEqual({ code: "af", name: "Africa" });
    expect(macroForContinent("AN")).toBeNull();
  });
  it("deriveRegionCandidate builds <macro>-<cc>-<cityslug>", () => {
    expect(deriveRegionCandidate({
      city: "Santa Clara", countryCode: "US", countryName: "United States",
      continentCode: "NA", lat: 37.35, lon: -121.95, accuracyKm: 10,
    })).toMatchObject({ baseId: "na-us-santaclara", displayName: "Santa Clara", macroRegionCode: "na" });
  });
  it("deriveRegionCandidate → null for Antarctica or missing fields", () => {
    expect(deriveRegionCandidate({ ...geoMumbai, continentCode: "AN" })).toBeNull();
    expect(deriveRegionCandidate({ ...geoMumbai, lat: undefined })).toBeNull();
  });
});

describe("haversineKm", () => {
  it("Seattle→Frankfurt ≈ 8ooo+ km; Sunnyvale→Santa Clara < 15 km", () => {
    expect(haversineKm(47.6062, -122.3321, 50.1109, 8.6821)).toBeGreaterThan(8000);
    expect(haversineKm(37.3688, -122.0363, 37.3541, -121.9552)).toBeLessThan(15);
  });
});

describe("decideLocationTransition", () => {
  const fresh = { region: null, pendingRegion: null, pendingRegionCount: 0 };
  const inMumbai = { region: "apac-in-mumbai", pendingRegion: null, pendingRegionCount: 0 };

  it("eligible + immediate (registration) assigns at once", () => {
    expect(decideLocationTransition(fresh, { trust: "trusted", baseId: "apac-in-mumbai" }, { immediate: true }))
      .toEqual({ region: "apac-in-mumbai", changed: true, pendingRegion: null, pendingRegionCount: 0 });
  });
  it("same region observed again → keep, pending cleared", () => {
    expect(decideLocationTransition(
      { ...inMumbai, pendingRegion: "eu-de-frankfurt", pendingRegionCount: 2 },
      { trust: "trusted", baseId: "apac-in-mumbai" }, { immediate: false },
    )).toEqual({ region: "apac-in-mumbai", changed: false, pendingRegion: null, pendingRegionCount: 0 });
  });
  it("region change on heartbeat: pends 1, 2, applies at 3", () => {
    const det = { trust: "trusted" as const, baseId: "eu-de-frankfurt" };
    const s1 = decideLocationTransition(inMumbai, det, { immediate: false });
    expect(s1).toEqual({ region: "apac-in-mumbai", changed: false, pendingRegion: "eu-de-frankfurt", pendingRegionCount: 1 });
    const s2 = decideLocationTransition({ ...inMumbai, pendingRegion: s1.pendingRegion, pendingRegionCount: s1.pendingRegionCount }, det, { immediate: false });
    expect(s2.pendingRegionCount).toBe(2);
    expect(s2.changed).toBe(false);
    const s3 = decideLocationTransition({ ...inMumbai, pendingRegion: s2.pendingRegion, pendingRegionCount: s2.pendingRegionCount }, det, { immediate: false });
    expect(s3).toEqual({ region: "eu-de-frankfurt", changed: true, pendingRegion: null, pendingRegionCount: 0 });
    expect(REGION_CHANGE_STABILITY).toBe(3);
  });
  it("a differing observation resets the pending counter", () => {
    const s = decideLocationTransition(
      { ...inMumbai, pendingRegion: "eu-de-frankfurt", pendingRegionCount: 2 },
      { trust: "trusted", baseId: "na-us-seattle" }, { immediate: false },
    );
    expect(s).toEqual({ region: "apac-in-mumbai", changed: false, pendingRegion: "na-us-seattle", pendingRegionCount: 1 });
  });
  it("trust drop clears region IMMEDIATELY, even mid-pending", () => {
    expect(decideLocationTransition(
      { ...inMumbai, pendingRegion: "eu-de-frankfurt", pendingRegionCount: 2 },
      { trust: "anonymized", baseId: null }, { immediate: false },
    )).toEqual({ region: null, changed: true, pendingRegion: null, pendingRegionCount: 0 });
  });
  it("still-Unverified stays put without churn", () => {
    expect(decideLocationTransition(fresh, { trust: "unknown", baseId: null }, { immediate: false }))
      .toEqual({ region: null, changed: false, pendingRegion: null, pendingRegionCount: 0 });
  });
  it("upgrade from Unverified on heartbeat also uses hysteresis", () => {
    const s = decideLocationTransition(fresh, { trust: "trusted", baseId: "apac-in-mumbai" }, { immediate: false });
    expect(s).toEqual({ region: null, changed: false, pendingRegion: "apac-in-mumbai", pendingRegionCount: 1 });
  });
});
