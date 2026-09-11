//
// Core-side seam for organization MEMBERSHIP — "which org does this person
// belong to, and with what power?". Pure interface + holder, no storage import,
// mirroring server/marketplace.ts. The built-in implementation lives in
// server/organizations-core.ts; a future `vox.organizations` plugin replaces it
// without any call site moving again.
//
// NOT in scope: which org OWNS a row (workflow.organizationId and the other
// resource-ownership columns). Those are Core's own FK columns, stay Core
// permanently, and are compared as opaque integers.

export type OrgRole = "owner" | "admin" | "member";

export interface Membership {
  organizationId: number;
  role: OrgRole;
}

export interface OrgSummary {
  id: number;
  name: string;
  isVerified: boolean;
}

export interface OrganizationsProvider {
  /** Membership of one user; null = belongs to no org. */
  getMembership(userId: number): Promise<Membership | null>;
  /** Batch form for listings — users with no org are absent from the map. */
  getMemberships(userIds: number[]): Promise<Map<number, Membership>>;
  /** Org identity, for display and the verification gate. */
  getOrganization(orgId: number): Promise<OrgSummary | null>;
  /** Roster of an org. */
  listMembers(orgId: number): Promise<Array<{ userId: number; role: OrgRole }>>;
}

let current: OrganizationsProvider | null = null;

/** Called once at startup (server/index.ts), and by tests installing a fake. */
export function setOrganizations(p: OrganizationsProvider): void {
  current = p;
}

/** Test-only: drop the installed provider so a suite starts from a known state. */
export function resetOrganizations(): void {
  current = null;
}

/**
 * NEVER null — deliberately unlike getMarketplace(). An absent marketplace makes
 * one optional tier inert, which is a coherent product state. An absent
 * organizations provider would report every user as belonging to no org, which
 * silently changes authorization outcomes across the app. Throwing turns a
 * startup wiring bug into a loud failure instead of a quiet policy change.
 */
export function getOrganizations(): OrganizationsProvider {
  if (!current) {
    throw new Error(
      "organizations provider not initialized — setOrganizations() must run at startup (server/index.ts) or in test setup",
    );
  }
  return current;
}
