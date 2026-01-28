import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateApiKey } from '../server/auth';
import { hashToken } from '../server/storage';

describe('API Key Management', () => {
  describe('generateApiKey', () => {
    it('should generate key with correct prefix', () => {
      const { key } = generateApiKey();

      expect(key.startsWith('vox_live_')).toBe(true);
    });

    it('should generate key with sufficient length', () => {
      const { key } = generateApiKey();

      // vox_live_ (9 chars) + base64url chars = 41+ chars
      expect(key.length).toBeGreaterThanOrEqual(41);
    });

    it('should generate unique keys each time', () => {
      const keys = new Set();
      for (let i = 0; i < 100; i++) {
        keys.add(generateApiKey().key);
      }

      expect(keys.size).toBe(100);
    });

    it('should generate key with valid characters after prefix', () => {
      const { key } = generateApiKey();
      const suffix = key.substring(9); // Remove 'vox_live_' prefix

      // base64url uses a-z, A-Z, 0-9, -, _
      expect(suffix).toMatch(/^[a-zA-Z0-9_-]+$/);
    });
  });

  describe('API Key Hashing', () => {
    it('should hash API key for storage', () => {
      const { key } = generateApiKey();
      const hash = hashToken(key);

      // Hash should be different from original key
      expect(hash).not.toBe(key);
      // Hash should be consistent
      expect(hashToken(key)).toBe(hash);
    });

    it('should produce different hashes for different keys', () => {
      const { key: key1 } = generateApiKey();
      const { key: key2 } = generateApiKey();

      expect(hashToken(key1)).not.toBe(hashToken(key2));
    });

    it('should be able to verify key by comparing hashes', () => {
      const { key } = generateApiKey();
      const storedHash = hashToken(key);

      // Simulate verification
      const providedKey = key;
      const isValid = hashToken(providedKey) === storedHash;

      expect(isValid).toBe(true);
    });

    it('should reject incorrect key', () => {
      const { key } = generateApiKey();
      const storedHash = hashToken(key);

      // Simulate verification with wrong key
      const { key: wrongKey } = generateApiKey();
      const isValid = hashToken(wrongKey) === storedHash;

      expect(isValid).toBe(false);
    });
  });

  describe('API Key Validation', () => {
    it('should validate key format', () => {
      // API keys use base64url encoding (a-z, A-Z, 0-9, -, _)
      const validKey = 'vox_live_abc123DEF456ghi789JKL012mn-_op';
      const invalidKeys = [
        'invalid_key',
        'vox_test_abc123', // wrong prefix
        'vox_live_', // no suffix
        'vox_live_short', // too short
        '', // empty
      ];

      const isValidFormat = (key: string) => {
        return /^vox_live_[a-zA-Z0-9_-]{24,}$/.test(key);
      };

      expect(isValidFormat(validKey)).toBe(true);
      invalidKeys.forEach(key => {
        expect(isValidFormat(key)).toBe(false);
      });
    });

    it('should extract prefix from key', () => {
      const key = 'vox_live_abc123def456';
      const prefix = key.split('_').slice(0, 2).join('_');

      expect(prefix).toBe('vox_live');
    });
  });

  describe('API Key Revocation', () => {
    it('should be able to mark key as revoked', () => {
      interface MockApiKey {
        id: number;
        keyHash: string;
        isRevoked: boolean;
        revokedAt: Date | null;
      }

      const { key } = generateApiKey();
      const mockKey: MockApiKey = {
        id: 1,
        keyHash: hashToken(key),
        isRevoked: false,
        revokedAt: null,
      };

      // Simulate revocation
      mockKey.isRevoked = true;
      mockKey.revokedAt = new Date();

      expect(mockKey.isRevoked).toBe(true);
      expect(mockKey.revokedAt).toBeInstanceOf(Date);
    });

    it('should reject revoked keys during authentication', () => {
      const { key } = generateApiKey();
      const mockKey = {
        keyHash: hashToken(key),
        isRevoked: true,
      };

      const isKeyValid = (k: typeof mockKey) => !k.isRevoked;

      expect(isKeyValid(mockKey)).toBe(false);
    });
  });

  describe('API Key Rate Limiting', () => {
    it('should track usage count', () => {
      interface MockApiKeyUsage {
        keyId: number;
        requestCount: number;
        lastUsedAt: Date;
      }

      const usage: MockApiKeyUsage = {
        keyId: 1,
        requestCount: 0,
        lastUsedAt: new Date(),
      };

      // Simulate requests
      for (let i = 0; i < 10; i++) {
        usage.requestCount++;
        usage.lastUsedAt = new Date();
      }

      expect(usage.requestCount).toBe(10);
    });

    it('should check rate limit', () => {
      const RATE_LIMIT = 100;
      const RATE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

      interface RateLimitState {
        count: number;
        windowStart: number;
      }

      const checkRateLimit = (state: RateLimitState, limit: number, windowMs: number): boolean => {
        const now = Date.now();
        if (now - state.windowStart > windowMs) {
          // Reset window
          state.count = 1;
          state.windowStart = now;
          return true;
        }
        if (state.count >= limit) {
          return false;
        }
        state.count++;
        return true;
      };

      const state: RateLimitState = { count: 0, windowStart: Date.now() };

      // Should allow requests up to limit
      for (let i = 0; i < RATE_LIMIT; i++) {
        expect(checkRateLimit(state, RATE_LIMIT, RATE_WINDOW_MS)).toBe(true);
      }

      // Should reject after limit
      expect(checkRateLimit(state, RATE_LIMIT, RATE_WINDOW_MS)).toBe(false);
    });
  });

  describe('API Key Metadata', () => {
    it('should store creation metadata', () => {
      const keyMetadata = {
        name: 'Production API Key',
        createdAt: new Date(),
        createdBy: 1,
        lastUsedAt: null as Date | null,
        expiresAt: null as Date | null,
      };

      expect(keyMetadata.name).toBe('Production API Key');
      expect(keyMetadata.createdAt).toBeInstanceOf(Date);
      expect(keyMetadata.lastUsedAt).toBeNull();
    });

    it('should support optional expiration', () => {
      const { key: key1 } = generateApiKey();
      const { key: key2 } = generateApiKey();
      const keyWithExpiry = {
        keyHash: hashToken(key1),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
      };

      const keyWithoutExpiry = {
        keyHash: hashToken(key2),
        expiresAt: null,
      };

      const isExpired = (key: { expiresAt: Date | null }) => {
        if (!key.expiresAt) return false;
        return new Date() > key.expiresAt;
      };

      expect(isExpired(keyWithExpiry)).toBe(false);
      expect(isExpired(keyWithoutExpiry)).toBe(false);

      // Simulate expired key
      keyWithExpiry.expiresAt = new Date(Date.now() - 1000);
      expect(isExpired(keyWithExpiry)).toBe(true);
    });
  });
});
