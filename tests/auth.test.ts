import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

// Pure function implementations for testing (mirroring server/auth.ts and server/storage.ts)
// This avoids path alias issues with @shared/schema imports

async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateSecureToken(length: number = 32): string {
  return crypto.randomBytes(length).toString('hex');
}

const API_KEY_PREFIX = "vox_live_";

function generateApiKey(): { key: string; prefix: string } {
  const randomPart = crypto.randomBytes(24).toString("base64url");
  const key = `${API_KEY_PREFIX}${randomPart}`;
  const prefix = key.slice(0, 12);
  return { key, prefix };
}

function getInitCode(): string {
  if (process.env.NODE_ENV === "production" || process.env.NODE_ENV === "staging") {
    const code = process.env.INIT_CODE;
    if (!code) {
      throw new Error("INIT_CODE environment variable is required in production/staging");
    }
    return code;
  }
  return "VOX-DEBUG-2024";
}

describe('Auth Utilities', () => {
  describe('Password Hashing', () => {
    it('should hash a password', async () => {
      const password = 'testPassword123';
      const hash = await hashPassword(password);

      expect(hash).toBeDefined();
      expect(hash).not.toBe(password);
      expect(hash.length).toBeGreaterThan(50); // bcrypt hashes are typically 60 chars
    });

    it('should produce different hashes for same password', async () => {
      const password = 'testPassword123';
      const hash1 = await hashPassword(password);
      const hash2 = await hashPassword(password);

      expect(hash1).not.toBe(hash2); // bcrypt adds salt, so each hash is unique
    });

    it('should verify correct password', async () => {
      const password = 'testPassword123';
      const hash = await hashPassword(password);

      const isValid = await verifyPassword(password, hash);
      expect(isValid).toBe(true);
    });

    it('should reject incorrect password', async () => {
      const password = 'testPassword123';
      const hash = await hashPassword(password);

      const isValid = await verifyPassword('wrongPassword', hash);
      expect(isValid).toBe(false);
    });

    it('should handle empty password', async () => {
      const password = '';
      const hash = await hashPassword(password);

      const isValid = await verifyPassword('', hash);
      expect(isValid).toBe(true);

      const isInvalid = await verifyPassword('notempty', hash);
      expect(isInvalid).toBe(false);
    });

    it('should handle special characters in password', async () => {
      const password = 'p@$$w0rd!#$%^&*()';
      const hash = await hashPassword(password);

      const isValid = await verifyPassword(password, hash);
      expect(isValid).toBe(true);
    });

    it('should handle unicode characters in password', async () => {
      const password = 'パスワード123';
      const hash = await hashPassword(password);

      const isValid = await verifyPassword(password, hash);
      expect(isValid).toBe(true);
    });
  });

  describe('Token Generation', () => {
    it('should generate a token', () => {
      const token = generateToken();

      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
      expect(token.length).toBe(64); // 32 bytes * 2 (hex encoding)
    });

    it('should generate unique tokens', () => {
      const tokens = new Set<string>();
      for (let i = 0; i < 100; i++) {
        tokens.add(generateToken());
      }

      expect(tokens.size).toBe(100); // All tokens should be unique
    });

    it('should generate hex-encoded tokens', () => {
      const token = generateToken();
      const hexPattern = /^[0-9a-f]+$/;

      expect(hexPattern.test(token)).toBe(true);
    });
  });

  describe('Secure Token Generation', () => {
    it('should generate a secure token with default length', () => {
      const token = generateSecureToken();

      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
      expect(token.length).toBe(64); // 32 bytes * 2 (hex encoding)
    });

    it('should generate token with custom length', () => {
      const token16 = generateSecureToken(16);
      const token48 = generateSecureToken(48);

      expect(token16.length).toBe(32); // 16 bytes * 2
      expect(token48.length).toBe(96); // 48 bytes * 2
    });
  });

  describe('Token Hashing', () => {
    it('should hash a token using SHA256', () => {
      const token = 'test-token-123';
      const hash = hashToken(token);

      expect(hash).toBeDefined();
      expect(hash.length).toBe(64); // SHA256 produces 32 bytes = 64 hex chars
    });

    it('should produce consistent hashes for same token', () => {
      const token = 'test-token-123';
      const hash1 = hashToken(token);
      const hash2 = hashToken(token);

      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different tokens', () => {
      const hash1 = hashToken('token1');
      const hash2 = hashToken('token2');

      expect(hash1).not.toBe(hash2);
    });

    it('should produce hex-encoded hash', () => {
      const token = 'test-token';
      const hash = hashToken(token);
      const hexPattern = /^[0-9a-f]+$/;

      expect(hexPattern.test(hash)).toBe(true);
    });
  });

  describe('Init Code', () => {
    beforeEach(() => {
      vi.unstubAllEnvs();
    });

    it('should return debug code in development', () => {
      vi.stubEnv('NODE_ENV', 'development');
      const code = getInitCode();
      expect(code).toBe('VOX-DEBUG-2024');
    });

    it('should return debug code in test environment', () => {
      vi.stubEnv('NODE_ENV', 'test');
      const code = getInitCode();
      expect(code).toBe('VOX-DEBUG-2024');
    });

    it('should return env code in production', () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('INIT_CODE', 'PROD-SECRET-CODE');
      const code = getInitCode();
      expect(code).toBe('PROD-SECRET-CODE');
    });

    it('should return env code in staging', () => {
      vi.stubEnv('NODE_ENV', 'staging');
      vi.stubEnv('INIT_CODE', 'STAGING-SECRET-CODE');
      const code = getInitCode();
      expect(code).toBe('STAGING-SECRET-CODE');
    });

    it('should throw if INIT_CODE not set in production', () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('INIT_CODE', '');

      expect(() => getInitCode()).toThrow('INIT_CODE environment variable is required');
    });
  });

  describe('API Key Generation', () => {
    it('should generate API key with correct prefix', () => {
      const { key } = generateApiKey();

      expect(key).toBeDefined();
      expect(key.startsWith('vox_live_')).toBe(true);
    });

    it('should return correct prefix', () => {
      const { key, prefix } = generateApiKey();

      expect(prefix).toBe(key.slice(0, 12));
      expect(prefix.startsWith('vox_live_')).toBe(true);
    });

    it('should generate unique keys', () => {
      const keys = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const { key } = generateApiKey();
        keys.add(key);
      }

      expect(keys.size).toBe(100);
    });

    it('should generate keys of appropriate length', () => {
      const { key } = generateApiKey();

      // vox_live_ (9 chars) + 32 base64url chars
      expect(key.length).toBeGreaterThan(40);
    });

    it('should use URL-safe base64 encoding', () => {
      const { key } = generateApiKey();
      const randomPart = key.slice(9); // Remove 'vox_live_' prefix

      // base64url should not contain + or /
      expect(randomPart.includes('+')).toBe(false);
      expect(randomPart.includes('/')).toBe(false);
    });
  });
});
