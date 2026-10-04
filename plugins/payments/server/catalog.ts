import { z } from "zod";
export const pricingSchema = z.object({
  baseVersion: z.number().int().positive(),
  premiumPriceCents: z.number().int().min(50).max(1_000_000),
  topupPriceCents: z.number().int().min(50).max(1_000_000),
  topupCredits: z.number().int().min(1).max(1_000_000),
}).strict();

export interface CatalogRow {
  id: number;
  premium_price_cents: number;
  topup_price_cents: number;
  topup_credits: number;
  premium_stripe_price: string | null;
  topup_stripe_price: string | null;
}
export function publicCatalog(row: CatalogRow) {
  return { version: row.id, currency: "usd", premiumPriceCents: row.premium_price_cents, topupPriceCents: row.topup_price_cents, topupCredits: row.topup_credits };
}
