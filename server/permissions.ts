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

// --- Shared-agents dispatch predicates ---

export type DispatchToken = { id: number; dispatchTier: string; createdBy: number; region: string };

/**
 * Two parties are "same org" iff both have the SAME non-null organizationId.
 * The single Core abstraction for org membership (spec §8): when orgs become a
 * plugin, only this function moves behind the seam — dispatch/claim never change.
 */
export function sameOrg(a: { organizationId: number | null }, b: { organizationId: number | null }): boolean {
  return a.organizationId != null && a.organizationId === b.organizationId;
}

/**
 * Single Core abstraction for "does this user belong to any org?" — the org-gate
 * choke-point (spec §4.1). `team` tier and any future org-only capability test
 * membership through here, so when orgs become a plugin only this moves behind
 * the seam. Mirrors sameOrg.
 */
export function hasOrg(user: { organizationId: number | null }): boolean {
  return user.organizationId != null;
}

/**
 * Pool-tier composition gate for session-injected dispatch (spec §5): a
 * session-injected job may only enter the dispatcher's own pool, or a team
 * pool when the workflow belongs to that same org. The routes enforce this at
 * write time, but the workflow's secrets/config are MUTABLE afterward — a
 * public-tier schedule whose workflow later gains a login-class secret would
 * emit an unclaimable session job every tick. The scheduler re-checks through
 * here each tick and disables violating schedules. Returns null when allowed,
 * else a human-readable reason.
 */
export function sessionPoolViolation(
  targetTier: "private" | "team" | "public" | "shared",
  workflow: { organizationId: number | null },
  creator: { organizationId: number | null } | undefined,
): string | null {
  // Allowlist shape: only tiers we affirmatively trust return null, so a
  // future enum member (or the reserved 'shared') fails CLOSED here.
  if (targetTier === "private") return null;
  if (targetTier === "team") {
    if (workflow.organizationId != null &&
        sameOrg({ organizationId: creator?.organizationId ?? null }, { organizationId: workflow.organizationId })) {
      return null;
    }
    return "credential-injected jobs can use a team pool only when the workflow belongs to the creator's organization";
  }
  return `credential-injected jobs cannot use the ${targetTier} pool`;
}

/** Free-tier dispatch authz. `shared` is NOT decided here — the marketplace seam handles it. */
export function canDispatchToToken(
  user: { id: number; organizationId: number | null },
  token: Pick<DispatchToken, "dispatchTier" | "createdBy">,
  tokenOwner: { organizationId: number | null },
): boolean {
  switch (token.dispatchTier) {
    case "public":
      return true;
    case "private":
      return token.createdBy === user.id;
    case "team":
      return token.createdBy === user.id || sameOrg({ organizationId: user.organizationId }, tokenOwner);
    case "shared":
    default:
      return false;
  }
}

/**
 * Claim eligibility — the source of truth. `storage.claimEvalJob` /
 * `getClaimableJobsForToken` mirror this exact logic in SQL for atomicity;
 * keep the two in lockstep.
 *
 * `sessionInjected` = the job carries a Core-minted login session (its config
 * has `sessionInjection`). Such a job must never land on a PUBLIC (stranger's)
 * agent picked up from the region pool: only the dispatcher's own agents claim
 * it untargeted, or the aimed token if targeted. The /session serve gate
 * (`isSessionServable`) is the second, credential-authoritative check — but we
 * gate the claim too so a stranger's public agent can't even take the job
 * off the queue and sit on it.
 */
export function isClaimable(
  job: {
    targetTokenId: number | null;
    targetRegion?: string | null;
    targetTier?: "private" | "team" | "public" | "shared" | null;
    siteId?: string | null;
    createdBy: number | null;
    sessionInjected?: boolean;
  },
  token: Pick<DispatchToken, "id" | "dispatchTier" | "createdBy"> & { region?: string; siteId?: string },
  orgs?: { tokenOwnerOrgId: number | null; creatorOrgId: number | null },
): boolean {
  // Targeted: only the aimed token, ever.
  if (job.targetTokenId != null) return job.targetTokenId === token.id;

  // Pooled: region match + mutual consent (dispatcher's requested pool ∩
  // the owner's offered dispatchTier). Spec §6.
  if (job.targetRegion != null) {
    if (token.region !== job.targetRegion) return false;
    switch (job.targetTier) {
      case "private":
        return job.createdBy === token.createdBy;
      case "team":
        return (token.dispatchTier === "team" || token.dispatchTier === "public")
          && sameOrg(
            { organizationId: orgs?.tokenOwnerOrgId ?? null },
            { organizationId: orgs?.creatorOrgId ?? null },
          );
      case "public":
        return token.dispatchTier === "public" && !job.sessionInjected;
      default:
        return false; // 'shared' reserved; null malformed
    }
  }

  // Legacy site-pinned rows (pre-tier-targeting), until drained: site equality
  // + the old public-or-mine arm.
  if (job.siteId == null || job.siteId !== token.siteId) return false;
  if (job.createdBy === token.createdBy) return true;
  return token.dispatchTier === "public" && !job.sessionInjected;
}

/**
 * Session serve gate — who may RECEIVE a Core-minted session bundle
 * for a session-injected job. Derived entirely from the job's IMMUTABLE stamped
 * snapshot (never the live workflow — the owner can edit it post-dispatch).
 * Policy: owner + team + attested-shared.
 *  - owner: the workflow owner's own agents (token.createdBy === workflow owner).
 *  - team:  an agent whose owner shares the workflow's organization.
 *  - attested-shared: consent + test-account attestation were verified at
 *    dispatch (job.consent) AND the job was aimed at exactly this token.
 * Public/community and non-attested shared agents are excluded.
 */
export function isSessionServable(
  job: { targetTokenId: number | null; workflowOwnerId: number | null; workflowOrgId: number | null; consent: boolean },
  token: { id: number; createdBy: number },
  tokenOwner: { organizationId: number | null },
): boolean {
  if (job.workflowOwnerId != null && token.createdBy === job.workflowOwnerId) return true;
  if (job.workflowOrgId != null && sameOrg({ organizationId: tokenOwner.organizationId }, { organizationId: job.workflowOrgId })) return true;
  if (job.consent === true && job.targetTokenId != null && job.targetTokenId === token.id) return true;
  return false;
}
