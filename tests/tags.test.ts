import { describe, it, expect } from "vitest";
import {
  KNOWN_TAG_KEYS, LINK_VALUES, MAX_TAGS, TAG_SUGGESTIONS,
  normalizeTag, parseTags, formatTag, tagEndError, END_TAG_KEYS, UNTAGGED_VALUE,
  ispFromAsn, lineFromCarrier, simFromCarrier, isSatelliteIsp,
  SYSTEM_TAG_KEYS, ACCESS_VALUES,
  effectiveTags, parseTagFilter, parseGroupBy, REGION_GROUP_KEY, explainSystemReason,
  type Tag, type JobTag,
} from "../shared/tags";

// shared/tags.ts is the pure tag model (designs/2026-10-22-network-tags-design.md
// "Tag format" / "Detection" / "Which value a board uses"). Client-safe: no imports.

describe("normalizeTag", () => {
  it("trims, lowercases, and turns inner whitespace into -", () => {
    expect(normalizeTag("Line : Twilio ")).toEqual({ key: "line", value: "twilio" });
    expect(normalizeTag(" ISP : Some  Random ISP ")).toEqual({ key: "isp", value: "some-random-isp" });
    expect(normalizeTag({ key: " Line ", value: " New York " })).toEqual({ key: "line", value: "new-york" });
  });

  it("rejects a string with no colon", () => {
    const r = normalizeTag("twilio");
    expect(r).toHaveProperty("error");
  });

  it("rejects an invalid key (must start with a letter, [a-z0-9-]{0,23})", () => {
    expect(normalizeTag("1line:twilio")).toHaveProperty("error");
    expect(normalizeTag("a".repeat(25) + ":twilio")).toHaveProperty("error"); // 25 chars > 24
    expect(normalizeTag("li ne:twilio")).not.toHaveProperty("error"); // becomes li-ne, valid key shape
  });

  it("rejects an invalid value (must start with alnum, [a-z0-9.-]{0,47})", () => {
    expect(normalizeTag("line:")).toHaveProperty("error"); // empty value
    expect(normalizeTag("line:" + "a".repeat(49))).toHaveProperty("error"); // 49 chars > 48
  });

  it("accepts a key at the 24-char boundary and a value at the 48-char boundary", () => {
    const key = "a".repeat(24);
    const value = "a".repeat(48);
    expect(normalizeTag(`${key}:${value}`)).toEqual({ key, value });
  });

  it("enforces the link closed set", () => {
    for (const v of LINK_VALUES) {
      expect(normalizeTag(`link:${v}`)).toEqual({ key: "link", value: v });
    }
    const r = normalizeTag("link:5g");
    expect(r).toHaveProperty("error");
  });

  it("rejects non-string key/value on object input", () => {
    // @ts-expect-error deliberately wrong shape
    expect(normalizeTag({ key: "line", value: 5 })).toHaveProperty("error");
  });

  it("rejects a non-string, non-object input", () => {
    // @ts-expect-error deliberately wrong shape
    expect(normalizeTag(42)).toHaveProperty("error");
  });
});

describe("parseTags", () => {
  it("accepts an array of strings or {key,value} objects", () => {
    const r = parseTags(["line:twilio", { key: "isp", value: "starlink" }]);
    expect(r).toEqual({ tags: [{ key: "line", value: "twilio" }, { key: "isp", value: "starlink" }] });
  });

  it("dedupes by key — last wins", () => {
    const r = parseTags(["line:twilio", "line:bandwidth"]);
    expect(r).toEqual({ tags: [{ key: "line", value: "bandwidth" }] });
  });

  it("null/undefined input means no tags", () => {
    expect(parseTags(null)).toEqual({ tags: [] });
    expect(parseTags(undefined)).toEqual({ tags: [] });
  });

  it("rejects a non-array", () => {
    expect(parseTags("line:twilio")).toHaveProperty("error");
    expect(parseTags({ key: "line", value: "twilio" })).toHaveProperty("error");
  });

  it("propagates a bad tag's error", () => {
    const r = parseTags(["line:twilio", "no-colon-here"]);
    expect(r).toHaveProperty("error");
  });

  it("enforces the link closed set through parseTags too", () => {
    expect(parseTags(["link:5g"])).toHaveProperty("error");
  });

  it("caps at MAX_TAGS distinct keys — one over is an error", () => {
    const ok = Array.from({ length: MAX_TAGS }, (_, i) => `k${i}:v${i}`);
    expect(parseTags(ok)).toEqual({ tags: ok.map((s) => { const [key, value] = s.split(":"); return { key, value }; }) });

    const tooMany = Array.from({ length: MAX_TAGS + 1 }, (_, i) => `k${i}:v${i}`);
    expect(parseTags(tooMany)).toHaveProperty("error");
  });

  it("the cap is checked after dedup — 17 raw entries on 16 distinct keys is fine", () => {
    const entries = Array.from({ length: MAX_TAGS }, (_, i) => `k${i}:v${i}`);
    entries.push("k0:v0-again"); // 17 raw entries, still 16 distinct keys
    const r = parseTags(entries);
    expect(r).not.toHaveProperty("error");
    if ("tags" in r) expect(r.tags).toHaveLength(MAX_TAGS);
  });
});

describe("parseTags with an end (flow vs agent)", () => {
  it("a flow takes line + custom keys", () => {
    expect(parseTags(["line:twilio", "codec:opus"], { end: "flow" })).toEqual({
      tags: [{ key: "line", value: "twilio" }, { key: "codec", value: "opus" }],
    });
  });

  it("a flow refuses the agent's known keys with a message naming the right end", () => {
    expect(parseTags(["isp:starlink"], { end: "flow" })).toEqual({
      error: "isp is detected from the eval agent's network — set it on the agent, not the flow",
    });
    expect(parseTags(["line:twilio", "link:wifi"], { end: "flow" })).toEqual({
      error: "link is detected from the eval agent's network — set it on the agent, not the flow",
    });
  });

  it("an agent takes isp/link + custom keys and refuses line", () => {
    expect(parseTags(["isp:comcast", "link:wifi", "rack:a1"], { end: "agent" })).toEqual({
      tags: [{ key: "isp", value: "comcast" }, { key: "link", value: "wifi" }, { key: "rack", value: "a1" }],
    });
    expect(parseTags(["Line:Twilio"], { end: "agent" })).toEqual({
      error: "line belongs to the eval flow's dialled number — set it on the flow, not the agent",
    });
  });

  it("without an end every key passes (stored lists, filters)", () => {
    expect(parseTags(["line:twilio", "isp:att"])).toHaveProperty("tags");
  });

  it("END_TAG_KEYS + SYSTEM_TAG_KEYS partition the known keys", () => {
    expect([...END_TAG_KEYS.flow, ...END_TAG_KEYS.agent, ...SYSTEM_TAG_KEYS].sort()).toEqual([...KNOWN_TAG_KEYS].sort());
    expect(tagEndError("codec", "flow")).toBeUndefined();
    expect(tagEndError("codec", "agent")).toBeUndefined();
    expect(tagEndError("line", "flow")).toBeUndefined();
    expect(tagEndError("isp", "agent")).toBeUndefined();
  });
});

describe("system-only keys (access, sim)", () => {
  const ACCESS_MSG = "access is set by Vox from the eval agent's network — it can't be set by hand";
  const SIM_MSG = "sim is detected from the phone's SIM and its number — it can't be set by hand";

  it("are refused on a flow and on an agent, with the same clear message", () => {
    expect(SYSTEM_TAG_KEYS).toEqual(["access", "sim"]);
    for (const end of ["flow", "agent"] as const) {
      expect(parseTags(["access:lastmile"], { end })).toEqual({ error: ACCESS_MSG });
      expect(parseTags(["sim:att"], { end })).toEqual({ error: SIM_MSG });
      expect(parseTags(["Sim : T-Mobile"], { end })).toEqual({ error: SIM_MSG });
      expect(tagEndError("access", end)).toBe(ACCESS_MSG);
      expect(tagEndError("sim", end)).toBe(SIM_MSG);
    }
  });

  it("are still valid filters (no end) — access is a closed set", () => {
    expect(ACCESS_VALUES).toEqual(["lastmile", "datacenter", "unknown"]);
    expect(parseTagFilter(["access:lastmile", "sim:t-mobile"])).toEqual({
      filters: [{ key: "access", value: "lastmile" }, { key: "sim", value: "t-mobile" }],
    });
    expect(normalizeTag("access:home")).toEqual({ error: 'Invalid value "home" for "access": must be one of lastmile, datacenter, unknown' });
  });

  it("use the detected value on every board; a hand-set one is ignored, even where hand-set normally wins", () => {
    const jobTags: JobTag[] = [
      { key: "access", value: "datacenter", source: "agent" },
      { key: "access", value: "lastmile", source: "detected", reason: "v1: mobile-asn" },
      { key: "sim", value: "att", source: "flow" },
      { key: "sim", value: "t-mobile", source: "detected", reason: "v1: sim-match 310-260" },
    ];
    for (const board of ["mainline", "community", "myEvals"] as const) {
      expect(effectiveTags(jobTags, board)).toEqual([{ key: "access", value: "lastmile" }, { key: "sim", value: "t-mobile" }]);
      expect(effectiveTags([{ key: "sim", value: "att", source: "agent" }, { key: "access", value: "lastmile", source: "flow" }], board)).toEqual([]);
    }
  });
});

describe("simFromCarrier", () => {
  it("maps a carrier name to its radio network", () => {
    expect(simFromCarrier("T-Mobile USA, Inc.")).toBe("t-mobile");
    expect(simFromCarrier("AT&T Wireless")).toBe("att");
    expect(simFromCarrier("New Cingular Wireless PCS, LLC")).toBe("att");
    expect(simFromCarrier("Cellco Partnership dba Verizon Wireless")).toBe("verizon");
    expect(simFromCarrier("Verizon Wireless")).toBe("verizon");
  });
  it("falls back to a normalized name; nothing for null", () => {
    expect(simFromCarrier("Vodafone UK")).toBe("vodafone-uk");
    expect(simFromCarrier(null)).toBeUndefined();
  });
});

describe("the reserved value untagged", () => {
  it("normalizeTag refuses it on any key (it names the no-value group)", () => {
    expect(UNTAGGED_VALUE).toBe("untagged");
    expect(normalizeTag("isp:untagged")).toEqual({ error: '"untagged" is reserved for results without the tag — use another value for "isp"' });
    expect(normalizeTag({ key: "codec", value: " Untagged " })).toHaveProperty("error");
    expect(parseTags(["line:untagged"])).toHaveProperty("error");
    // A value merely containing it is fine.
    expect(normalizeTag("isp:untagged-isp")).toEqual({ key: "isp", value: "untagged-isp" });
  });
});

describe("formatTag", () => {
  it("formats key:value", () => {
    expect(formatTag({ key: "line", value: "twilio" })).toBe("line:twilio");
  });
});

describe("ispFromAsn", () => {
  it("maps known ASNs", () => {
    expect(ispFromAsn(14593, "SpaceX")).toBe("starlink");
    expect(ispFromAsn(7018, "AT&T")).toBe("att");
    expect(ispFromAsn(7922, "Comcast Cable")).toBe("comcast");
    expect(ispFromAsn(701, "Verizon")).toBe("verizon");
    expect(ispFromAsn(21928, "T-Mobile USA")).toBe("t-mobile");
    expect(ispFromAsn(16509, "Amazon.com")).toBe("aws");
    expect(ispFromAsn(15169, "Google LLC")).toBe("gcp");
    expect(ispFromAsn(8075, "Microsoft Corp")).toBe("azure");
  });

  it("falls back to a normalized org for an unmapped ASN", () => {
    expect(ispFromAsn(99999, "Some Random ISP, LLC.")).toBe("some-random-isp-llc.");
  });

  it("returns undefined when there's nothing to go on", () => {
    expect(ispFromAsn(undefined, undefined)).toBeUndefined();
    expect(ispFromAsn(99999, undefined)).toBeUndefined();
  });
});

describe("lineFromCarrier", () => {
  it("maps known carrier-name substrings", () => {
    expect(lineFromCarrier("Twilio - SMS/MMS-SVR")).toBe("twilio");
    expect(lineFromCarrier("Bandwidth.com CLEC")).toBe("bandwidth");
    expect(lineFromCarrier("Bandwidth/13 - Bandwidth.com - SVR")).toBe("bandwidth");
    expect(lineFromCarrier("Telnyx")).toBe("telnyx");
    expect(lineFromCarrier("Vonage")).toBe("vonage");
    expect(lineFromCarrier("Nexmo")).toBe("vonage");
    expect(lineFromCarrier("Plivo")).toBe("plivo");
    expect(lineFromCarrier("Sinch")).toBe("sinch");
    expect(lineFromCarrier("SignalWire")).toBe("signalwire");
  });

  it("falls back to a normalized name for an unmapped carrier", () => {
    expect(lineFromCarrier("Acme Telecom Co.")).toBe("acme-telecom-co.");
  });

  it("returns undefined for null/undefined", () => {
    expect(lineFromCarrier(null)).toBeUndefined();
    expect(lineFromCarrier(undefined)).toBeUndefined();
  });
});

describe("isSatelliteIsp", () => {
  it("is true for starlink and other satellite ISPs in the map", () => {
    expect(isSatelliteIsp("starlink")).toBe(true);
  });

  it("is false for a terrestrial ISP or undefined", () => {
    expect(isSatelliteIsp("att")).toBe(false);
    expect(isSatelliteIsp(undefined)).toBe(false);
  });
});

describe("effectiveTags", () => {
  it("handles null/undefined job tags as no tags", () => {
    expect(effectiveTags(null, "mainline")).toEqual([]);
    expect(effectiveTags(undefined, "community")).toEqual([]);
  });

  it("mainline: detected isp wins over a hand-set one", () => {
    const jobTags: JobTag[] = [
      { key: "isp", value: "att", source: "agent" },
      { key: "isp", value: "starlink", source: "detected" },
    ];
    expect(effectiveTags(jobTags, "mainline")).toEqual([{ key: "isp", value: "starlink" }]);
  });

  it("mainline: a hand-set-only isp (no detected value) counts as untagged", () => {
    const jobTags: JobTag[] = [{ key: "isp", value: "att", source: "agent" }];
    expect(effectiveTags(jobTags, "mainline")).toEqual([]);
  });

  it("mainline: link follows the same detected-only rule", () => {
    expect(effectiveTags([{ key: "link", value: "wifi", source: "agent" }], "mainline")).toEqual([]);
    expect(effectiveTags([{ key: "link", value: "wifi", source: "detected" }], "mainline")).toEqual([
      { key: "link", value: "wifi" },
    ]);
  });

  it("mainline: line falls back to the flow's hand-set value when there is no detected line", () => {
    const jobTags: JobTag[] = [{ key: "line", value: "twilio", source: "flow" }];
    expect(effectiveTags(jobTags, "mainline")).toEqual([{ key: "line", value: "twilio" }]);
  });

  it("mainline: line uses the detected value when present, ignoring the flow's hand-set one", () => {
    const jobTags: JobTag[] = [
      { key: "line", value: "twilio", source: "flow" },
      { key: "line", value: "bandwidth", source: "detected" },
    ];
    expect(effectiveTags(jobTags, "mainline")).toEqual([{ key: "line", value: "bandwidth" }]);
  });

  it("mainline: custom keys use flow/agent value — agent overrides flow", () => {
    const jobTags: JobTag[] = [
      { key: "codec", value: "pcm", source: "flow" },
      { key: "codec", value: "opus", source: "agent" },
    ];
    expect(effectiveTags(jobTags, "mainline")).toEqual([{ key: "codec", value: "opus" }]);
  });

  it("mainline: a custom key with only a flow value still counts (unlike known keys)", () => {
    const jobTags: JobTag[] = [{ key: "vpn", value: "on", source: "flow" }];
    expect(effectiveTags(jobTags, "mainline")).toEqual([{ key: "vpn", value: "on" }]);
  });

  it("community/myEvals: hand-set value wins over detected — agent over flow", () => {
    const jobTags: JobTag[] = [
      { key: "isp", value: "starlink", source: "detected" },
      { key: "isp", value: "att-corrected", source: "agent" },
    ];
    expect(effectiveTags(jobTags, "community")).toEqual([{ key: "isp", value: "att-corrected" }]);
    expect(effectiveTags(jobTags, "myEvals")).toEqual([{ key: "isp", value: "att-corrected" }]);
  });

  it("community/myEvals: falls back to detected when there's no hand-set value", () => {
    const jobTags: JobTag[] = [{ key: "isp", value: "starlink", source: "detected" }];
    expect(effectiveTags(jobTags, "community")).toEqual([{ key: "isp", value: "starlink" }]);
  });

  it("community/myEvals: flow wins over nothing when there's no agent value", () => {
    const jobTags: JobTag[] = [{ key: "line", value: "twilio", source: "flow" }];
    expect(effectiveTags(jobTags, "community")).toEqual([{ key: "line", value: "twilio" }]);
  });
});

describe("parseTagFilter", () => {
  it("accepts a single string", () => {
    expect(parseTagFilter("line:twilio")).toEqual({ filters: [{ key: "line", value: "twilio" }] });
  });

  it("accepts a repeated (array) value", () => {
    expect(parseTagFilter(["line:twilio", "isp:starlink"])).toEqual({
      filters: [{ key: "line", value: "twilio" }, { key: "isp", value: "starlink" }],
    });
  });

  it("treats absence as no filters", () => {
    expect(parseTagFilter(undefined)).toEqual({ filters: [] });
  });

  it("rejects invalid tag syntax", () => {
    expect(parseTagFilter("no-colon")).toHaveProperty("error");
    expect(parseTagFilter(["line:twilio", "link:5g"])).toHaveProperty("error");
  });
});

describe("parseGroupBy", () => {
  it("accepts a known or custom key", () => {
    expect(parseGroupBy("isp")).toEqual({ groupBy: "isp" });
    expect(parseGroupBy("codec")).toEqual({ groupBy: "codec" });
  });

  it("normalizes case", () => {
    expect(parseGroupBy("ISP")).toEqual({ groupBy: "isp" });
  });

  it("treats absence as no grouping", () => {
    expect(parseGroupBy(undefined)).toEqual({});
    expect(parseGroupBy(null)).toEqual({});
  });

  it("rejects an invalid key or multiple values", () => {
    expect(parseGroupBy("1isp")).toHaveProperty("error");
    expect(parseGroupBy(["isp", "link"])).toHaveProperty("error");
  });
});

describe("module shape", () => {
  it("exposes the known keys, link values and suggestions", () => {
    expect(KNOWN_TAG_KEYS).toEqual(["line", "isp", "link", "access", "sim"]);
    expect(LINK_VALUES).toEqual(["wifi", "ethernet", "cellular", "satellite"]);
    expect(MAX_TAGS).toBe(16);
    expect(TAG_SUGGESTIONS.line).toContain("twilio");
    expect(TAG_SUGGESTIONS.isp.length).toBeGreaterThan(0);
    expect(TAG_SUGGESTIONS.sim.length).toBeGreaterThan(0);
  });
});

describe("region is a reserved groupBy key, not a tag key", () => {
  it("refuses region as a tag key everywhere a tag is parsed", () => {
    expect(REGION_GROUP_KEY).toBe("region");
    const n = normalizeTag("Region:apac-in-mumbai");
    expect(n).toHaveProperty("error");
    expect((n as { error: string }).error).toMatch(/can't be a tag key/);
    expect(parseTags(["region:eu"])).toHaveProperty("error");
    expect(parseTags(["region:eu"], { end: "agent" })).toHaveProperty("error");
    expect(parseTags([{ key: "region", value: "eu" }], { end: "flow" })).toHaveProperty("error");
    expect(parseTagFilter("region:eu")).toHaveProperty("error");
    // ...but a key that merely starts with it is a normal custom key.
    expect(normalizeTag("regional:yes")).toEqual({ key: "regional", value: "yes" });
  });

  it("accepts region as a groupBy key", () => {
    expect(parseGroupBy("region")).toEqual({ groupBy: "region" });
    expect(parseGroupBy(" Region ")).toEqual({ groupBy: "region" });
  });
});

describe("explainSystemReason", () => {
  it("turns access signal names into short plain phrases", () => {
    expect(explainSystemReason("access", "v1: mobile-asn")).toBe("mobile network");
    expect(explainSystemReason("access", "v1: eyeball-asn + residential-rdns")).toBe("home ISP + residential address name");
    // Two signals with the same phrase read once.
    expect(explainSystemReason("access", "v1: eyeball-asn + pdb-access + residential-rdns")).toBe("home ISP + residential address name");
    expect(explainSystemReason("access", "v1: dc-range")).toBe("datacenter address range");
    expect(explainSystemReason("access", "v1: cloud-metadata")).toBe("cloud server detected");
    expect(explainSystemReason("access", "v1: public-ip-on-iface + mobile-asn")).toBe("the agent holds a public address itself + mobile network");
    expect(explainSystemReason("access", "v2: something-new")).toBe("something-new");
    expect(explainSystemReason("access", null)).toBeUndefined();
  });

  it("explains sim reasons", () => {
    expect(explainSystemReason("sim", "v1: sim-match 310-260")).toBe("The phone's SIM and a lookup of its number agree (network 310-260)");
    expect(explainSystemReason("sim", "v1: mismatch 310-260 vs 311-480")).toBe("The phone's SIM and a lookup of its number disagree");
    expect(explainSystemReason("sim", "v1: lookup-off")).toBe("Number lookup is off");
  });
});
