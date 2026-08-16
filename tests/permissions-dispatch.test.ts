import { describe, it, expect } from "vitest";
import { sameOrg, canDispatchToToken, isClaimable } from "../server/permissions";

describe("sameOrg", () => {
  it("true when both share a non-null org", () => {
    expect(sameOrg({ organizationId: 5 }, { organizationId: 5 })).toBe(true);
  });
  it("false when orgs differ", () => {
    expect(sameOrg({ organizationId: 5 }, { organizationId: 6 })).toBe(false);
  });
  it("false when either org is null (no org is not 'same org')", () => {
    expect(sameOrg({ organizationId: null }, { organizationId: null })).toBe(false);
    expect(sameOrg({ organizationId: 5 }, { organizationId: null })).toBe(false);
  });
});

describe("canDispatchToToken (free tiers)", () => {
  const alice = { id: 1, organizationId: 10 };
  const bob = { id: 2, organizationId: 10 };
  const carol = { id: 3, organizationId: 99 };

  it("public: anyone may dispatch", () => {
    const t = { dispatchTier: "public", createdBy: 2 };
    expect(canDispatchToToken(carol, t, { organizationId: 10 })).toBe(true);
  });
  it("private: only the owner", () => {
    const t = { dispatchTier: "private", createdBy: 2 };
    expect(canDispatchToToken(bob, t, { organizationId: 10 })).toBe(true);
    expect(canDispatchToToken(alice, t, { organizationId: 10 })).toBe(false);
  });
  it("team: owner or an org-mate of the owner", () => {
    const t = { dispatchTier: "team", createdBy: 2 };
    expect(canDispatchToToken(alice, t, { organizationId: 10 })).toBe(true); // same org
    expect(canDispatchToToken(carol, t, { organizationId: 10 })).toBe(false); // different org
    expect(canDispatchToToken(bob, t, { organizationId: 10 })).toBe(true); // owner
  });
  it("shared: never a free-tier yes (seam decides)", () => {
    const t = { dispatchTier: "shared", createdBy: 2 };
    expect(canDispatchToToken(bob, t, { organizationId: 10 })).toBe(false);
  });
});

describe("isClaimable", () => {
  const publicTok = { id: 100, dispatchTier: "public", createdBy: 7 };
  const privateTok = { id: 200, dispatchTier: "private", createdBy: 7 };

  it("targeted job: only the aimed token claims", () => {
    const job = { targetTokenId: 100, createdBy: 3 };
    expect(isClaimable(job, publicTok)).toBe(true);
    expect(isClaimable(job, { id: 101, dispatchTier: "public", createdBy: 7 })).toBe(false);
  });
  it("untargeted job: public-tier token may claim any", () => {
    const job = { targetTokenId: null, createdBy: 3 };
    expect(isClaimable(job, publicTok)).toBe(true);
  });
  it("untargeted job: non-public token claims only its owner's jobs", () => {
    const ownJob = { targetTokenId: null, createdBy: 7 };
    const otherJob = { targetTokenId: null, createdBy: 3 };
    expect(isClaimable(ownJob, privateTok)).toBe(true);
    expect(isClaimable(otherJob, privateTok)).toBe(false);
  });
});
