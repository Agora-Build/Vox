import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getPricingTier, calculateSeatPrice, isStripeConfigured } from '../server/pricing';

// Mock the storage module
vi.mock('../server/storage', () => ({
  storage: {
    getAllPricingConfig: vi.fn(),
  },
}));

import { storage } from '../server/storage';

describe('Pricing Utilities', () => {
  const mockPricingConfig = [
    {
      id: 1,
      name: 'Solo Premium',
      minSeats: 1,
      maxSeats: 1,
      pricePerSeat: 10,
      discountPercent: 0,
      isActive: true,
    },
    {
      id: 2,
      name: 'Team Starter',
      minSeats: 1,
      maxSeats: 2,
      pricePerSeat: 6,
      discountPercent: 0,
      isActive: true,
    },
    {
      id: 3,
      name: 'Team Growth',
      minSeats: 3,
      maxSeats: 5,
      pricePerSeat: 6,
      discountPercent: 10,
      isActive: true,
    },
    {
      id: 4,
      name: 'Team Pro',
      minSeats: 6,
      maxSeats: 10,
      pricePerSeat: 6,
      discountPercent: 15,
      isActive: true,
    },
    {
      id: 5,
      name: 'Enterprise',
      minSeats: 11,
      maxSeats: 999,
      pricePerSeat: 6,
      discountPercent: 25,
      isActive: true,
    },
  ];

  beforeEach(() => {
    vi.mocked(storage.getAllPricingConfig).mockResolvedValue(mockPricingConfig);
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('getPricingTier', () => {
    it('should return Team Starter tier for 1-2 seats', async () => {
      const tier = await getPricingTier(1);

      expect(tier).toBeDefined();
      expect(tier!.minSeats).toBe(1);
      expect(tier!.maxSeats).toBe(2);
      expect(tier!.discountPercent).toBe(0);
    });

    it('should return Team Growth tier for 3-5 seats', async () => {
      const tier = await getPricingTier(3);

      expect(tier).toBeDefined();
      expect(tier!.minSeats).toBe(3);
      expect(tier!.maxSeats).toBe(5);
      expect(tier!.discountPercent).toBe(10);
    });

    it('should return Team Pro tier for 6-10 seats', async () => {
      const tier = await getPricingTier(8);

      expect(tier).toBeDefined();
      expect(tier!.minSeats).toBe(6);
      expect(tier!.maxSeats).toBe(10);
      expect(tier!.discountPercent).toBe(15);
    });

    it('should return Enterprise tier for 11+ seats', async () => {
      const tier = await getPricingTier(15);

      expect(tier).toBeDefined();
      expect(tier!.minSeats).toBe(11);
      expect(tier!.maxSeats).toBe(999);
      expect(tier!.discountPercent).toBe(25);
    });

    it('should return highest tier for seat count exceeding max', async () => {
      const tier = await getPricingTier(1000);

      expect(tier).toBeDefined();
      expect(tier!.discountPercent).toBe(25); // Enterprise tier
    });

    it('should exclude Solo Premium tier', async () => {
      // Solo Premium is for individual users, not orgs
      const tier = await getPricingTier(1);

      // Should get Team Starter (0% discount), not Solo Premium
      expect(tier).toBeDefined();
      expect(tier!.discountPercent).toBe(0);
      expect(tier!.pricePerSeat).toBe(6); // Team pricing, not Solo pricing
    });

    it('should return null when no pricing config exists', async () => {
      vi.mocked(storage.getAllPricingConfig).mockResolvedValue([]);

      const tier = await getPricingTier(5);
      expect(tier).toBeNull();
    });
  });

  describe('calculateSeatPrice', () => {
    it('should calculate price for 0% discount tier', async () => {
      const result = await calculateSeatPrice(0, 2);

      expect(result).toBeDefined();
      expect(result!.totalSeats).toBe(2);
      expect(result!.pricePerSeat).toBe(6);
      expect(result!.discountPercent).toBe(0);
      expect(result!.subtotal).toBe(12); // 2 * $6
      expect(result!.discount).toBe(0);
      expect(result!.total).toBe(12);
    });

    it('should calculate price with 10% discount', async () => {
      const result = await calculateSeatPrice(2, 2); // Total becomes 4 seats

      expect(result).toBeDefined();
      expect(result!.totalSeats).toBe(4);
      expect(result!.pricePerSeat).toBe(6);
      expect(result!.discountPercent).toBe(10);
      expect(result!.subtotal).toBe(12); // 2 * $6
      expect(result!.discount).toBe(1); // Round(12 * 0.10) = 1
      expect(result!.total).toBe(11);
    });

    it('should calculate price with 15% discount', async () => {
      const result = await calculateSeatPrice(5, 3); // Total becomes 8 seats

      expect(result).toBeDefined();
      expect(result!.totalSeats).toBe(8);
      expect(result!.discountPercent).toBe(15);
      expect(result!.subtotal).toBe(18); // 3 * $6
      expect(result!.discount).toBe(3); // Round(18 * 0.15) = 2.7 -> 3
      expect(result!.total).toBe(15);
    });

    it('should calculate price with 25% discount for large teams', async () => {
      const result = await calculateSeatPrice(10, 5); // Total becomes 15 seats

      expect(result).toBeDefined();
      expect(result!.totalSeats).toBe(15);
      expect(result!.discountPercent).toBe(25);
      expect(result!.subtotal).toBe(30); // 5 * $6
      expect(result!.discount).toBe(8); // Round(30 * 0.25) = 7.5 -> 8
      expect(result!.total).toBe(22);
    });

    it('should return null for zero additional seats', async () => {
      const result = await calculateSeatPrice(5, 0);
      expect(result).toBeNull();
    });

    it('should return null for negative additional seats', async () => {
      const result = await calculateSeatPrice(5, -1);
      expect(result).toBeNull();
    });

    it('should use volume pricing based on total seats after purchase', async () => {
      // Starting with 2 seats (0% tier), adding 1 seat crosses to 3-seat tier (10%)
      const result = await calculateSeatPrice(2, 1);

      expect(result).toBeDefined();
      expect(result!.totalSeats).toBe(3);
      expect(result!.discountPercent).toBe(10); // Gets 10% because total is 3
    });

    it('should return null when no pricing config exists', async () => {
      vi.mocked(storage.getAllPricingConfig).mockResolvedValue([]);

      const result = await calculateSeatPrice(0, 5);
      expect(result).toBeNull();
    });

    it('should correctly calculate for large seat purchases', async () => {
      const result = await calculateSeatPrice(0, 20);

      expect(result).toBeDefined();
      expect(result!.totalSeats).toBe(20);
      expect(result!.discountPercent).toBe(25);
      expect(result!.subtotal).toBe(120); // 20 * $6
      expect(result!.discount).toBe(30); // 120 * 0.25 = 30
      expect(result!.total).toBe(90);
    });
  });

  describe('isStripeConfigured', () => {
    it('should return false when STRIPE_SECRET_KEY is not set', () => {
      vi.stubEnv('STRIPE_SECRET_KEY', '');

      const result = isStripeConfigured();
      expect(result).toBe(false);
    });

    it('should return true when STRIPE_SECRET_KEY is set', () => {
      vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_xxxxx');

      const result = isStripeConfigured();
      expect(result).toBe(true);
    });

    it('should return false when STRIPE_SECRET_KEY is undefined', () => {
      delete process.env.STRIPE_SECRET_KEY;

      const result = isStripeConfigured();
      expect(result).toBe(false);
    });
  });
});
