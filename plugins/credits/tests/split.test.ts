import { describe, it, expect } from "vitest";
import { assertPositiveCredits, validateSplit } from "../server/split";

describe("assertPositiveCredits", () => {
  it("accepts a positive integer", () => {
    expect(() => assertPositiveCredits(5)).not.toThrow();
  });
  it("rejects zero, negatives, and non-integers", () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity]) {
      expect(() => assertPositiveCredits(bad)).toThrow(/invalid amount/);
    }
  });
});

describe("validateSplit", () => {
  it("accepts a split summing exactly to the hold amount", () => {
    expect(() => validateSplit(100, { earnerShare: 90, platformFeeCredits: 10 })).not.toThrow();
  });
  it("accepts a zero-fee split", () => {
    expect(() => validateSplit(100, { earnerShare: 100, platformFeeCredits: 0 })).not.toThrow();
  });
  it("rejects a split that does not sum to the hold amount", () => {
    expect(() => validateSplit(100, { earnerShare: 90, platformFeeCredits: 5 })).toThrow(/split/);
    expect(() => validateSplit(100, { earnerShare: 90, platformFeeCredits: 20 })).toThrow(/split/);
  });
  it("rejects negative or non-integer parts", () => {
    expect(() => validateSplit(100, { earnerShare: -10, platformFeeCredits: 110 })).toThrow();
    expect(() => validateSplit(100, { earnerShare: 90.5, platformFeeCredits: 9.5 })).toThrow();
  });
});
