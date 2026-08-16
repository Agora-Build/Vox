import { describe, it, expect } from "vitest";
import { validateTierChange } from "../server/dispatch";

const owner = { id: 1, isAdmin: false, plan: "premium" };
const stranger = { id: 2, isAdmin: false, plan: "premium" };
const admin = { id: 9, isAdmin: true, plan: "basic" };
const token = { createdBy: 1 };

describe("validateTierChange", () => {
  it("owner may set a free tier", () => {
    expect(validateTierChange({ user: owner, token, newTier: "team", marketplacePresent: false }))
      .toEqual({ ok: true, status: 200 });
  });
  it("non-owner non-admin is forbidden (403)", () => {
    expect(validateTierChange({ user: stranger, token, newTier: "public", marketplacePresent: false }))
      .toEqual({ ok: false, status: 403, reason: "forbidden" });
  });
  it("admin may set a free tier on another's token (moderation)", () => {
    expect(validateTierChange({ user: admin, token, newTier: "private", marketplacePresent: false }))
      .toEqual({ ok: true, status: 200 });
  });
  it("shared without marketplace is rejected (400)", () => {
    expect(validateTierChange({ user: owner, token, newTier: "shared", marketplacePresent: false, pricePerUnit: 5 }))
      .toEqual({ ok: false, status: 400, reason: "shared-unavailable" });
  });
  it("shared requires a non-basic caller (403)", () => {
    expect(validateTierChange({ user: { id: 1, isAdmin: false, plan: "basic" }, token, newTier: "shared", marketplacePresent: true, pricePerUnit: 5 }))
      .toEqual({ ok: false, status: 403, reason: "shared-requires-non-basic" });
  });
  it("shared requires a positive pricePerUnit (400)", () => {
    expect(validateTierChange({ user: owner, token, newTier: "shared", marketplacePresent: true, pricePerUnit: 0 }))
      .toEqual({ ok: false, status: 400, reason: "price-required" });
    expect(validateTierChange({ user: owner, token, newTier: "shared", marketplacePresent: true, pricePerUnit: null }))
      .toEqual({ ok: false, status: 400, reason: "price-required" });
  });
  it("shared valid when marketplace present, non-basic, priced", () => {
    expect(validateTierChange({ user: owner, token, newTier: "shared", marketplacePresent: true, pricePerUnit: 5 }))
      .toEqual({ ok: true, status: 200 });
  });
});
