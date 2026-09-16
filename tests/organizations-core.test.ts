import { describe, it, expect } from "vitest";
import { CoreOrganizations } from "../server/organizations-core";
import { AlreadyMemberError } from "../server/organizations";

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

// In-memory org store backing the mutation methods — seeded with ORG7 (cloned so
// the ORG7 constant above stays untouched for the read-only tests' `toEqual` checks).
const orgStore: Record<number, typeof ORG7> = { 7: { ...ORG7 } };
let nextOrgId = 100;

const fakeStorage = {
  getUser: async (id: number) => users[id],
  getUsersByOrganization: async (orgId: number) =>
    Object.values(users).filter((u) => u.organizationId === orgId),
  getOrganization: async (id: number) => orgStore[id],
  getAllOrganizations: async () => Object.values(orgStore),
  countOrgAdmins: async (id: number) => (id === 7 ? 1 : 0),
  getOrganizationMemberCount: async (id: number) => (id === 7 ? 3 : 0),
  getUsersByIds: async (ids: number[]) => ids.map((i) => users[i]).filter(Boolean),
  createOrganization: async (org: { name: string; address?: string | null }) => {
    const id = nextOrgId++;
    const created = { id, name: org.name, address: org.address ?? null, verified: false, createdAt: new Date(), updatedAt: new Date() };
    orgStore[id] = created;
    return created;
  },
  updateOrganization: async (id: number, data: Partial<typeof ORG7>) => {
    const existing = orgStore[id];
    if (!existing) return undefined;
    const updated = { ...existing, ...data, updatedAt: new Date() };
    orgStore[id] = updated;
    return updated;
  },
  updateUser: async (id: number, data: Partial<{ organizationId: number | null; orgRole: string | null }>) => {
    const existing = users[id];
    if (!existing) return undefined;
    const updated = { ...existing, ...data };
    users[id] = updated;
    return updated;
  },
  removeUserFromOrganization: async (id: number) => {
    const existing = users[id];
    if (!existing) return undefined;
    const updated = { ...existing, organizationId: null, orgRole: null };
    users[id] = updated;
    return updated;
  },
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

  it("createOrganization creates the org and makes the creator its owner", async () => {
    const org = await orgs.createOrganization({ name: "New" }, { userId: 3 }); // user 3 has no org
    expect(org.name).toBe("New");
    expect(await orgs.getMembership(3)).toEqual({ organizationId: org.id, role: "owner" });
  });

  it("addMember enforces at-most-one-org with AlreadyMemberError", async () => {
    await expect(orgs.addMember(8, 1, "member")).rejects.toBeInstanceOf(AlreadyMemberError); // user 1 is in org 7
  });

  it("createOrganization refuses a creator who already belongs to an org", async () => {
    await expect(orgs.createOrganization({ name: "X" }, { userId: 1 })).rejects.toBeInstanceOf(AlreadyMemberError);
  });

  it("setMemberRole / removeMember round-trip", async () => {
    await orgs.setMemberRole(7, 2, "admin");
    expect((await orgs.getMembership(2))?.role).toBe("admin");
    await orgs.removeMember(7, 2);
    expect(await orgs.getMembership(2)).toBeNull();
  });

  it("setVerified writes the verified column; updateOrganization throws on unknown org", async () => {
    await orgs.setVerified(7, false);
    expect((await orgs.getOrganization(7))?.verified).toBe(false);
    await expect(orgs.updateOrganization(999, { name: "x" })).rejects.toThrow("organization not found");
  });
});
