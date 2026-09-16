//
// The built-in `vox.organizations` implementation: membership read from the
// Core `users.organization_id` / `users.org_role` columns. This is the ONLY
// file (besides storage) permitted to read those columns — see the boundary
// scan test. When orgs extract into a plugin, this file is deleted.

import type { DatabaseStorage } from "./storage";
import { AlreadyMemberError, type Membership, type Organization, type OrganizationsProvider, type OrgRole } from "./organizations";

/** Only the storage surface this needs — keeps the class testable without a DB. */
type StorageLike = Pick<
  DatabaseStorage,
  | "getUser"
  | "getUsersByOrganization"
  | "getOrganization"
  | "getUsersByIds"
  | "countOrgAdmins"
  | "getOrganizationMemberCount"
  | "getAllOrganizations"
  | "createOrganization"
  | "updateOrganization"
  | "updateUser"
  | "removeUserFromOrganization"
>;

/**
 * `users.org_role` is nullable. A user who belongs to an org but has no role
 * recorded is treated as "member": today's predicates grant manager rights only
 * on an explicit 'owner'/'admin', so mapping null → member preserves the exact
 * current outcome rather than inventing one.
 */
function toMembership(organizationId: number | null, orgRole: string | null): Membership | null {
  if (organizationId == null) return null;
  const role: OrgRole = orgRole === "owner" || orgRole === "admin" ? orgRole : "member";
  return { organizationId, role };
}

export class CoreOrganizations implements OrganizationsProvider {
  constructor(private readonly storage: StorageLike) {}

  async getMembership(userId: number): Promise<Membership | null> {
    const user = await this.storage.getUser(userId);
    if (!user) return null;
    return toMembership(user.organizationId, user.orgRole);
  }

  async getMemberships(userIds: number[]): Promise<Map<number, Membership>> {
    const out = new Map<number, Membership>();
    for (const u of await this.storage.getUsersByIds(userIds)) {
      const m = toMembership(u.organizationId, u.orgRole);
      if (m) out.set(u.id, m);
    }
    return out;
  }

  async getOrganization(orgId: number): Promise<Organization | null> {
    const org = await this.storage.getOrganization(orgId);
    return org ? { ...org } : null;
  }

  async listMembers(orgId: number): Promise<Array<{ userId: number; role: OrgRole }>> {
    const users = await this.storage.getUsersByOrganization(orgId);
    return users.flatMap((u) => {
      const m = toMembership(u.organizationId, u.orgRole);
      return m ? [{ userId: u.id, role: m.role }] : [];
    });
  }

  async countMembers(orgId: number): Promise<number> {
    return this.storage.getOrganizationMemberCount(orgId);
  }

  async countOrgAdmins(orgId: number): Promise<number> {
    return this.storage.countOrgAdmins(orgId);
  }

  async listOrganizations(): Promise<Organization[]> {
    return this.storage.getAllOrganizations();
  }

  async createOrganization(input: { name: string; address?: string }, creator: { userId: number }): Promise<Organization> {
    const user = await this.storage.getUser(creator.userId);
    if (user?.organizationId != null) throw new AlreadyMemberError(
      `user ${creator.userId} already belongs to organization ${user.organizationId}`);
    // Sequential, mirroring today's route behavior exactly. The PLUGIN provider
    // wraps these two in ctx.db.withTransaction (design §5); Core cannot and
    // does not pretend to.
    const org = await this.storage.createOrganization({ name: input.name, address: input.address ?? null });
    await this.storage.updateUser(creator.userId, { organizationId: org.id, orgRole: "owner" });
    return org;
  }

  async updateOrganization(orgId: number, patch: { name?: string; address?: string }): Promise<Organization> {
    const updated = await this.storage.updateOrganization(orgId, patch);
    if (!updated) throw new Error("organization not found");
    return updated;
  }

  async setVerified(orgId: number, verified: boolean): Promise<void> {
    await this.storage.updateOrganization(orgId, { verified });
  }

  async addMember(orgId: number, userId: number, role: OrgRole): Promise<void> {
    const user = await this.storage.getUser(userId);
    if (!user) throw new Error("user not found");
    if (user.organizationId != null) throw new AlreadyMemberError(
      `user ${userId} already belongs to organization ${user.organizationId}`);
    await this.storage.updateUser(userId, { organizationId: orgId, orgRole: role });
  }

  async setMemberRole(orgId: number, userId: number, role: OrgRole): Promise<void> {
    await this.storage.updateUser(userId, { orgRole: role });
  }

  async removeMember(_orgId: number, userId: number): Promise<void> {
    await this.storage.removeUserFromOrganization(userId);
  }
}
