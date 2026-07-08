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

export function canEditResource(user: AuthUser, resource: OrgResource): boolean {
  if (user.isAdmin) return true;
  // Personal resource owner
  if (!resource.organizationId && (resource.ownerId === user.id || resource.createdBy === user.id)) return true;
  // Org resource
  if (resource.organizationId && resource.organizationId === user.organizationId) {
    if (user.orgRole === 'owner' || user.orgRole === 'admin') return true;
    if (resource.ownerId === user.id || resource.createdBy === user.id) return true;
  }
  return false;
}

// "Run" rights sit between access (view) and edit (mutate): running or scheduling
// an eval executes a workflow without changing it. Public workflows are runnable
// by anyone; private ones only by an editor (owner/org-admin/admin) or a
// principal/fellow. Used by both the run-once and schedule-create routes so the
// two entry points can't drift apart.
export function canRunWorkflow(user: AuthUser & { plan: string }, resource: OrgResource): boolean {
  if (resource.visibility === 'public') return true;
  return canEditResource(user, resource) || user.plan === 'principal' || user.plan === 'fellow';
}

// "Schedule" rights are stricter than edit: a schedule (recurring OR deferred
// one-time) repeatedly/later runs the workflow on the OWNER's stored secrets —
// and secret resolution always loads the workflow owner's PERSONAL secrets first
// (storage.getSecretsForJob), even for org workflows. So only the workflow
// owner/creator may schedule it: NOT a system admin, and NOT an org manager
// (either could otherwise spend the owner's personal credentials without consent).
// The background scheduler applies the same check per tick, so a schedule whose
// creator lost this right (e.g. a legacy admin-created one) stops firing.
export function canScheduleWorkflow(user: Pick<AuthUser, 'id'>, resource: OrgResource): boolean {
  return resource.ownerId === user.id || resource.createdBy === user.id;
}
