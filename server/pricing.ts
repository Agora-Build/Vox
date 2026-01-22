import { storage } from "./storage";

export interface PricingTier {
  minSeats: number;
  maxSeats: number;
  pricePerSeat: number;
  discountPercent: number;
}

export interface SeatPriceCalculation {
  totalSeats: number;
  pricePerSeat: number;
  discountPercent: number;
  subtotal: number;
  discount: number;
  total: number;
}

/**
 * Get the pricing tier for a given seat count
 */
export async function getPricingTier(seatCount: number): Promise<PricingTier | null> {
  const allPricing = await storage.getAllPricingConfig();

  // Find the tier that matches the seat count (for org tiers, exclude solo tier)
  for (const tier of allPricing) {
    if (tier.name !== "Solo Premium" && seatCount >= tier.minSeats && seatCount <= tier.maxSeats) {
      return {
        minSeats: tier.minSeats,
        maxSeats: tier.maxSeats,
        pricePerSeat: tier.pricePerSeat,
        discountPercent: tier.discountPercent,
      };
    }
  }

  // Return the highest tier if seat count exceeds all tiers
  const orgTiers = allPricing.filter(t => t.name !== "Solo Premium");
  if (orgTiers.length > 0) {
    const highestTier = orgTiers[orgTiers.length - 1];
    return {
      minSeats: highestTier.minSeats,
      maxSeats: highestTier.maxSeats,
      pricePerSeat: highestTier.pricePerSeat,
      discountPercent: highestTier.discountPercent,
    };
  }

  return null;
}

/**
 * Calculate the price for purchasing additional seats
 * Uses volume discount based on total seats after purchase
 */
export async function calculateSeatPrice(currentSeats: number, additionalSeats: number): Promise<SeatPriceCalculation | null> {
  if (additionalSeats <= 0) {
    return null;
  }

  const totalSeats = currentSeats + additionalSeats;
  const tier = await getPricingTier(totalSeats);

  if (!tier) {
    return null;
  }

  const subtotal = tier.pricePerSeat * additionalSeats;
  const discount = Math.round(subtotal * tier.discountPercent / 100);
  const total = subtotal - discount;

  return {
    totalSeats,
    pricePerSeat: tier.pricePerSeat,
    discountPercent: tier.discountPercent,
    subtotal,
    discount,
    total,
  };
}

/**
 * Check if Stripe is configured
 */
export function isStripeConfigured(): boolean {
  return !!(process.env.STRIPE_SECRET_KEY);
}
