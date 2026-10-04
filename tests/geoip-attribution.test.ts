import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { GEOIP_ATTRIBUTIONS } from "../shared/geoip-attribution";
import { getGeoipAttribution, reloadGeoReaders } from "../server/location";

vi.mock("fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("fs")>(),
  readFileSync: vi.fn(),
}));
vi.mock("maxmind", () => ({ open: vi.fn().mockResolvedValue({}) }));
vi.mock("../server/storage", () => ({ storage: {} }));
vi.mock("../server/geoip-refresh", () => ({ refreshGeoipDatabases: vi.fn() }));

describe("loaded GeoIP source attribution", () => {
  it.each(["dbip", "geolite2"] as const)("provides the required %s notice", async (source) => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ source }));
    await reloadGeoReaders();
    expect(getGeoipAttribution()).toBe(GEOIP_ATTRIBUTIONS[source].attribution);
  });

  it("updates the notice when the loaded source changes", async () => {
    for (const source of ["geolite2", "dbip"] as const) {
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ source }));
      await reloadGeoReaders();
      expect(getGeoipAttribution()).toBe(GEOIP_ATTRIBUTIONS[source].attribution);
    }
  });

  it.each([undefined, "unknown", "constructor", "__proto__"])("does not attribute an unsupported source: %s", async (source) => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ source }));
    await reloadGeoReaders();
    expect(getGeoipAttribution()).toBeNull();
  });

  it.each(["missing", "malformed"])("clears the previous notice when metadata is %s", async (state) => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ source: "geolite2" }));
    await reloadGeoReaders();
    if (state === "missing") {
      vi.mocked(readFileSync).mockImplementation(() => { throw new Error("ENOENT"); });
    } else {
      vi.mocked(readFileSync).mockReturnValue("invalid JSON");
    }
    await reloadGeoReaders();
    expect(getGeoipAttribution()).toBeNull();
  });
});
