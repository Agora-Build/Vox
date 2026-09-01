import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  appendRegionScopes,
  compressRegionScopeSelection,
  formatRegion,
  formatSite,
  regionOf,
  formatRegionScopeSelection,
  resolveRegionScopeBaseIds,
  toggleRegionScopeSelection,
  toggleUnverifiedScope,
  type RegionLocation,
} from "../client/src/lib/utils";
import { regionSiteSequence } from "../shared/regions";

function location(
  id: number,
  baseId: string,
  displayName: string,
  countryCode: string,
  countryName: string,
  macroRegionCode: string,
  macroRegionName: string,
): RegionLocation {
  return {
    id,
    baseId,
    displayName,
    city: displayName,
    countryCode,
    countryName,
    macroRegionCode,
    macroRegionName,
    nextSequence: 2,
    isActive: true,
    allocatedRegions: [`${baseId}-01`],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const locations = [
  location(1, "apac-sg", "Singapore", "SG", "Singapore", "apac", "Asia Pacific"),
  location(2, "apac-in-mumbai", "Mumbai", "IN", "India", "apac", "Asia Pacific"),
  location(3, "apac-in-bangalore", "Bangalore", "IN", "India", "apac", "Asia Pacific"),
  location(4, "na-us-seattle", "Seattle", "US", "United States", "na", "North America"),
  location(5, "eu-de-frankfurt", "Frankfurt", "DE", "Germany", "eu", "Europe"),
  location(6, "sa-br-saopaulo", "Sao Paulo", "BR", "Brazil", "sa", "South America"),
];

describe("region hierarchy", () => {
  it("accepts only canonical exact site IDs", () => {
    expect(regionSiteSequence("apac-sg-01", "apac-sg")).toBe(1);
    expect(regionSiteSequence("apac-sg-10", "apac-sg")).toBe(10);
    expect(regionSiteSequence("apac-sg-1", "apac-sg")).toBeNull();
    expect(regionSiteSequence("apac-sg-001", "apac-sg")).toBeNull();
    expect(regionSiteSequence("apac-sg-00", "apac-sg")).toBeNull();
  });

  it("formats exact built-in site IDs", () => {
    expect(formatSite("apac-sg-01")).toBe("Singapore 01");
    expect(formatSite("apac-in-mumbai-02")).toBe("Mumbai 02");
    expect(formatSite("eu-de-frankfurt-01")).toBe("Frankfurt 01");
  });

  it("resolves macro-region, country, and city scopes", () => {
    expect(Array.from(resolveRegionScopeBaseIds(locations, ["macro:apac"])).sort()).toEqual([
      "apac-in-bangalore",
      "apac-in-mumbai",
      "apac-sg",
    ]);
    expect(Array.from(resolveRegionScopeBaseIds(locations, ["country:IN"])).sort()).toEqual([
      "apac-in-bangalore",
      "apac-in-mumbai",
    ]);
    expect(Array.from(resolveRegionScopeBaseIds(locations, ["location:apac-in-mumbai"]))).toEqual([
      "apac-in-mumbai",
    ]);
  });

  it("keeps city selections at city level", () => {
    const selected = new Set(["apac-in-mumbai"]);
    expect(compressRegionScopeSelection(locations, selected, ["location:apac-in-mumbai"])).toEqual([
      "location:apac-in-mumbai",
    ]);
  });

  it("selects one branch directly from All", () => {
    expect(toggleRegionScopeSelection(
      locations,
      ["all"],
      ["apac-in-mumbai"],
      "location:apac-in-mumbai",
    )).toEqual(["location:apac-in-mumbai"]);
  });

  it("supports macro-region unions", () => {
    const apac = toggleRegionScopeSelection(
      locations,
      ["all"],
      ["apac-sg", "apac-in-mumbai", "apac-in-bangalore"],
      "macro:apac",
    );
    const apacAndNa = toggleRegionScopeSelection(
      locations,
      apac,
      ["na-us-seattle"],
      "macro:na",
    );
    expect(apacAndNa).toEqual(["macro:na", "macro:apac"]);
    expect(formatRegionScopeSelection(locations, apacAndNa)).toBe("North America + Asia Pacific");
  });

  it("keeps explicit country scopes future-compatible", () => {
    const india = toggleRegionScopeSelection(
      locations,
      ["all"],
      ["apac-in-mumbai", "apac-in-bangalore"],
      "country:IN",
    );
    expect(india).toEqual(["country:IN"]);
    expect(resolveRegionScopeBaseIds(locations, india)).toEqual(
      new Set(["apac-in-mumbai", "apac-in-bangalore"]),
    );
  });

  it("returns to All instead of emitting an empty selection", () => {
    expect(toggleRegionScopeSelection(
      locations,
      ["location:apac-in-mumbai"],
      ["apac-in-mumbai"],
      "location:apac-in-mumbai",
    )).toEqual(["all"]);
  });

  it("serializes multi-select scopes for report APIs", () => {
    const params = new URLSearchParams();
    appendRegionScopes(params, ["macro:apac", "macro:na"]);
    expect(params.get("regionScope")).toBe("macro:apac,macro:na");

    const allParams = new URLSearchParams();
    appendRegionScopes(allParams, ["all"]);
    expect(allParams.has("regionScope")).toBe(false);
  });
});

describe("unverified region scope", () => {
  it("ignores the unverified literal when resolving geographic baseIds", () => {
    expect(resolveRegionScopeBaseIds(locations, ["unverified"])).toEqual(new Set());
    expect(resolveRegionScopeBaseIds(locations, ["location:apac-sg", "unverified"])).toEqual(
      new Set(["apac-sg"]),
    );
  });

  it("toggles unverified alone: All -> Unverified -> All", () => {
    const withUnverified = toggleUnverifiedScope(["all"]);
    expect(withUnverified).toEqual(["unverified"]);
    expect(toggleUnverifiedScope(withUnverified)).toEqual(["all"]);
  });

  it("labels the unverified scope, alone and combined with geography", () => {
    expect(formatRegionScopeSelection(locations, ["unverified"])).toBe("Unverified");
    expect(formatRegionScopeSelection(locations, ["location:apac-sg", "unverified"])).toBe(
      "Singapore + Unverified",
    );
  });

  it("deselecting the last geographic pick while Unverified stays checked yields [\"unverified\"], not [\"all\", \"unverified\"]", () => {
    // Select Unverified from the default "all" state.
    const unverifiedOnly = toggleUnverifiedScope(["all"]);
    expect(unverifiedOnly).toEqual(["unverified"]);

    // Then select one geographic location alongside it.
    const withLocation = toggleRegionScopeSelection(
      locations,
      unverifiedOnly,
      ["apac-sg"],
      "location:apac-sg",
    );
    expect(withLocation).toEqual(["location:apac-sg", "unverified"]);

    // Deselecting that same location must leave Unverified as the sole scope —
    // not fall back to ["all"], which would silently re-include every region
    // while the UI still shows an Unverified-scoped selection.
    const afterDeselect = toggleRegionScopeSelection(
      locations,
      withLocation,
      ["apac-sg"],
      "location:apac-sg",
    );
    expect(afterDeselect).toEqual(["unverified"]);
  });
});

describe("site / region helpers", () => {
  it("regionOf strips the -NN sequence", () => {
    expect(regionOf("na-us-seattle-02")).toBe("na-us-seattle");
    expect(regionOf("apac-in-mumbai-01")).toBe("apac-in-mumbai");
  });
  it("regionOf returns the input unchanged when there is no sequence", () => {
    expect(regionOf("na-us-seattle")).toBe("na-us-seattle");
  });
  it("formatRegion shows the area only", () => {
    expect(formatRegion("apac-sg")).toBe("Singapore");
    expect(formatRegion("eu-de-frankfurt")).toBe("Frankfurt");
  });
  it("formatSite shows area + sequence", () => {
    expect(formatSite("apac-sg-01")).toBe("Singapore 01");
    expect(formatSite("eu-de-frankfurt-01")).toBe("Frankfurt 01");
  });
  it("compose: formatRegion(regionOf(siteId)) yields the area", () => {
    expect(formatRegion(regionOf("na-us-seattle-02"))).toBe("Seattle");
  });
});

describe("region data migration", () => {
  it("migrates every region-bearing table and rejects leftovers", async () => {
    const sql = await readFile(new URL("../migrations/0023_region_locations.sql", import.meta.url), "utf8");
    const tables = [
      "eval_agent_tokens",
      "eval_agents",
      "eval_schedules",
      "eval_jobs",
      "eval_results",
      "clash_events",
      "clash_runner_issued_tokens",
      "clash_runner_pool",
      "clash_schedules",
    ];

    for (const table of tables) {
      expect(sql).toContain(`ALTER TABLE "${table}" ALTER COLUMN "region" TYPE varchar(64)`);
      expect(sql).toContain(`SELECT "region" FROM "${table}"`);
    }

    const mappings = [
      ["na", "na-us-seattle-01"],
      ["apac", "apac-sg-01"],
      ["eu", "eu-de-frankfurt-01"],
      ["sa", "sa-br-saopaulo-01"],
    ];
    for (const [legacy, exact] of mappings) {
      expect(sql).toContain(`WHEN '${legacy}' THEN '${exact}'`);
    }

    expect(sql).toContain("region migration left % broad or unrecognized region values");
    expect(sql).toContain('SET "next_sequence" = greatest');
    expect(sql.indexOf("RAISE EXCEPTION")).toBeLessThan(sql.indexOf('DROP TYPE "region"'));
  });
});
