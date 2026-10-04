import { describe, expect, it } from "vitest";
import { normalizedGrant } from "../plugins/credits/server/personal";
import { pricingSchema, publicCatalog } from "../plugins/payments/server/catalog";

describe("personal billing input boundaries", () => {
  it("normalizes grant recipients and reason", () => {
    expect(normalizedGrant({ batchId: "12345678-1234-4234-8234-123456789abc", userIds: [9, 1, 9], credits: 100, reason: " Award " })).toMatchObject({ userIds: [1, 9], reason: "Award" });
  });
  it("rejects unsafe amounts, excessive recipients and unrecognized grant fields", () => {
    const payload = { batchId: "12345678-1234-4234-8234-123456789abc", userIds: [1], credits: 100, reason: "Award" };
    for (const credits of [-1, 0, 1.5, Infinity, 1_000_000_001]) expect(() => normalizedGrant({ ...payload, credits })).toThrow();
    expect(() => normalizedGrant({ ...payload, userIds: Array(501).fill(1) })).toThrow();
    expect(() => normalizedGrant({ ...payload, adminUserId: 1 })).toThrow();
  });
  it("keeps initial pricing explicit and forbids selling privileged tiers", () => {
    expect(publicCatalog({ id: 1, premium_price_cents: 1200, topup_price_cents: 500, topup_credits: 100, premium_stripe_price: null, topup_stripe_price: null })).toEqual({ version: 1, currency: "usd", premiumPriceCents: 1200, topupPriceCents: 500, topupCredits: 100 });
    expect(pricingSchema.safeParse({ baseVersion: 1, premiumPriceCents: 1200, topupPriceCents: 500, topupCredits: 100, plan: "principal" }).success).toBe(false);
  });
});
