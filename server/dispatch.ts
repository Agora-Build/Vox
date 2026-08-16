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
