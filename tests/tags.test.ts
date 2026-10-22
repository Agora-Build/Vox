import { describe, it, expect } from "vitest";
import {
  KNOWN_TAG_KEYS, LINK_VALUES, MAX_TAGS, TAG_SUGGESTIONS,
  normalizeTag, parseTags, formatTag,
  ispFromAsn, lineFromCarrier, isSatelliteIsp,
  effectiveTags, parseTagFilter, parseGroupBy,
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

  it("mainline: link and sim follow the same detected-only rule", () => {
    expect(effectiveTags([{ key: "link", value: "wifi", source: "agent" }], "mainline")).toEqual([]);
    expect(effectiveTags([{ key: "link", value: "wifi", source: "detected" }], "mainline")).toEqual([
      { key: "link", value: "wifi" },
    ]);
    expect(effectiveTags([{ key: "sim", value: "verizon", source: "agent" }], "mainline")).toEqual([]);
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
    expect(KNOWN_TAG_KEYS).toEqual(["line", "isp", "link", "sim"]);
    expect(LINK_VALUES).toEqual(["wifi", "ethernet", "cellular", "satellite"]);
    expect(MAX_TAGS).toBe(16);
    expect(TAG_SUGGESTIONS.line).toContain("twilio");
    expect(TAG_SUGGESTIONS.isp.length).toBeGreaterThan(0);
    expect(TAG_SUGGESTIONS.sim.length).toBeGreaterThan(0);
  });
});
