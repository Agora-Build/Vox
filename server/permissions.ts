// ---- Org resource permission helpers ----
// Shared by the route handlers (server/routes.ts) and the background scheduler
// (server/index.ts) so authorization can't drift between the API and runtime.

export interface OrgResource {
  ownerId?: number | null;
  organizationId?: number | null;
  createdBy?: number | null;
  visibility?: string | null;
}

export interface AuthUser {
  id: number;
  isAdmin: boolean;
  organizationId: number | null;
  orgRole: string | null;
}

export function canAccessResource(user: AuthUser, resource: OrgResource): boolean {
  if (user.isAdmin) return true;
  if (resource.ownerId === user.id || resource.createdBy === user.id) return true;
  if (resource.organizationId && resource.organizationId === user.organizationId) return true;
  if (resource.visibility === 'public') return true;
  return false;
}

// Owner/creator, or an org manager for org resources — WITHOUT the system-admin
// bypass. This is the predicate for *editing* content and *running* private
// workflows: a system admin has no special power over another user's content
// (its secrets/quota are the owner's). Admin's elevated powers are limited to
// user management and provider config (separate requireAdmin routes).
export function isOwnerOrOrgManager(user: AuthUser, resource: OrgResource): boolean {
  // Personal resource owner
  if (!resource.organizationId && (resource.ownerId === user.id || resource.createdBy === user.id)) return true;
  // Org resource
  if (resource.organizationId && resource.organizationId === user.organizationId) {
    if (user.orgRole === 'owner' || user.orgRole === 'admin') return true;
    if (resource.ownerId === user.id || resource.createdBy === user.id) return true;
  }
  return false;
}

// Edit/delete gate that DOES include the system-admin bypass — kept for the
// delete routes (admin moderation) and other admin-capable operations.
export function canEditResource(user: AuthUser, resource: OrgResource): boolean {
  return user.isAdmin || isOwnerOrOrgManager(user, resource);
}

// Run-once rights: a public workflow can be run by anyone (a one-off on the
// owner's key, which they opted into by publishing). A PRIVATE workflow can be
// run only by its owner or, for an org-owned workflow, its org managers — no
// system-admin and no principal/fellow bypass. This is safe because secrets
// follow ownership: a personal workflow spends the owner's personal key (so only
// the owner runs it), while an org workflow spends the ORG's secrets (so org
// members running it spend org — not anyone's personal — credentials). See the
// job-secrets endpoint in routes.ts.
export function canRunWorkflow(user: AuthUser, resource: OrgResource): boolean {
  if (resource.visibility === 'public') return true;
  return isOwnerOrOrgManager(user, resource);
}

// "Schedule" rights are the strictest workflow action: creating a schedule sets
// up an indefinite recurring commitment, so it is limited to the workflow's
// owner/creator — NOT a system admin, and (by deliberate product choice) NOT an
// org manager either. Running once and *extending* an existing schedule are
// looser (owner-or-org via isOwnerOrOrgManager); only *creating* the recurring
// commitment is owner-only. Note secrets now follow ownership (org workflows
// spend org secrets), so this is a product decision, not a credential-ownership
// argument. The background scheduler applies the same check per tick, so a
// schedule whose creator lost this right (e.g. a legacy admin-created one) stops firing.
export function canScheduleWorkflow(user: Pick<AuthUser, 'id'>, resource: OrgResource): boolean {
  return resource.ownerId === user.id || resource.createdBy === user.id;
}
