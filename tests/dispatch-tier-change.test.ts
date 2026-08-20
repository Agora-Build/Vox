import { describe, it, expect } from "vitest";
import { validateTierChoice } from "../server/dispatch";

const owner = { id: 1, isAdmin: false, plan: "premium", organizationId: null as number | null };
const orgOwner = { id: 1, isAdmin: false, plan: "premium", organizationId: 7 as number | null };
const admin = { id: 9, isAdmin: true, plan: "basic", organizationId: null as number | null };

describe("validateTierChoice", () => {
  it("private is always allowed for the owner", () => {
    expect(validateTierChoice({ user: owner, isOwner: true, newTier: "private", marketplacePresent: false }))
      .toEqual({ ok: true, status: 200 });
  });

  it("non-owner non-admin is forbidden (403)", () => {
    expect(validateTierChoice({ user: owner, isOwner: false, newTier: "private", marketplacePresent: false }))
      .toEqual({ ok: false, status: 403, reason: "forbidden" });
  });

  it("public is admin-only — non-admin owner rejected (403)", () => {
    expect(validateTierChoice({ user: owner, isOwner: true, newTier: "public", marketplacePresent: false }))
      .toEqual({ ok: false, status: 403, reason: "public-admin-only" });
  });

  it("public allowed for admin", () => {
    expect(validateTierChoice({ user: admin, isOwner: true, newTier: "public", marketplacePresent: false }))
      .toEqual({ ok: true, status: 200 });
  });

  it("team requires org membership — no org rejected (400)", () => {
    expect(validateTierChoice({ user: owner, isOwner: true, newTier: "team", marketplacePresent: false }))
      .toEqual({ ok: false, status: 400, reason: "team-requires-org" });
  });

  it("team allowed for a non-basic owner in an org", () => {
    expect(validateTierChoice({ user: orgOwner, isOwner: true, newTier: "team", marketplacePresent: false }))
      .toEqual({ ok: true, status: 200 });
  });

  it("team requires a non-basic caller (403)", () => {
    expect(validateTierChoice({ user: { id: 1, isAdmin: false, plan: "basic", organizationId: 7 }, isOwner: true, newTier: "team", marketplacePresent: false }))
      .toEqual({ ok: false, status: 403, reason: "team-requires-non-basic" });
  });

  it("shared without marketplace is rejected (400)", () => {
    expect(validateTierChoice({ user: owner, isOwner: true, newTier: "shared", marketplacePresent: false, pricePerUnit: 5 }))
      .toEqual({ ok: false, status: 400, reason: "shared-unavailable" });
  });

  it("shared requires a non-basic caller (403)", () => {
    expect(validateTierChoice({ user: { id: 1, isAdmin: false, plan: "basic", organizationId: null }, isOwner: true, newTier: "shared", marketplacePresent: true, pricePerUnit: 5 }))
      .toEqual({ ok: false, status: 403, reason: "shared-requires-non-basic" });
  });

  it("shared requires a positive pricePerUnit (400)", () => {
    expect(validateTierChoice({ user: owner, isOwner: true, newTier: "shared", marketplacePresent: true, pricePerUnit: 0 }))
      .toEqual({ ok: false, status: 400, reason: "price-required" });
    expect(validateTierChoice({ user: owner, isOwner: true, newTier: "shared", marketplacePresent: true, pricePerUnit: null }))
      .toEqual({ ok: false, status: 400, reason: "price-required" });
  });

  it("shared valid when marketplace present, non-basic, priced", () => {
    expect(validateTierChoice({ user: owner, isOwner: true, newTier: "shared", marketplacePresent: true, pricePerUnit: 5 }))
      .toEqual({ ok: true, status: 200 });
  });
});
