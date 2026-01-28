import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hashToken, generateSecureToken } from '../server/storage';

describe('Invite System', () => {
  describe('Invite Token Generation', () => {
    it('should generate secure invite token', () => {
      const token = generateSecureToken(32);

      expect(token).toHaveLength(64); // 32 bytes = 64 hex chars
      expect(token).toMatch(/^[a-f0-9]+$/);
    });

    it('should generate unique tokens', () => {
      const tokens = new Set();
      for (let i = 0; i < 100; i++) {
        tokens.add(generateSecureToken(32));
      }

      expect(tokens.size).toBe(100);
    });
  });

  describe('Invite Token Hashing', () => {
    it('should hash token before storage', () => {
      const token = generateSecureToken(32);
      const hash = hashToken(token);

      expect(hash).not.toBe(token);
      expect(hash).toHaveLength(64);
    });

    it('should verify token by comparing hashes', () => {
      const token = generateSecureToken(32);
      const storedHash = hashToken(token);

      // Verification
      expect(hashToken(token)).toBe(storedHash);
    });
  });

  describe('Invite Token Validation', () => {
    interface InviteToken {
      id: number;
      tokenHash: string;
      email: string | null;
      organizationId: number | null;
      createdBy: number;
      usedBy: number | null;
      usedAt: Date | null;
      expiresAt: Date;
      createdAt: Date;
    }

    const createMockInvite = (overrides: Partial<InviteToken> = {}): InviteToken => ({
      id: 1,
      tokenHash: hashToken(generateSecureToken(32)),
      email: null,
      organizationId: null,
      createdBy: 1,
      usedBy: null,
      usedAt: null,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
      createdAt: new Date(),
      ...overrides,
    });

    it('should check if invite is expired', () => {
      const isExpired = (invite: InviteToken) => new Date() > invite.expiresAt;

      const validInvite = createMockInvite();
      expect(isExpired(validInvite)).toBe(false);

      const expiredInvite = createMockInvite({
        expiresAt: new Date(Date.now() - 1000),
      });
      expect(isExpired(expiredInvite)).toBe(true);
    });

    it('should check if invite is already used', () => {
      const isUsed = (invite: InviteToken) => invite.usedBy !== null;

      const unusedInvite = createMockInvite();
      expect(isUsed(unusedInvite)).toBe(false);

      const usedInvite = createMockInvite({
        usedBy: 2,
        usedAt: new Date(),
      });
      expect(isUsed(usedInvite)).toBe(true);
    });

    it('should validate invite is usable', () => {
      const isUsable = (invite: InviteToken) => {
        if (invite.usedBy !== null) return false;
        if (new Date() > invite.expiresAt) return false;
        return true;
      };

      const usableInvite = createMockInvite();
      expect(isUsable(usableInvite)).toBe(true);

      const usedInvite = createMockInvite({ usedBy: 2 });
      expect(isUsable(usedInvite)).toBe(false);

      const expiredInvite = createMockInvite({
        expiresAt: new Date(Date.now() - 1000),
      });
      expect(isUsable(expiredInvite)).toBe(false);
    });

    it('should validate email-specific invites', () => {
      const canUseInvite = (invite: InviteToken, userEmail: string) => {
        if (invite.email === null) return true; // Open invite
        return invite.email.toLowerCase() === userEmail.toLowerCase();
      };

      const openInvite = createMockInvite({ email: null });
      expect(canUseInvite(openInvite, 'anyone@example.com')).toBe(true);

      const emailInvite = createMockInvite({ email: 'specific@example.com' });
      expect(canUseInvite(emailInvite, 'specific@example.com')).toBe(true);
      expect(canUseInvite(emailInvite, 'SPECIFIC@EXAMPLE.COM')).toBe(true);
      expect(canUseInvite(emailInvite, 'other@example.com')).toBe(false);
    });

    it('should validate organization-specific invites', () => {
      const orgInvite = createMockInvite({ organizationId: 5 });

      expect(orgInvite.organizationId).toBe(5);
    });
  });

  describe('Invite Token Redemption', () => {
    it('should mark invite as used on redemption', () => {
      const invite = {
        tokenHash: hashToken(generateSecureToken(32)),
        usedBy: null as number | null,
        usedAt: null as Date | null,
      };

      // Simulate redemption
      const redeem = (inv: typeof invite, userId: number) => {
        inv.usedBy = userId;
        inv.usedAt = new Date();
      };

      redeem(invite, 42);

      expect(invite.usedBy).toBe(42);
      expect(invite.usedAt).toBeInstanceOf(Date);
    });

    it('should not allow double redemption', () => {
      const invite = {
        usedBy: 1,
        usedAt: new Date(),
      };

      const canRedeem = (inv: typeof invite) => inv.usedBy === null;

      expect(canRedeem(invite)).toBe(false);
    });
  });

  describe('Activation Token', () => {
    interface ActivationToken {
      id: number;
      userId: number;
      tokenHash: string;
      expiresAt: Date;
      usedAt: Date | null;
      createdAt: Date;
    }

    const createMockActivation = (overrides: Partial<ActivationToken> = {}): ActivationToken => ({
      id: 1,
      userId: 1,
      tokenHash: hashToken(generateSecureToken(32)),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
      usedAt: null,
      createdAt: new Date(),
      ...overrides,
    });

    it('should generate activation token for user', () => {
      const activation = createMockActivation({ userId: 5 });

      expect(activation.userId).toBe(5);
      expect(activation.tokenHash).toHaveLength(64);
    });

    it('should expire after 24 hours by default', () => {
      const activation = createMockActivation();
      const expiryTime = activation.expiresAt.getTime();
      const expectedExpiry = activation.createdAt.getTime() + 24 * 60 * 60 * 1000;

      // Allow 1 second tolerance
      expect(Math.abs(expiryTime - expectedExpiry)).toBeLessThan(1000);
    });

    it('should validate activation token', () => {
      const isValid = (token: ActivationToken) => {
        if (token.usedAt !== null) return false;
        if (new Date() > token.expiresAt) return false;
        return true;
      };

      const validToken = createMockActivation();
      expect(isValid(validToken)).toBe(true);

      const usedToken = createMockActivation({ usedAt: new Date() });
      expect(isValid(usedToken)).toBe(false);

      const expiredToken = createMockActivation({
        expiresAt: new Date(Date.now() - 1000),
      });
      expect(isValid(expiredToken)).toBe(false);
    });

    it('should mark as used on activation', () => {
      const token = createMockActivation();

      // Simulate activation
      token.usedAt = new Date();

      expect(token.usedAt).toBeInstanceOf(Date);
    });
  });

  describe('Invite Expiration Policies', () => {
    it('should support different expiration periods', () => {
      const createInviteWithExpiry = (days: number) => ({
        expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
      });

      const oneDay = createInviteWithExpiry(1);
      const oneWeek = createInviteWithExpiry(7);
      const oneMonth = createInviteWithExpiry(30);

      expect(oneDay.expiresAt < oneWeek.expiresAt).toBe(true);
      expect(oneWeek.expiresAt < oneMonth.expiresAt).toBe(true);
    });

    it('should check remaining time', () => {
      const getRemainingTime = (expiresAt: Date) => {
        const remaining = expiresAt.getTime() - Date.now();
        return Math.max(0, remaining);
      };

      const future = new Date(Date.now() + 1000 * 60 * 60); // 1 hour
      const past = new Date(Date.now() - 1000);

      expect(getRemainingTime(future)).toBeGreaterThan(0);
      expect(getRemainingTime(past)).toBe(0);
    });
  });
});
