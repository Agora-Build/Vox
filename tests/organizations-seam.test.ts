import { describe, it, expect, beforeEach } from "vitest";
import {
  setOrganizations,
  getOrganizations,
  resetOrganizations,
  type OrganizationsProvider,
} from "../server/organizations";

const stub: OrganizationsProvider = {
  getMembership: async () => ({ organizationId: 7, role: "admin" }),
  getMemberships: async () => new Map(),
  getOrganization: async () => null,
  listMembers: async () => [],
  // Widened by Task 2 — trivial stubs, unused by this suite's assertions.
  countMembers: async () => 0,
  countOrgAdmins: async () => 0,
  listOrganizations: async () => [],
  createOrganization: async () => { throw new Error("not implemented in stub"); },
  updateOrganization: async () => { throw new Error("not implemented in stub"); },
  setVerified: async () => { throw new Error("not implemented in stub"); },
  addMember: async () => { throw new Error("not implemented in stub"); },
  setMemberRole: async () => { throw new Error("not implemented in stub"); },
  removeMember: async () => { throw new Error("not implemented in stub"); },
  listOrgSecrets: async () => [],
  upsertOrgSecret: async () => { throw new Error("not implemented in stub"); },
  deleteOrgSecret: async () => { throw new Error("not implemented in stub"); },
};

describe("organizations seam", () => {
  beforeEach(() => resetOrganizations());

  it("returns the provider that was installed", async () => {
    setOrganizations(stub);
    expect(await getOrganizations()!.getMembership(1)).toEqual({ organizationId: 7, role: "admin" });
  });

  it("returns null when no provider is installed — absence is a state, not a crash", () => {
    expect(getOrganizations()).toBeNull();
  });

  it("lets a later provider replace an earlier one (plugin overrides Core)", async () => {
    setOrganizations(stub);
    setOrganizations({ ...stub, getMembership: async () => null });
    expect(await getOrganizations()!.getMembership(1)).toBeNull();
  });
});
