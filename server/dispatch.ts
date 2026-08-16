import { canDispatchToToken, type DispatchToken } from "./permissions";

export type DispatchTier = "private" | "team" | "public" | "shared";

export interface TierChangeContext {
  user: { id: number; isAdmin: boolean; plan: string };
  token: { createdBy: number };
  newTier: DispatchTier;
  marketplacePresent: boolean;
  pricePerUnit?: number | null;
}

export interface TierChangeResult {
  ok: boolean;
  status: number;
  reason?: string;
}

export function validateTierChange(ctx: TierChangeContext): TierChangeResult {
  const isOwner = ctx.token.createdBy === ctx.user.id;
  if (!isOwner && !ctx.user.isAdmin) return { ok: false, status: 403, reason: "forbidden" };

  if (ctx.newTier === "shared") {
    if (!ctx.marketplacePresent) return { ok: false, status: 400, reason: "shared-unavailable" };
    if (ctx.user.plan === "basic") return { ok: false, status: 403, reason: "shared-requires-non-basic" };
    if (ctx.pricePerUnit == null || !(ctx.pricePerUnit > 0)) return { ok: false, status: 400, reason: "price-required" };
  }
  return { ok: true, status: 200 };
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
