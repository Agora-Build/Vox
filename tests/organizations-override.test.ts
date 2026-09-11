import { describe, it, expect, beforeEach } from "vitest";
import { setOrganizations, resetOrganizations, type OrganizationsProvider, type Membership } from "../server/organizations";
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
  async getOrganization(orgId: number) { return { id: orgId, name: `org-${orgId}`, isVerified: false }; }
  async listMembers(orgId: number) {
    return [...this.byUser.entries()]
      .filter(([, m]) => m.organizationId === orgId)
      .map(([userId, m]) => ({ userId, role: m.role }));
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
