import { describe, it, expect } from "vitest";
import { CoreOrganizations } from "../server/organizations-core";

const users: Record<number, { id: number; organizationId: number | null; orgRole: string | null }> = {
  1: { id: 1, organizationId: 7, orgRole: "owner" },
  2: { id: 2, organizationId: 7, orgRole: "member" },
  3: { id: 3, organizationId: null, orgRole: null },
  4: { id: 4, organizationId: 7, orgRole: null }, // org member with no role set
};

const fakeStorage = {
  getUser: async (id: number) => users[id],
  getUsersByOrganization: async (orgId: number) =>
    Object.values(users).filter((u) => u.organizationId === orgId),
  getOrganization: async (id: number) =>
    id === 7 ? { id: 7, name: "Acme", verified: true } : undefined,
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

  it("maps the `verified` column onto isVerified", async () => {
    expect(await orgs.getOrganization(7)).toEqual({ id: 7, name: "Acme", isVerified: true });
    expect(await orgs.getOrganization(8)).toBeNull();
  });

  it("lists members with their roles", async () => {
    const members = await orgs.listMembers(7);
    expect(members).toHaveLength(3);
    expect(members).toContainEqual({ userId: 1, role: "owner" });
    expect(members).toContainEqual({ userId: 4, role: "member" });
  });
});
