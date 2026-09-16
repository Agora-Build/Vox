import { describe, it, expect, beforeEach } from "vitest";
import { setOrganizations, resetOrganizations, type OrganizationsProvider } from "../server/organizations";
import { resolveMembership, membershipFor } from "../server/auth";

let calls = 0;
const provider: OrganizationsProvider = {
  getMembership: async (userId: number) => {
    calls++;
    return userId === 1 ? { organizationId: 7, role: "admin" } : null;
  },
  getMemberships: async () => new Map(),
  getOrganization: async () => null,
  listMembers: async () => [],
  // Widened by Task 2 — trivial stubs, unused by this suite's assertions.
  countMembers: async () => 0,
  countOrgAdmins: async () => 0,
  listOrganizations: async () => [],
  createOrganization: async () => { throw new Error("not implemented in fixture"); },
  updateOrganization: async () => { throw new Error("not implemented in fixture"); },
  setVerified: async () => { throw new Error("not implemented in fixture"); },
  addMember: async () => { throw new Error("not implemented in fixture"); },
  setMemberRole: async () => { throw new Error("not implemented in fixture"); },
  removeMember: async () => { throw new Error("not implemented in fixture"); },
  listOrgSecrets: async () => [],
  upsertOrgSecret: async () => { throw new Error("not implemented in fixture"); },
  deleteOrgSecret: async () => { throw new Error("not implemented in fixture"); },
};

describe("auth membership resolution", () => {
  beforeEach(() => { calls = 0; resetOrganizations(); setOrganizations(provider); });

  it("attaches membership from the provider", async () => {
    const req = {} as never;
    const user = await resolveMembership({ id: 1 } as never, req);
    expect(user!.membership).toEqual({ organizationId: 7, role: "admin" });
  });

  it("attaches null for a user in no org", async () => {
    const user = await resolveMembership({ id: 2 } as never, {} as never);
    expect(user!.membership).toBeNull();
  });

  it("passes undefined through untouched", async () => {
    expect(await resolveMembership(undefined, {} as never)).toBeUndefined();
  });

  it("resolves once per request even when called repeatedly", async () => {
    const req = {} as never;
    await resolveMembership({ id: 1 } as never, req);
    await resolveMembership({ id: 1 } as never, req);
    expect(calls).toBe(1);

    // The memo must be scoped to the REQUEST, not the process. A module-global
    // cache would also satisfy the assertion above, yet would serve a stale
    // membership for the lifetime of the process — a user removed from an org
    // would keep org access until restart. A different `req` must re-resolve.
    await resolveMembership({ id: 1 } as never, {} as never);
    expect(calls).toBe(2);
  });

  it("shares one answer between the guard helper and resolveMembership within a request", async () => {
    const req = {} as never;
    await resolveMembership({ id: 1 } as never, req);
    expect(await membershipFor(req, 1)).toEqual({ organizationId: 7, role: "admin" });
    // requireOrgAdmin must not open a second, independently-resolved path: a
    // guard admitting on one answer while the handler body rejects on another
    // is the hazard this memo exists to prevent.
    expect(calls).toBe(1);
  });
});
