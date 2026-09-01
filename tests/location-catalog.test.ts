import { describe, it, expect, afterAll } from "vitest";
import { like } from "drizzle-orm";
import { storage, db } from "../server/storage";
import { regionLocations } from "../shared/schema";
import { resolveCatalogRegion } from "../server/location";

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb("catalog resolution", () => {
  afterAll(async () => {
    await db.delete(regionLocations).where(like(regionLocations.baseId, "zz-%"));
  });

  it("findNearestActiveRegion matches within 100km (Sunnyvale → Santa Clara/Seattle rule)", async () => {
    // Seeded Seattle row has coords from migration 0035.
    const near = await storage.findNearestActiveRegion(47.61, -122.20, 100); // ~10km east of Seattle
    expect(near?.baseId).toBe("na-us-seattle");
    const far = await storage.findNearestActiveRegion(64.14, -21.94, 100); // Reykjavik
    expect(far).toBeUndefined();
  });

  it("resolveCatalogRegion reuses a near row; auto-creates source='detected' otherwise", async () => {
    const nearSeattle = await resolveCatalogRegion({
      baseId: "na-us-bellevue", displayName: "Bellevue", city: "Bellevue",
      countryCode: "US", countryName: "United States",
      macroRegionCode: "na", macroRegionName: "North America",
      latitude: 47.61, longitude: -122.20,
    });
    expect(nearSeattle).toBe("na-us-seattle");

    const created = await resolveCatalogRegion({
      baseId: "zz-is-reykjavik", displayName: "Reykjavik", city: "Reykjavik",
      countryCode: "IS", countryName: "Iceland",
      macroRegionCode: "eu", macroRegionName: "Europe",
      latitude: 64.14, longitude: -21.94,
    });
    expect(created).toBe("zz-is-reykjavik");
    const row = await storage.getRegionLocationByBaseId("zz-is-reykjavik");
    expect(row?.source).toBe("detected");
    expect(row?.isMainline).toBe(false);
    // Idempotent on second call (unique base_id, 23505 → re-select).
    expect(await resolveCatalogRegion({
      baseId: "zz-is-reykjavik", displayName: "Reykjavik", city: "Reykjavik",
      countryCode: "IS", countryName: "Iceland",
      macroRegionCode: "eu", macroRegionName: "Europe",
      latitude: 64.14, longitude: -21.94,
    })).toBe("zz-is-reykjavik");
  });
});
