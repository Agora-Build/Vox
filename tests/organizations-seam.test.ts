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
};

describe("organizations seam", () => {
  beforeEach(() => resetOrganizations());

  it("returns the provider that was installed", async () => {
    setOrganizations(stub);
    expect(await getOrganizations().getMembership(1)).toEqual({ organizationId: 7, role: "admin" });
  });

  it("throws rather than reporting everyone as org-less when uninitialized", () => {
    expect(() => getOrganizations()).toThrow(/not initialized/);
  });

  it("lets a later provider replace an earlier one (plugin overrides Core)", async () => {
    setOrganizations(stub);
    setOrganizations({ ...stub, getMembership: async () => null });
    expect(await getOrganizations().getMembership(1)).toBeNull();
  });
});
