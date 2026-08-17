import { describe, it, expect } from "vitest";
import { computeCharge, computeFee, assertValidSplit } from "../plugins/shared-agents/server/pricing";

describe("shared-agents pricing", () => {
  it("computeCharge multiplies price_per_unit by price_units", () => {
    expect(computeCharge(10, 1)).toBe(10);
    expect(computeCharge(7, 3)).toBe(21);
  });

  it("computeCharge rejects non-positive-integer inputs", () => {
    expect(() => computeCharge(0, 1)).toThrow();
    expect(() => computeCharge(10, 0)).toThrow();
    expect(() => computeCharge(1.5, 1)).toThrow();
    expect(() => computeCharge(-1, 1)).toThrow();
  });

  it("computeFee is round(charge * 0.20)", () => {
    expect(computeFee(1)).toBe(0);   // round(0.2)
    expect(computeFee(3)).toBe(1);   // round(0.6)
    expect(computeFee(10)).toBe(2);  // round(2.0)
    expect(computeFee(100)).toBe(20);
  });

  it("earnerShare + fee always equals charge (invariant assertValidSplit enforces)", () => {
    for (const charge of [1, 3, 10, 100, 999]) {
      const fee = computeFee(charge);
      const earner = charge - fee;
      expect(() => assertValidSplit(charge, earner, fee)).not.toThrow();
    }
  });

  it("assertValidSplit rejects parts that do not sum to charge", () => {
    expect(() => assertValidSplit(10, 7, 2)).toThrow(); // sums to 9
    expect(() => assertValidSplit(10, -1, 11)).toThrow(); // negative part
  });
});
