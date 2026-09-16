import { describe, it, expect, beforeEach } from "vitest";
import { setOrganizations, resetOrganizations, type OrganizationsProvider, type Membership, type OrgRole } from "../server/organizations";
import { resolveMembership } from "../server/auth";
import { canAccessResource, isOwnerOrOrgManager, hasOrg } from "../server/permissions";

class FakeOrganizations implements OrganizationsProvider {
  constructor(private readonly byUser: Map<number, Membership>) {}
  async getMembership(userId: number) { return this.byUser.get(userId) ?? null; }
  async getMemberships(userIds: number[]) {
    const m = new Map<number, Membership>();
    for (const id of userIds) { const v = this.byUser.get(id); if (v) m.set(id, v); }
    return m;
  }
  async getOrganization(orgId: number) {
    return {
      id: orgId,
      name: `org-${orgId}`,
      address: null,
      verified: false,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
  }
  async listMembers(orgId: number) {
    return [...this.byUser.entries()]
      .filter(([, m]) => m.organizationId === orgId)
      .map(([userId, m]) => ({ userId, role: m.role }));
  }
  // Task 2 widened the interface with these — trivial stubs, unused by this
  // suite's assertions (fixture plumbing only, per Task 1/2 Ruling E).
  async countMembers(_orgId: number): Promise<number> { return 0; }
  async countOrgAdmins(_orgId: number): Promise<number> { return 0; }
  async listOrganizations(): Promise<never[]> { return []; }
  async createOrganization(_input: { name: string; address?: string }, _creator: { userId: number }): Promise<never> {
    throw new Error("not implemented in fake");
  }
  async updateOrganization(_orgId: number, _patch: { name?: string; address?: string }): Promise<never> {
    throw new Error("not implemented in fake");
  }
  async setVerified(_orgId: number, _verified: boolean): Promise<void> {
    throw new Error("not implemented in fake");
  }
  async addMember(_orgId: number, _userId: number, _role: OrgRole): Promise<void> {
    throw new Error("not implemented in fake");
  }
  async setMemberRole(_orgId: number, _userId: number, _role: OrgRole): Promise<void> {
    throw new Error("not implemented in fake");
  }
  async removeMember(_orgId: number, _userId: number): Promise<void> {
    throw new Error("not implemented in fake");
  }
}

// The row says org 7 / owner. The provider says org 99 / member. The provider must win.
const rowSaysOrg7 = { id: 42, isAdmin: false, organizationId: 7, orgRole: "owner" } as never;

describe("organizations seam override", () => {
  beforeEach(() => {
    resetOrganizations();
    setOrganizations(new FakeOrganizations(new Map([[42, { organizationId: 99, role: "member" }]])));
  });

  it("membership comes from the provider, not the user row", async () => {
    const user = await resolveMembership(rowSaysOrg7, {} as never);
    expect(user!.membership).toEqual({ organizationId: 99, role: "member" });
  });

  it("authorization follows the provider's org, not the row's", async () => {
    const user = (await resolveMembership(rowSaysOrg7, {} as never))!;
    expect(canAccessResource(user, { ownerId: 1, organizationId: 99, visibility: "private" })).toBe(true);
    expect(canAccessResource(user, { ownerId: 1, organizationId: 7,  visibility: "private" })).toBe(false);
  });

  it("authorization follows the provider's role, not the row's", async () => {
    const user = (await resolveMembership(rowSaysOrg7, {} as never))!;
    // Row says owner (a manager); provider says member (not a manager) and must win.
    expect(isOwnerOrOrgManager(user, { ownerId: 1, organizationId: 99, visibility: "private" })).toBe(false);
  });

  it("a provider reporting no org overrides a row that has one", async () => {
    setOrganizations(new FakeOrganizations(new Map()));
    const user = (await resolveMembership(rowSaysOrg7, {} as never))!;
    expect(hasOrg(user)).toBe(false);
  });

  it("the resolved user never carries the raw legacy columns, even though the row did", async () => {
    const user = await resolveMembership(rowSaysOrg7, {} as never);
    expect(user!).not.toHaveProperty("organizationId");
    expect(user!).not.toHaveProperty("orgRole");
  });
});
