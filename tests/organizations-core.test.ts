import { describe, it, expect } from "vitest";
import { CoreOrganizations } from "../server/organizations-core";

const users: Record<number, { id: number; organizationId: number | null; orgRole: string | null }> = {
  1: { id: 1, organizationId: 7, orgRole: "owner" },
  2: { id: 2, organizationId: 7, orgRole: "member" },
  3: { id: 3, organizationId: null, orgRole: null },
  4: { id: 4, organizationId: 7, orgRole: null }, // org member with no role set
};

const ORG7 = {
  id: 7,
  name: "Acme",
  address: null,
  verified: true,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const fakeStorage = {
  getUser: async (id: number) => users[id],
  getUsersByOrganization: async (orgId: number) =>
    Object.values(users).filter((u) => u.organizationId === orgId),
  getOrganization: async (id: number) => (id === 7 ? ORG7 : undefined),
  getAllOrganizations: async () => [ORG7],
  countOrgAdmins: async (id: number) => (id === 7 ? 1 : 0),
  getOrganizationMemberCount: async (id: number) => (id === 7 ? 3 : 0),
  getUsersByIds: async (ids: number[]) => ids.map((i) => users[i]).filter(Boolean),
} as never;

const orgs = new CoreOrganizations(fakeStorage);

describe("CoreOrganizations", () => {
  it("reads membership and role from the user row", async () => {
    expect(await orgs.getMembership(1)).toEqual({ organizationId: 7, role: "owner" });
  });

  it("returns null for a user in no org", async () => {
    expect(await orgs.getMembership(3)).toBeNull();
  });

  it("returns null for an unknown user", async () => {
    expect(await orgs.getMembership(999)).toBeNull();
  });

  it("treats a null org_role as 'member' — preserving today's non-manager outcome", async () => {
    expect(await orgs.getMembership(4)).toEqual({ organizationId: 7, role: "member" });
  });

  it("batches memberships and omits users with no org", async () => {
    const map = await orgs.getMemberships([1, 3, 4, 999]);
    expect(map.get(1)).toEqual({ organizationId: 7, role: "owner" });
    expect(map.get(4)).toEqual({ organizationId: 7, role: "member" });
    expect(map.has(3)).toBe(false);
    expect(map.has(999)).toBe(false);
  });

  it("getOrganization returns the FULL row (address/verified/timestamps), not a summary", async () => {
    expect(await orgs.getOrganization(7)).toEqual(ORG7); // `verified`, not `isVerified`
    expect(await orgs.getOrganization(8)).toBeNull();
  });

  it("countMembers and countOrgAdmins delegate", async () => {
    expect(await orgs.countMembers(7)).toBe(3);
    expect(await orgs.countOrgAdmins(7)).toBe(1);
  });

  it("listOrganizations returns full rows", async () => {
    expect(await orgs.listOrganizations()).toEqual([ORG7]);
  });

  it("getMemberships resolves via ONE getUsersByIds call, not per-user getUser", async () => {
    let batchCalls = 0;
    let singleCalls = 0;
    const countingStorage = {
      ...fakeStorage,
      getUser: async (id: number) => {
        singleCalls++;
        return users[id];
      },
      getUsersByIds: async (ids: number[]) => {
        batchCalls++;
        return ids.map((i) => users[i]).filter(Boolean);
      },
    } as never;
    const countingOrgs = new CoreOrganizations(countingStorage);

    const m = await countingOrgs.getMemberships([1, 3, 4, 999]);
    expect(m.get(1)).toEqual({ organizationId: 7, role: "owner" });
    expect(batchCalls).toBe(1);
    expect(singleCalls).toBe(0); // the N+1 is gone (recorded deferred-minor, now closed)
  });

  it("lists members with their roles", async () => {
    const members = await orgs.listMembers(7);
    expect(members).toHaveLength(3);
    expect(members).toContainEqual({ userId: 1, role: "owner" });
    expect(members).toContainEqual({ userId: 4, role: "member" });
  });
});
