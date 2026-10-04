import { beforeEach, describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { GEOIP_ATTRIBUTIONS } from "../shared/geoip-attribution";
import { getGeoipAttribution, reloadGeoReaders } from "../server/location";

vi.mock("fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("fs")>(),
  readFileSync: vi.fn(),
}));
const { openDatabase } = vi.hoisted(() => ({ openDatabase: vi.fn() }));
vi.mock("maxmind", () => ({ open: openDatabase }));
vi.mock("../server/storage", () => ({ storage: {} }));
vi.mock("../server/geoip-refresh", () => ({ refreshGeoipDatabases: vi.fn() }));

function setMetadata(contents: string | Error): void {
  vi.mocked(readFileSync).mockImplementation((file) => {
    if (path.basename(String(file)) !== "geoip-meta.json") throw new Error("Unexpected file read");
    if (contents instanceof Error) throw contents;
    return contents;
  });
}

describe("loaded GeoIP source attribution", () => {
  beforeEach(() => {
    openDatabase.mockReset().mockResolvedValue({});
    vi.mocked(readFileSync).mockReset();
  });

  it.each(["dbip", "geolite2"] as const)("provides the required %s notice", async (source) => {
    setMetadata(JSON.stringify({ source }));
    await reloadGeoReaders();
    expect(getGeoipAttribution()).toBe(GEOIP_ATTRIBUTIONS[source].attribution);
  });

  it("updates the notice when the loaded source changes", async () => {
    for (const source of ["geolite2", "dbip"] as const) {
      setMetadata(JSON.stringify({ source }));
      await reloadGeoReaders();
      expect(getGeoipAttribution()).toBe(GEOIP_ATTRIBUTIONS[source].attribution);
    }
  });

  it.each([undefined, "unknown", "constructor", "__proto__"])("does not attribute an unsupported source: %s", async (source) => {
    setMetadata(JSON.stringify({ source }));
    await reloadGeoReaders();
    expect(getGeoipAttribution()).toBeNull();
  });

  it.each(["missing", "malformed"])("clears the previous notice when metadata is %s", async (state) => {
    setMetadata(JSON.stringify({ source: "geolite2" }));
    await reloadGeoReaders();
    if (state === "missing") {
      setMetadata(new Error("ENOENT"));
    } else {
      setMetadata("invalid JSON");
    }
    await reloadGeoReaders();
    expect(getGeoipAttribution()).toBeNull();
  });

  it.each([
    ["GeoLite2-City", "geolite2"], ["GeoLite2-ASN", "geolite2"],
    ["DBIP-City-Lite", "dbip"], ["DBIP-ASN-Lite", "dbip"],
  ] as const)("identifies %s without a metadata file", async (databaseType, source) => {
    openDatabase.mockResolvedValue({ metadata: { databaseType } });
    setMetadata(new Error("ENOENT"));
    await reloadGeoReaders();
    expect(getGeoipAttribution()).toBe(GEOIP_ATTRIBUTIONS[source].attribution);
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it.each(["GeoLite2-City.mmdb", "GeoLite2-ASN.mmdb"])("attributes a loaded legacy %s when refresh metadata is absent", async (legacyName) => {
    openDatabase.mockImplementation(async (file: string) => {
      if (path.basename(file) === legacyName) return {};
      throw new Error("ENOENT");
    });
    setMetadata(new Error("ENOENT"));
    await reloadGeoReaders();
    expect(getGeoipAttribution()).toBe(GEOIP_ATTRIBUTIONS.geolite2.attribution);
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("prefers the loaded database header to stale refresh metadata", async () => {
    openDatabase.mockResolvedValue({ metadata: { databaseType: "DBIP-City-Lite" } });
    setMetadata(JSON.stringify({ source: "geolite2" }));
    await reloadGeoReaders();
    expect(getGeoipAttribution()).toBe(GEOIP_ATTRIBUTIONS.dbip.attribution);
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("does not attribute data that failed to load", async () => {
    openDatabase.mockRejectedValue(new Error("ENOENT"));
    setMetadata(JSON.stringify({ source: "geolite2" }));
    await reloadGeoReaders();
    expect(getGeoipAttribution()).toBeNull();
  });

  it("credits both providers when manually installed readers have different sources", async () => {
    openDatabase.mockImplementation(async (file: string) => ({
      metadata: { databaseType: path.basename(file) === "City.mmdb" ? "DBIP-City-Lite" : "GeoLite2-ASN" },
    }));
    await reloadGeoReaders();
    expect(getGeoipAttribution()).toContain(GEOIP_ATTRIBUTIONS.dbip.attribution);
    expect(getGeoipAttribution()).toContain(GEOIP_ATTRIBUTIONS.geolite2.attribution);
  });

  it.each([
    ["GeoLite2-City", "dbip"], ["DBIP-City-Lite", "geolite2"],
  ] as const)("applies refresh metadata to an unresolved reader beside %s", async (databaseType, source) => {
    openDatabase.mockImplementation(async (file: string) => ({
      metadata: { databaseType: path.basename(file) === "City.mmdb" ? databaseType : "Unrecognized-ASN" },
    }));
    setMetadata(JSON.stringify({ source }));
    await reloadGeoReaders();
    expect(getGeoipAttribution()).toContain(GEOIP_ATTRIBUTIONS.dbip.attribution);
    expect(getGeoipAttribution()).toContain(GEOIP_ATTRIBUTIONS.geolite2.attribution);
    expect(readFileSync).toHaveBeenCalled();
  });
});
