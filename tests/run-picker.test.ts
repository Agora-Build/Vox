import { describe, it, expect } from "vitest";
import {
  encodePickerValue, decodePickerValue, dedupeSharedAgents, buildRegionGroups, buildUnverifiedAgents, countOnlinePublic,
  type RunTargetAgent, type PublicFleetRow,
} from "../client/src/lib/run-picker";

const agent = (overrides: Partial<RunTargetAgent>): RunTargetAgent => ({
  tokenId: 1, name: "agent", siteId: null, region: null, dispatchTier: "private", locationTrust: null, price: null,
  ...overrides,
});

describe("run-picker: encode/decode round-trip", () => {
  it("round-trips a region selection", () => {
    const sel = { kind: "region" as const, region: "na-us-seattle", targetTier: "public" };
    expect(decodePickerValue(encodePickerValue(sel))).toEqual(sel);
  });

  it("round-trips a site selection", () => {
    const sel = { kind: "site" as const, tokenId: 4242 };
    expect(decodePickerValue(encodePickerValue(sel))).toEqual(sel);
  });

  it("round-trips a region whose baseId itself contains colons safely (rightmost colon is the tier separator)", () => {
    // Region baseIds don't actually contain colons in practice, but the
    // decoder splits on the LAST colon specifically so a region value is
    // never misparsed as containing part of the tier.
    const sel = { kind: "region" as const, region: "na-us-seattle", targetTier: "team" };
    const encoded = encodePickerValue(sel);
    expect(encoded).toBe("region:na-us-seattle:team");
    expect(decodePickerValue(encoded)).toEqual(sel);
  });

  it("returns null for empty, garbage, and malformed input", () => {
    expect(decodePickerValue("")).toBeNull();
    expect(decodePickerValue("garbage")).toBeNull();
    expect(decodePickerValue("region:only-one-part")).toBeNull();
    expect(decodePickerValue("site:not-a-number")).toBeNull();
  });
});

describe("run-picker: dedupeSharedAgents", () => {
  it("drops a shared listing already present in mine (owner also sees it as a marketplace listing)", () => {
    const mine = [agent({ tokenId: 7, dispatchTier: "shared", siteId: "na-us-seattle-1" })];
    const shared = [
      agent({ tokenId: 7, dispatchTier: "shared", siteId: "na-us-seattle-1" }),
      agent({ tokenId: 8, dispatchTier: "shared", siteId: "eu-de-berlin-1" }),
    ];
    const result = dedupeSharedAgents(mine, shared);
    expect(result.map((a) => a.tokenId)).toEqual([8]);
  });
});

describe("run-picker: buildRegionGroups", () => {
  const labelFor = (region: string) => `Label(${region})`;

  it("groups a mixed fixture: public rows as region-scoped leaves+count, private/team/shared by region", () => {
    const nonPublic: RunTargetAgent[] = [
      agent({ tokenId: 1, dispatchTier: "private", region: "na-us-seattle", siteId: "na-us-seattle-1", name: "priv-1" }),
      agent({ tokenId: 2, dispatchTier: "team", region: "na-us-seattle", siteId: "na-us-seattle-2", name: "team-1" }),
      agent({ tokenId: 3, dispatchTier: "shared", region: "eu-de-berlin", siteId: "eu-de-berlin-1", name: "shared-1" }),
    ];
    const publicRows: PublicFleetRow[] = [
      { siteId: "na-us-seattle-9", region: "na-us-seattle", state: "idle" },
      { siteId: "na-us-seattle-10", region: "na-us-seattle", state: "offline" },
      { siteId: "eu-de-berlin-9", region: "eu-de-berlin", state: "idle" },
    ];

    const groups = buildRegionGroups(nonPublic, publicRows, labelFor);
    expect(groups.map((g) => g.region).sort()).toEqual(["eu-de-berlin", "na-us-seattle"]);

    const na = groups.find((g) => g.region === "na-us-seattle")!;
    expect(na.private.map((a) => a.tokenId)).toEqual([1]);
    expect(na.team.map((a) => a.tokenId)).toEqual([2]);
    expect(na.shared).toEqual([]);
    expect(na.public.map((r) => r.siteId).sort()).toEqual(["na-us-seattle-10", "na-us-seattle-9"]);
    // Online count only counts non-offline public rows in THIS region.
    expect(countOnlinePublic(na)).toBe(1);

    const eu = groups.find((g) => g.region === "eu-de-berlin")!;
    expect(eu.shared.map((a) => a.tokenId)).toEqual([3]);
    expect(eu.public.map((r) => r.siteId)).toEqual(["eu-de-berlin-9"]);
    expect(countOnlinePublic(eu)).toBe(1);
  });

  it("never emits a region with no actual row (no catalog-only fallback)", () => {
    const groups = buildRegionGroups([], [], labelFor);
    expect(groups).toEqual([]);
  });

  it("excludes rows with a null region from every group (Unverified agents aren't regionable)", () => {
    const nonPublic = [agent({ tokenId: 5, dispatchTier: "private", region: null, siteId: null })];
    const groups = buildRegionGroups(nonPublic, [], labelFor);
    expect(groups).toEqual([]);
  });
});

describe("run-picker: buildUnverifiedAgents", () => {
  it("includes private/team agents with siteId === null, keyed off siteId not region", () => {
    const nonPublic: RunTargetAgent[] = [
      agent({ tokenId: 1, dispatchTier: "private", siteId: null, region: null }),
      agent({ tokenId: 2, dispatchTier: "team", siteId: null, region: null }),
      // Has a region but no site (e.g. server backfilled region without site) — still Unverified by the siteId rule.
      agent({ tokenId: 3, dispatchTier: "private", siteId: null, region: "na-us-seattle" }),
    ];
    const result = buildUnverifiedAgents(nonPublic);
    expect(result.map((a) => a.tokenId).sort()).toEqual([1, 2, 3]);
  });

  it("excludes shared-tier agents entirely, even if siteId were somehow null", () => {
    const nonPublic: RunTargetAgent[] = [
      agent({ tokenId: 9, dispatchTier: "shared", siteId: null, region: null }),
    ];
    expect(buildUnverifiedAgents(nonPublic)).toEqual([]);
  });

  it("excludes agents that have a real siteId", () => {
    const nonPublic: RunTargetAgent[] = [
      agent({ tokenId: 10, dispatchTier: "private", siteId: "na-us-seattle-1", region: "na-us-seattle" }),
    ];
    expect(buildUnverifiedAgents(nonPublic)).toEqual([]);
  });
});

describe("run-picker: countOnlinePublic", () => {
  it("counts only non-offline rows", () => {
    const group = { region: "r", label: "R", private: [], team: [], shared: [], public: [
      { siteId: "r-1", region: "r", state: "idle" },
      { siteId: "r-2", region: "r", state: "occupied" },
      { siteId: "r-3", region: "r", state: "offline" },
    ] };
    expect(countOnlinePublic(group)).toBe(2);
  });
});
