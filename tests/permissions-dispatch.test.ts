import { describe, it, expect } from "vitest";
import { sameOrg, canDispatchToToken, isClaimable, isSessionServable } from "../server/permissions";

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

  it("session-injected untargeted job: a PUBLIC stranger token may NOT claim it (HIGH-1)", () => {
    // A stranger's public agent must never pull a session-injected job off the
    // region pool — it would sit on the owner's minted test-account session.
    const job = { targetTokenId: null, createdBy: 3, sessionInjected: true };
    expect(isClaimable(job, publicTok)).toBe(false);
  });
  it("session-injected untargeted job: the owner's OWN token still claims it", () => {
    const job = { targetTokenId: null, createdBy: 7, sessionInjected: true };
    expect(isClaimable(job, privateTok)).toBe(true); // createdBy match
    expect(isClaimable(job, { id: 100, dispatchTier: "public", createdBy: 7 })).toBe(true);
  });
  it("session-injected TARGETED job: the aimed token still claims regardless of tier", () => {
    const job = { targetTokenId: 100, createdBy: 3, sessionInjected: true };
    expect(isClaimable(job, publicTok)).toBe(true); // aimed at 100
  });
});

describe("isSessionServable (owner + team + attested-shared)", () => {
  // Workflow owned by user 7, no org.
  const personalJob = { targetTokenId: null, workflowOwnerId: 7, workflowOrgId: null, consent: false };
  // Workflow owned by org 20.
  const orgJob = { targetTokenId: null, workflowOwnerId: 7, workflowOrgId: 20, consent: false };

  it("owner arm: the workflow owner's own agent receives the bundle", () => {
    const token = { id: 100, createdBy: 7 };
    expect(isSessionServable(personalJob, token, { organizationId: null })).toBe(true);
  });
  it("owner arm: a stranger's agent on a personal job is refused", () => {
    const token = { id: 100, createdBy: 3 };
    expect(isSessionServable(personalJob, token, { organizationId: null })).toBe(false);
  });
  it("team arm: an org co-member's agent receives an org job's bundle", () => {
    const token = { id: 100, createdBy: 8 };
    expect(isSessionServable(orgJob, token, { organizationId: 20 })).toBe(true);
  });
  it("team arm: a different-org agent is refused", () => {
    const token = { id: 100, createdBy: 8 };
    expect(isSessionServable(orgJob, token, { organizationId: 21 })).toBe(false);
  });
  it("attested-shared arm: a targeted token with consent receives the bundle", () => {
    const sharedJob = { targetTokenId: 100, workflowOwnerId: 7, workflowOrgId: null, consent: true };
    const token = { id: 100, createdBy: 3 };
    expect(isSessionServable(sharedJob, token, { organizationId: null })).toBe(true);
  });
  it("attested-shared arm: consent WITHOUT being the aimed token is refused", () => {
    const sharedJob = { targetTokenId: 100, workflowOwnerId: 7, workflowOrgId: null, consent: true };
    const otherToken = { id: 101, createdBy: 3 };
    expect(isSessionServable(sharedJob, otherToken, { organizationId: null })).toBe(false);
  });
  it("attested-shared arm: aimed token but NO consent is refused", () => {
    const noConsent = { targetTokenId: 100, workflowOwnerId: 7, workflowOrgId: null, consent: false };
    const token = { id: 100, createdBy: 3 };
    expect(isSessionServable(noConsent, token, { organizationId: null })).toBe(false);
  });
});
