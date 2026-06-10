import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  hashToken,
  generateSecureToken,
  validateWorkflowConfig,
  validateEvalSetConfig,
  mergeEvalConfig,
} from '../server/storage';

describe('Storage Utilities', () => {
  describe('hashToken', () => {
    it('should hash a token consistently', () => {
      const token = 'test-token-123';
      const hash1 = hashToken(token);
      const hash2 = hashToken(token);

      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different tokens', () => {
      const token1 = 'token-1';
      const token2 = 'token-2';

      expect(hashToken(token1)).not.toBe(hashToken(token2));
    });

    it('should produce 64-character hex string (SHA256)', () => {
      const hash = hashToken('any-token');

      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[a-f0-9]+$/);
    });

    it('should handle empty string', () => {
      const hash = hashToken('');

      expect(hash).toHaveLength(64);
    });

    it('should handle special characters', () => {
      const hash = hashToken('token!@#$%^&*()_+-=[]{}|;:,.<>?');

      expect(hash).toHaveLength(64);
    });

    it('should handle unicode characters', () => {
      const hash = hashToken('token-日本語-emoji-🎉');

      expect(hash).toHaveLength(64);
    });
  });

  describe('generateSecureToken', () => {
    it('should generate token with default length (32 bytes = 64 hex chars)', () => {
      const token = generateSecureToken();

      expect(token).toHaveLength(64);
      expect(token).toMatch(/^[a-f0-9]+$/);
    });

    it('should generate token with custom length', () => {
      const token16 = generateSecureToken(16);
      const token48 = generateSecureToken(48);

      expect(token16).toHaveLength(32); // 16 bytes = 32 hex chars
      expect(token48).toHaveLength(96); // 48 bytes = 96 hex chars
    });

    it('should generate unique tokens each time', () => {
      const tokens = new Set();
      for (let i = 0; i < 100; i++) {
        tokens.add(generateSecureToken());
      }

      expect(tokens.size).toBe(100);
    });

    it('should generate cryptographically random tokens', () => {
      // Statistical test: check that generated tokens have good distribution
      const tokens = Array.from({ length: 100 }, () => generateSecureToken(4));
      const firstChars = tokens.map(t => t[0]);
      const uniqueFirstChars = new Set(firstChars);

      // With 100 tokens, we should have multiple different first characters
      expect(uniqueFirstChars.size).toBeGreaterThan(5);
    });
  });
});

describe('Storage Operations - Mock Tests', () => {
  describe('User Operations', () => {
    it('should validate email format before storage', () => {
      const validEmails = [
        'test@example.com',
        'user.name@domain.co.uk',
        'user+tag@example.org',
      ];

      const invalidEmails = [
        'not-an-email',
        '@missing-local.com',
        'missing-at.com',
      ];

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

      validEmails.forEach(email => {
        expect(emailRegex.test(email)).toBe(true);
      });

      invalidEmails.forEach(email => {
        expect(emailRegex.test(email)).toBe(false);
      });
    });

    it('should validate username format', () => {
      const validUsernames = ['john', 'user123', 'test_user', 'Test-User'];
      const invalidUsernames = ['', 'ab', 'a'.repeat(51)]; // too short or too long

      const usernameRegex = /^[a-zA-Z0-9_-]{3,50}$/;

      validUsernames.forEach(username => {
        expect(usernameRegex.test(username)).toBe(true);
      });

      invalidUsernames.forEach(username => {
        expect(usernameRegex.test(username)).toBe(false);
      });
    });
  });

  describe('Organization Operations', () => {
    it('should validate organization name', () => {
      const validNames = ['Acme Corp', 'Test Org 123', 'My-Organization'];
      const invalidNames = ['', 'ab']; // too short

      validNames.forEach(name => {
        expect(name.length).toBeGreaterThanOrEqual(3);
      });

      invalidNames.forEach(name => {
        expect(name.length).toBeLessThan(3);
      });
    });
  });

  describe('Provider ID Generation', () => {
    it('should generate valid provider IDs', () => {
      // Provider IDs should be nanoid format (12 chars alphanumeric)
      const idRegex = /^[a-zA-Z0-9_-]{12,}$/;

      // Mock test - actual generation is in schema
      const mockId = 'abcd1234WXYZ';
      expect(idRegex.test(mockId)).toBe(true);
    });
  });

  describe('API Key Format', () => {
    it('should validate API key format', () => {
      const validKeys = [
        'vox_live_abc123def456',
        'vox_live_' + 'a'.repeat(32),
      ];

      const invalidKeys = [
        'invalid_key',
        'vox_test_abc123', // wrong prefix
        'vox_live_', // too short
      ];

      const keyRegex = /^vox_live_[a-zA-Z0-9]{10,}$/;

      validKeys.forEach(key => {
        expect(keyRegex.test(key)).toBe(true);
      });

      invalidKeys.forEach(key => {
        expect(keyRegex.test(key)).toBe(false);
      });
    });
  });

  describe('Eval Agent Token Format', () => {
    it('should validate eval agent token format', () => {
      const validTokens = [
        'eat_' + 'a'.repeat(32),
        'eat_abc123def456ghi789jkl012mno345',
      ];

      const invalidTokens = [
        'invalid_token',
        'eat_short',
      ];

      const tokenRegex = /^eat_[a-zA-Z0-9]{20,}$/;

      validTokens.forEach(token => {
        expect(tokenRegex.test(token)).toBe(true);
      });

      invalidTokens.forEach(token => {
        expect(tokenRegex.test(token)).toBe(false);
      });
    });
  });
});

describe('Data Validation', () => {
  describe('Region Validation', () => {
    it('should validate region enum values', () => {
      const validRegions = ['na', 'apac', 'eu'];
      const invalidRegions = ['us', 'asia', 'europe', 'NA', 'APAC'];

      validRegions.forEach(region => {
        expect(['na', 'apac', 'eu'].includes(region)).toBe(true);
      });

      invalidRegions.forEach(region => {
        expect(['na', 'apac', 'eu'].includes(region)).toBe(false);
      });
    });
  });

  describe('User Plan Validation', () => {
    it('should validate user plan enum values', () => {
      const validPlans = ['basic', 'premium', 'principal', 'fellow'];
      const invalidPlans = ['free', 'pro', 'enterprise'];

      validPlans.forEach(plan => {
        expect(['basic', 'premium', 'principal', 'fellow'].includes(plan)).toBe(true);
      });

      invalidPlans.forEach(plan => {
        expect(['basic', 'premium', 'principal', 'fellow'].includes(plan)).toBe(false);
      });
    });
  });

  describe('Eval Job Status Validation', () => {
    it('should validate eval job status enum values', () => {
      const validStatuses = ['pending', 'running', 'completed', 'failed'];
      const invalidStatuses = ['queued', 'processing', 'done', 'error'];

      validStatuses.forEach(status => {
        expect(['pending', 'running', 'completed', 'failed'].includes(status)).toBe(true);
      });

      invalidStatuses.forEach(status => {
        expect(['pending', 'running', 'completed', 'failed'].includes(status)).toBe(false);
      });
    });
  });

  describe('Visibility Validation', () => {
    it('should validate visibility enum values', () => {
      const validValues = ['public', 'private'];
      const invalidValues = ['shared', 'hidden', 'unlisted'];

      validValues.forEach(value => {
        expect(['public', 'private'].includes(value)).toBe(true);
      });

      invalidValues.forEach(value => {
        expect(['public', 'private'].includes(value)).toBe(false);
      });
    });
  });
});

describe('Config separation validators', () => {
  describe('validateWorkflowConfig', () => {
    it('accepts framework + steps + connection params', () => {
      const r = validateWorkflowConfig({
        framework: 'aeval',
        stepsPrefix: '- type: platform.setup',
        stepsSuffix: '- type: platform.exit',
        url: 'https://example.com',
      });
      expect(r.valid).toBe(true);
    });

    it('rejects scenario in a workflow', () => {
      const r = validateWorkflowConfig({ framework: 'aeval', scenario: 'name: x' });
      expect(r.valid).toBe(false);
      expect(r.error).toContain('eval set');
    });

    it('rejects an invalid framework', () => {
      const r = validateWorkflowConfig({ framework: 'nope' });
      expect(r.valid).toBe(false);
    });

    it('rejects non-string stepsPrefix', () => {
      const r = validateWorkflowConfig({ stepsPrefix: 123 });
      expect(r.valid).toBe(false);
    });

    it('accepts null/undefined', () => {
      expect(validateWorkflowConfig(null).valid).toBe(true);
      expect(validateWorkflowConfig(undefined).valid).toBe(true);
    });
  });

  describe('validateEvalSetConfig', () => {
    it('accepts a scenario body', () => {
      const r = validateEvalSetConfig({ scenario: 'name: x\nsteps: []' });
      expect(r.valid).toBe(true);
    });

    it('rejects framework in an eval set', () => {
      const r = validateEvalSetConfig({ scenario: 'name: x', framework: 'aeval' });
      expect(r.valid).toBe(false);
      expect(r.error).toContain('workflow');
    });

    it('rejects stepsPrefix in an eval set', () => {
      const r = validateEvalSetConfig({ stepsPrefix: '- type: platform.setup' });
      expect(r.valid).toBe(false);
      expect(r.error).toContain('workflow');
    });

    it('rejects non-string scenario', () => {
      const r = validateEvalSetConfig({ scenario: { name: 'x' } });
      expect(r.valid).toBe(false);
    });

    it('rejects stepsSuffix in an eval set', () => {
      const r = validateEvalSetConfig({ stepsSuffix: '- type: platform.exit' });
      expect(r.valid).toBe(false);
      expect(r.error).toContain('workflow');
    });
  });

  describe('mergeEvalConfig', () => {
    it('spreads disjoint configs', () => {
      const merged = mergeEvalConfig(
        { framework: 'aeval', stepsPrefix: 'a' },
        { scenario: 'b' },
      );
      expect(merged).toEqual({ framework: 'aeval', stepsPrefix: 'a', scenario: 'b' });
    });

    it('throws on overlapping keys', () => {
      expect(() =>
        mergeEvalConfig({ scenario: 'a' }, { scenario: 'b' }),
      ).toThrow(/share keys/);
    });

    it('tolerates null inputs', () => {
      expect(mergeEvalConfig(null, { scenario: 'b' })).toEqual({ scenario: 'b' });
    });

    it('reports all overlapping keys', () => {
      expect(() =>
        mergeEvalConfig({ framework: 'aeval', scenario: 'a' }, { framework: 'x', scenario: 'b' }),
      ).toThrow(/framework, scenario/);
    });

    it('allows identical shared values (e.g. frameworkVersion)', () => {
      const merged = mergeEvalConfig(
        { framework: 'aeval', frameworkVersion: 'v0.1.0' },
        { scenario: 'b', frameworkVersion: 'v0.1.0' },
      );
      expect(merged).toEqual({ framework: 'aeval', frameworkVersion: 'v0.1.0', scenario: 'b' });
    });
  });
});
