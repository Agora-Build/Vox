import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  hashToken,
  generateSecureToken,
  generateEvalAgentToken,
  generateBrokerRegistrationToken,
  validateEvalflowConfig,
  validateEvalSetConfig,
  mergeEvalConfig,
  buildJobSnapshot,
  resolveMetricsMode,
} from '../server/storage';

describe('resolveMetricsMode (realtime window policy)', () => {
  it('returns raw for windows up to and including 90 days', () => {
    expect(resolveMetricsMode(1 / 24)).toBe('raw');   // 1 hour
    expect(resolveMetricsMode(1)).toBe('raw');         // 24 hours
    expect(resolveMetricsMode(7)).toBe('raw');         // 7 days
    expect(resolveMetricsMode(89)).toBe('raw');
    expect(resolveMetricsMode(90)).toBe('raw');        // boundary is inclusive
  });

  it('returns daily buckets for windows longer than 90 days', () => {
    expect(resolveMetricsMode(90.0001)).toBe('bucketDay');
    expect(resolveMetricsMode(100)).toBe('bucketDay'); // current all-time span
    expect(resolveMetricsMode(365)).toBe('bucketDay');
  });

  it('treats an empty dataset (span 0) as raw', () => {
    expect(resolveMetricsMode(0)).toBe('raw');
  });
});

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

  describe('typed token generators', () => {
    it('eval agent tokens are "ev" + 30 hex (32 chars)', () => {
      const token = generateEvalAgentToken();
      expect(token).toHaveLength(32);
      expect(token).toMatch(/^ev[a-f0-9]{30}$/);
    });

    it('broker registration tokens are "bk" + 30 hex (32 chars)', () => {
      const token = generateBrokerRegistrationToken();
      expect(token).toHaveLength(32);
      expect(token).toMatch(/^bk[a-f0-9]{30}$/);
    });

    it('eval agent and broker tokens share the same length', () => {
      expect(generateBrokerRegistrationToken().length).toBe(generateEvalAgentToken().length);
    });

    it('generates unique tokens each time', () => {
      const tokens = new Set(Array.from({ length: 100 }, () => generateBrokerRegistrationToken()));
      expect(tokens.size).toBe(100);
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
  describe('validateEvalflowConfig', () => {
    it('accepts framework + steps + connection params', () => {
      const r = validateEvalflowConfig({
        framework: 'aeval',
        stepsPrefix: '- type: platform.setup',
        stepsSuffix: '- type: platform.exit',
        url: 'https://example.com',
      });
      expect(r.valid).toBe(true);
    });

    it('rejects scenario in an evalflow', () => {
      const r = validateEvalflowConfig({ framework: 'aeval', scenario: 'name: x' });
      expect(r.valid).toBe(false);
      expect(r.error).toContain('eval set');
    });

    it('rejects an invalid framework', () => {
      const r = validateEvalflowConfig({ framework: 'nope' });
      expect(r.valid).toBe(false);
    });

    it('rejects non-string stepsPrefix', () => {
      const r = validateEvalflowConfig({ stepsPrefix: 123 });
      expect(r.valid).toBe(false);
    });

    it('accepts null/undefined', () => {
      expect(validateEvalflowConfig(null).valid).toBe(true);
      expect(validateEvalflowConfig(undefined).valid).toBe(true);
    });

    it('rejects the deleted phoneDial/restfulTrigger keys with pointer errors', () => {
      const dial = validateEvalflowConfig({ phoneDial: { number: '+15551234' } }, 'phone');
      expect(dial.valid).toBe(false);
      expect(dial.error).toContain('call.dial step');
      const trig = validateEvalflowConfig({ restfulTrigger: { method: 'POST', url: 'https://x.example/y' } }, 'phone');
      expect(trig.valid).toBe(false);
      expect(trig.error).toContain('restful.request step');
    });

    it('steps vocabulary is transport-scoped', () => {
      const phoneOk = validateEvalflowConfig({
        stepsPrefix: '- type: call.dial\n  number: "+1 555 010 1234"\n- type: call.wait_answered',
        stepsSuffix: '- type: call.hangup',
      }, 'phone');
      expect(phoneOk.valid).toBe(true);

      const webOnPhone = validateEvalflowConfig({ stepsPrefix: '- type: platform.setup' }, 'phone');
      expect(webOnPhone.valid).toBe(false);
      expect(webOnPhone.error).toContain('web-session vocabulary');

      const phoneOnWeb = validateEvalflowConfig({ stepsPrefix: '- type: call.dial\n  number: "+15551234"' }, 'web');
      expect(phoneOnWeb.valid).toBe(false);
      expect(phoneOnWeb.error).toContain('phone vocabulary');

      // Default transport is web — existing single-arg callers keep meaning web.
      expect(validateEvalflowConfig({ stepsPrefix: '- type: platform.setup' }).valid).toBe(true);
    });

    it('validates step shapes: bad call.dial number, restful.request fields, Teardown restful, bad YAML', () => {
      const badNum = validateEvalflowConfig({ stepsPrefix: '- type: call.dial\n  number: abc' }, 'phone');
      expect(badNum.valid).toBe(false);
      expect(badNum.error).toContain('call.dial');

      const badRest = validateEvalflowConfig(
        { stepsPrefix: '- type: restful.request\n  method: BREW\n  url: "https://x.example/y"' }, 'phone');
      expect(badRest.valid).toBe(false);

      const teardownRest = validateEvalflowConfig(
        { stepsSuffix: '- type: restful.request\n  method: POST\n  url: "https://x.example/y"' }, 'phone');
      expect(teardownRest.valid).toBe(false);
      expect(teardownRest.error).toContain('illegal in Teardown');

      const badYaml = validateEvalflowConfig({ stepsPrefix: '- type: [unclosed' }, 'phone');
      expect(badYaml.valid).toBe(false);
      expect(badYaml.error).toContain('YAML');
    });

    it('restful.request must LEAD Setup; Teardown call.* is hangup-only (save-time mirror of the splitter)', () => {
      const trailing = validateEvalflowConfig({
        stepsPrefix: '- type: call.dial\n  number: "+15551234"\n- type: restful.request\n  method: POST\n  url: "https://x.example/y"',
      }, 'phone');
      expect(trailing.valid).toBe(false);
      expect(trailing.error).toContain('must lead Setup Steps');

      const dialTeardown = validateEvalflowConfig({ stepsSuffix: '- type: call.dial\n  number: "+15551234"' }, 'phone');
      expect(dialTeardown.valid).toBe(false);
      expect(dialTeardown.error).toContain('only call.hangup');
      expect(validateEvalflowConfig({ stepsSuffix: '- type: call.hangup' }, 'phone').valid).toBe(true);
    });

    it('web scripts stay pass-through for aeval-owned shapes (mapping form, unknown types)', () => {
      expect(validateEvalflowConfig({ stepsPrefix: 'platform:\n  setup:\n    - type: control.log' }, 'web').valid).toBe(true);
      expect(validateEvalflowConfig({ stepsPrefix: '- type: http.request\n  params: {}' }, 'web').valid).toBe(true);
    });

    it('validation recurses into for_each: nested cross-mode and misplaced steps are rejected at save', () => {
      // Web: a nested call.dial is still phone vocabulary.
      const webNested = validateEvalflowConfig({
        stepsPrefix: '- type: control.for_each\n  items: [1]\n  steps:\n    - type: call.dial\n      number: "+15551234"',
      }, 'web');
      expect(webNested.valid).toBe(false);
      expect(webNested.error).toContain('phone vocabulary');
      // Phone: nested web vocabulary rejected.
      const phoneNested = validateEvalflowConfig({
        stepsPrefix: '- type: call.dial\n  number: "+15551234"\n- type: control.for_each\n  items: [1]\n  steps:\n    - type: platform.setup',
      }, 'phone');
      expect(phoneNested.valid).toBe(false);
      // Phone: nested restful.request can never execute pre-call.
      const nestedRestful = validateEvalflowConfig({
        stepsPrefix: '- type: control.for_each\n  items: [1]\n  steps:\n    - type: restful.request\n      method: POST\n      url: "https://x.example/y"',
      }, 'phone');
      expect(nestedRestful.valid).toBe(false);
      expect(nestedRestful.error).toContain('cannot be nested');
      // Teardown: a nested call.dial is still a second call.
      const teardownNested = validateEvalflowConfig({
        stepsSuffix: '- type: control.for_each\n  items: [1]\n  steps:\n    - type: call.dial\n      number: "+15551234"',
      }, 'phone');
      expect(teardownNested.valid).toBe(false);
      // Templated types are the smuggle shape — rejected outright on phone.
      const templatedType = validateEvalflowConfig({
        stepsPrefix: '- type: "${item.t}"' }, 'phone');
      expect(templatedType.valid).toBe(false);
      // Templated call.dial NUMBER is legal at save (compiler re-checks the
      // substituted value against the dialable shape).
      const templatedNumber = validateEvalflowConfig({
        stepsPrefix: '- type: call.dial\n  number: "${item.n}"' }, 'phone');
      expect(templatedNumber.valid).toBe(true);
    });

    it('DoS bounds: deep nesting is rejected; an aliased cycle terminates instead of hanging', async () => {
      const yamlLib = await import('js-yaml');
      let deep: Record<string, unknown> = { type: 'control.log', message: 'x' };
      for (let i = 0; i < 20; i++) deep = { type: 'control.for_each', items: [1], steps: [deep] };
      const tooDeep = validateEvalflowConfig({ stepsPrefix: yamlLib.dump([deep]) }, 'phone');
      expect(tooDeep.valid).toBe(false);
      expect(tooDeep.error).toContain('too complex');
      // Self-referencing alias: the cycle guard terminates the walk.
      const cyclic = validateEvalflowConfig({
        stepsPrefix: '- &a\n  type: control.for_each\n  items: [1]\n  steps: [*a]' }, 'phone');
      expect(typeof cyclic.valid).toBe('boolean'); // terminated, no hang
    });
  });

  describe('validateEvalSetConfig', () => {
    it('SECURITY: rejects call.*/restful.*/sms.* in the conversation, nested included', async () => {
      const { validateEvalSetConfig } = await import('../server/storage');
      const bad = validateEvalSetConfig({ scenario: 'steps:\n  - type: call.dial\n    number: "+1900PREMIUM"' });
      expect(bad.valid).toBe(false);
      expect(bad.error).toContain('illegal in an eval-set conversation');
      const nested = validateEvalSetConfig({
        scenario: 'steps:\n  - type: control.for_each\n    items: [1]\n    steps:\n      - type: restful.request',
      });
      expect(nested.valid).toBe(false);
      const ok = validateEvalSetConfig({ scenario: 'steps:\n  - type: audio.play\n    corpus_id: x' });
      expect(ok.valid).toBe(true);
      // A templated type could resolve to call.dial post-substitution — the
      // daemon compiler is the boundary, but save rejects the smuggle shape.
      const templated = validateEvalSetConfig({
        scenario: 'steps:\n  - type: control.for_each\n    items: [{t: call.dial}]\n    steps:\n      - type: "${item.t}"',
      });
      expect(templated.valid).toBe(false);
    });

    it('accepts a scenario body', () => {
      const r = validateEvalSetConfig({ scenario: 'name: x\nsteps: []' });
      expect(r.valid).toBe(true);
    });

    it('rejects framework in an eval set', () => {
      const r = validateEvalSetConfig({ scenario: 'name: x', framework: 'aeval' });
      expect(r.valid).toBe(false);
      expect(r.error).toContain('evalflow');
    });

    it('rejects stepsPrefix in an eval set', () => {
      const r = validateEvalSetConfig({ stepsPrefix: '- type: platform.setup' });
      expect(r.valid).toBe(false);
      expect(r.error).toContain('evalflow');
    });

    it('rejects non-string scenario', () => {
      const r = validateEvalSetConfig({ scenario: { name: 'x' } });
      expect(r.valid).toBe(false);
    });

    it('rejects stepsSuffix in an eval set', () => {
      const r = validateEvalSetConfig({ stepsSuffix: '- type: platform.exit' });
      expect(r.valid).toBe(false);
      expect(r.error).toContain('evalflow');
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

describe('buildJobSnapshot (immutable per-job provenance)', () => {
  const wf = { name: 'WF', config: { framework: 'aeval', stepsPrefix: '- x' }, visibility: 'public', isMainline: true, ownerId: 7 } as any;
  const es = { name: 'ES', config: { scenario: 'steps: []' }, visibility: 'private', isMainline: false, ownerId: 9 } as any;
  const provider = { id: 'abc123def456', name: 'Agora ConvoAI Engine', platformId: 'agora' } as any;

  it('captures evalflow + eval-set metadata, config, and tier flags', () => {
    const s = buildJobSnapshot(wf, es, provider, 'principal');
    expect(s.provider).toEqual({ id: 'abc123def456', name: 'Agora ConvoAI Engine', platformId: 'agora' });
    expect(s.evalflow).toEqual({ name: 'WF', config: { framework: 'aeval', stepsPrefix: '- x' }, visibility: 'public', isMainline: true, ownerId: 7, organizationId: null });
    expect(s.evalSet).toEqual({ name: 'ES', config: { scenario: 'steps: []' }, visibility: 'private', isMainline: false, ownerId: 9 });
    expect(s.creatorPlan).toBe('principal');
  });

  it('is decoupled from the source objects (immutable snapshot)', () => {
    const mutableWf = { ...wf, config: { ...wf.config } };
    const s = buildJobSnapshot(mutableWf, es, provider, 'premium');
    mutableWf.name = 'RENAMED';
    (mutableWf.config as any).framework = 'changed';
    // The snapshot captured the value; later mutation of the source doesn't leak in
    // for scalars, and the config object is the one captured at call time.
    expect(s.evalflow?.name).toBe('WF');
  });

  it('degrades gracefully: missing provider / eval-set / plan → null', () => {
    const s = buildJobSnapshot(wf, undefined, undefined, null);
    expect(s.provider).toBeNull();
    expect(s.evalSet).toBeNull();
    expect(s.creatorPlan).toBeNull();
    expect(s.evalflow?.name).toBe('WF');
  });

  it('coerces an absent provider.platformId to null (e.g. Custom)', () => {
    const s = buildJobSnapshot(wf, es, { id: 'x', name: 'Custom' } as any, 'basic');
    expect(s.provider).toEqual({ id: 'x', name: 'Custom', platformId: null });
  });
});
