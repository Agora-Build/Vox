import { canDispatchToToken, sameOrg, hasOrg, type DispatchToken } from "./permissions";

export type DispatchTier = "private" | "team" | "public" | "shared";

export interface TierChangeResult {
  ok: boolean;
  status: number;
  reason?: string;
}

export interface TierChoiceContext {
  user: { id: number; isAdmin: boolean; plan: string; organizationId: number | null };
  isOwner: boolean;            // create: true (self); change: token.createdBy === user.id
  newTier: DispatchTier;
  marketplacePresent: boolean;
  pricePerUnit?: number | null;
}

export function validateTierChoice(ctx: TierChoiceContext): TierChangeResult {
  if (!ctx.isOwner && !ctx.user.isAdmin) return { ok: false, status: 403, reason: "forbidden" };

  switch (ctx.newTier) {
    case "public":
      // Public is admin-only (create AND change).
      if (!ctx.user.isAdmin) return { ok: false, status: 403, reason: "public-admin-only" };
      return { ok: true, status: 200 };

    case "team":
      if (ctx.user.plan === "basic" && !ctx.user.isAdmin) return { ok: false, status: 403, reason: "team-requires-non-basic" };
      // A team agent must belong to an org — org membership required (admin included).
      if (!hasOrg(ctx.user)) return { ok: false, status: 400, reason: "team-requires-org" };
      return { ok: true, status: 200 };

    case "shared":
      if (!ctx.marketplacePresent) return { ok: false, status: 400, reason: "shared-unavailable" };
      if (ctx.user.plan === "basic" && !ctx.user.isAdmin) return { ok: false, status: 403, reason: "shared-requires-non-basic" };
      if (ctx.pricePerUnit == null || !(ctx.pricePerUnit > 0)) return { ok: false, status: 400, reason: "price-required" };
      return { ok: true, status: 200 };

    case "private":
      return { ok: true, status: 200 };
  }
}

export interface TargetedDispatchDecision {
  ok: boolean;
  reason?: string;
  region?: string;
}

/** Free-tier targeted-dispatch decision. `shared` is deferred to the marketplace seam. */
export function resolveTargetedDispatch(
  user: { id: number; organizationId: number | null },
  token: DispatchToken,
  tokenOwner: { organizationId: number | null },
): TargetedDispatchDecision {
  if (token.dispatchTier === "shared") return { ok: false, reason: "shared-requires-marketplace" };
  if (!canDispatchToToken(user, token, tokenOwner)) return { ok: false, reason: "forbidden" };
  return { ok: true, region: token.region };
}

export interface DispatchableAgentRow {
  tokenId: number;
  region: string;
  dispatchTier: string;
  ownerId: number;
  ownerOrgId: number | null;
  state: string;
}

/** Free tiers the caller may target. `shared` is excluded — the route merges it from the seam. */
export function filterDispatchableAgents(
  user: { id: number; organizationId: number | null },
  agents: DispatchableAgentRow[],
): DispatchableAgentRow[] {
  return agents.filter((a) => {
    switch (a.dispatchTier) {
      case "public":
        return true;
      case "private":
        return a.ownerId === user.id;
      case "team":
        return a.ownerId === user.id || sameOrg({ organizationId: user.organizationId }, { organizationId: a.ownerOrgId });
      case "shared":
      default:
        return false;
    }
  });
}
