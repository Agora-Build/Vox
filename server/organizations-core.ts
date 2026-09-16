//
// The built-in `vox.organizations` implementation: membership read from the
// Core `users.organization_id` / `users.org_role` columns. This is the ONLY
// file (besides storage) permitted to read those columns — see the boundary
// scan test. When orgs extract into a plugin, this file is deleted.

import type { DatabaseStorage } from "./storage";
import type { Membership, Organization, OrganizationsProvider, OrgRole } from "./organizations";

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
}
