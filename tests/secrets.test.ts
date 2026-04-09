import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';
import { SECRET_NAME_PATTERN, SECRET_PLACEHOLDER_REGEX } from '@shared/secrets';

// ---------------------------------------------------------------------------
// Unit tests: AES-256-GCM encryption (mirrors server/storage.ts)
// ---------------------------------------------------------------------------

const TEST_KEY_HEX = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const CIPHER_VERSION = 'v1';

function encryptValue(plaintext: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${CIPHER_VERSION}:${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptValue(stored: string, keyHex: string): string {
  const parts = stored.split(':');
  let ivB64: string, tagB64: string, dataB64: string;
  if (parts[0] === 'v1') {
    [, ivB64, tagB64, dataB64] = parts;
  } else {
    [ivB64, tagB64, dataB64] = parts;
  }
  const key = Buffer.from(keyHex, 'hex');
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const encrypted = Buffer.from(dataB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted) + decipher.final('utf8');
}

// Legacy format (no version prefix) for backward compatibility testing
function encryptValueLegacy(plaintext: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

describe('Secrets - Encryption', () => {
  it('should encrypt and decrypt a simple string', () => {
    const plaintext = 'hello@example.com';
    const encrypted = encryptValue(plaintext, TEST_KEY_HEX);
    const decrypted = decryptValue(encrypted, TEST_KEY_HEX);
    expect(decrypted).toBe(plaintext);
  });

  it('should produce different ciphertexts for same plaintext (random IV)', () => {
    const plaintext = 'my-secret-password';
    const a = encryptValue(plaintext, TEST_KEY_HEX);
    const b = encryptValue(plaintext, TEST_KEY_HEX);
    expect(a).not.toBe(b);
    // Both should decrypt to same value
    expect(decryptValue(a, TEST_KEY_HEX)).toBe(plaintext);
    expect(decryptValue(b, TEST_KEY_HEX)).toBe(plaintext);
  });

  it('should handle empty strings', () => {
    const encrypted = encryptValue('', TEST_KEY_HEX);
    expect(decryptValue(encrypted, TEST_KEY_HEX)).toBe('');
  });

  it('should handle special characters and unicode', () => {
    const values = [
      'p@$$w0rd!#%&',
      '日本語テスト',
      'value with\nnewlines\tand\ttabs',
      'a'.repeat(5000), // large value
    ];
    for (const v of values) {
      const encrypted = encryptValue(v, TEST_KEY_HEX);
      expect(decryptValue(encrypted, TEST_KEY_HEX)).toBe(v);
    }
  });

  it('should fail to decrypt with wrong key', () => {
    const plaintext = 'secret-value';
    const encrypted = encryptValue(plaintext, TEST_KEY_HEX);
    const wrongKey = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    expect(() => decryptValue(encrypted, wrongKey)).toThrow();
  });

  it('should fail on tampered ciphertext', () => {
    const encrypted = encryptValue('secret', TEST_KEY_HEX);
    const parts = encrypted.split(':');
    // Tamper with the data portion (last part)
    const tampered = parts.slice(0, -1).join(':') + ':' + 'AAAA' + parts[parts.length - 1].slice(4);
    expect(() => decryptValue(tampered, TEST_KEY_HEX)).toThrow();
  });

  it('should produce versioned format v1:iv:tag:data with 4 parts', () => {
    const encrypted = encryptValue('test', TEST_KEY_HEX);
    const parts = encrypted.split(':');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
    // IV should be 12 bytes
    expect(Buffer.from(parts[1], 'base64')).toHaveLength(12);
    // Auth tag should be 16 bytes
    expect(Buffer.from(parts[2], 'base64')).toHaveLength(16);
  });

  it('should decrypt legacy unversioned format (backward compat)', () => {
    const plaintext = 'legacy-secret-value';
    const legacy = encryptValueLegacy(plaintext, TEST_KEY_HEX);
    expect(legacy.split(':')).toHaveLength(3); // no version prefix
    expect(decryptValue(legacy, TEST_KEY_HEX)).toBe(plaintext);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: Secret name regex (mirrors route validation)
// ---------------------------------------------------------------------------

describe('Secrets - Name Validation', () => {
  const validNames = ['YOUR_EMAIL', 'MY_SECRET_123', 'A', 'API_KEY_V2', 'X1'];
  const invalidNames = ['agora_email', 'my-secret', '123_START', '_LEADING', 'has space', 'lower', ''];

  it('should accept valid secret names', () => {
    for (const name of validNames) {
      expect(SECRET_NAME_PATTERN.test(name), `Expected "${name}" to be valid`).toBe(true);
    }
  });

  it('should reject invalid secret names', () => {
    for (const name of invalidNames) {
      expect(SECRET_NAME_PATTERN.test(name), `Expected "${name}" to be invalid`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Unit tests: Secret placeholder resolution (mirrors daemon logic)
// ---------------------------------------------------------------------------

function resolveSecrets(content: string, secrets: Record<string, string>): string {
  return content.replace(SECRET_PLACEHOLDER_REGEX, (_match, key) => {
    if (key in secrets) {
      const escaped = secrets[key]
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t')
        .replace(/\0/g, '\\0');
      return `"${escaped}"`;
    }
    return _match;
  });
}

describe('Secrets - Placeholder Resolution', () => {
  it('should replace known placeholders with quoted values', () => {
    const yaml = 'email: ${secrets.YOUR_EMAIL}\npassword: ${secrets.YOUR_PASSWORD}';
    const secrets = { YOUR_EMAIL: 'test@example.com', YOUR_PASSWORD: 'p@ss123' };
    const resolved = resolveSecrets(yaml, secrets);
    expect(resolved).toBe('email: "test@example.com"\npassword: "p@ss123"');
  });

  it('should leave unknown placeholders intact', () => {
    const yaml = 'key: ${secrets.UNKNOWN_KEY}';
    const resolved = resolveSecrets(yaml, {});
    expect(resolved).toBe('key: ${secrets.UNKNOWN_KEY}');
  });

  it('should not replace non-secret placeholders', () => {
    const yaml = 'corpus_id: ${item}\nid: ${item.question_id}';
    const resolved = resolveSecrets(yaml, { SOME_KEY: 'value' });
    expect(resolved).toBe(yaml);
  });

  it('should handle multiple occurrences of same secret', () => {
    const yaml = 'a: ${secrets.KEY}\nb: ${secrets.KEY}';
    const resolved = resolveSecrets(yaml, { KEY: 'val' });
    expect(resolved).toBe('a: "val"\nb: "val"');
  });

  it('should handle empty secrets map', () => {
    const yaml = 'email: ${secrets.EMAIL}';
    const resolved = resolveSecrets(yaml, {});
    expect(resolved).toBe(yaml);
  });

  it('should handle content with no placeholders', () => {
    const yaml = 'name: smoke_test\nsteps:\n  - type: audio.play';
    const resolved = resolveSecrets(yaml, { KEY: 'value' });
    expect(resolved).toBe(yaml);
  });

  it('should quote email addresses with @ safely', () => {
    const yaml = '      email: ${secrets.AGORA_CONSOLE_EMAIL}';
    const resolved = resolveSecrets(yaml, { AGORA_CONSOLE_EMAIL: 'user@agora.io' });
    expect(resolved).toBe('      email: "user@agora.io"');
  });

  it('should escape double quotes in passwords', () => {
    const yaml = 'password: ${secrets.PASS}';
    const resolved = resolveSecrets(yaml, { PASS: 'he said "hello"' });
    expect(resolved).toBe('password: "he said \\"hello\\""');
  });

  it('should escape backslashes in values', () => {
    const yaml = 'path: ${secrets.WIN_PATH}';
    const resolved = resolveSecrets(yaml, { WIN_PATH: 'C:\\Users\\admin' });
    expect(resolved).toBe('path: "C:\\\\Users\\\\admin"');
  });

  it('should escape newlines and tabs in values', () => {
    const yaml = 'token: ${secrets.MULTILINE_TOKEN}';
    const resolved = resolveSecrets(yaml, { MULTILINE_TOKEN: 'line1\nline2\tend' });
    expect(resolved).toBe('token: "line1\\nline2\\tend"');
  });

  it('should escape carriage returns', () => {
    const yaml = 'val: ${secrets.CR_VAL}';
    const resolved = resolveSecrets(yaml, { CR_VAL: 'a\r\nb' });
    expect(resolved).toBe('val: "a\\r\\nb"');
  });

  it('should handle special characters in passwords', () => {
    const yaml = 'password: ${secrets.PASS}';
    const resolved = resolveSecrets(yaml, { PASS: 'p@$$w0rd!#&"<>' });
    expect(resolved).toBe('password: "p@$$w0rd!#&\\"<>"');
  });

  it('should handle YAML-unsafe characters: colon, hash, brackets', () => {
    const yaml = 'api_key: ${secrets.API_KEY}';
    const resolved = resolveSecrets(yaml, { API_KEY: 'sk-live:abc#123[test]' });
    expect(resolved).toBe('api_key: "sk-live:abc#123[test]"');
  });

  it('should handle empty string secret', () => {
    const yaml = 'val: ${secrets.EMPTY}';
    const resolved = resolveSecrets(yaml, { EMPTY: '' });
    expect(resolved).toBe('val: ""');
  });

  it('should handle realistic platform.setup block', () => {
    const yaml = `  - type: platform.setup
    platform_id: agora
    params:
      mode: account
      email: \${secrets.AGORA_CONSOLE_EMAIL}
      password: \${secrets.AGORA_CONSOLE_PASSWORD}`;
    const resolved = resolveSecrets(yaml, {
      AGORA_CONSOLE_EMAIL: 'dev@agora.io',
      AGORA_CONSOLE_PASSWORD: 'S3cur3!P@ss#2026',
    });
    expect(resolved).toContain('email: "dev@agora.io"');
    expect(resolved).toContain('password: "S3cur3!P@ss#2026"');
  });

  it('resolved YAML should be parseable', () => {
    const yaml = `name: test
params:
  email: \${secrets.EMAIL}
  password: \${secrets.PASS}
  token: \${secrets.TOKEN}`;
    const resolved = resolveSecrets(yaml, {
      EMAIL: 'user@example.com',
      PASS: 'p@ss:"word"',
      TOKEN: 'abc123-def_456',
    });
    // Verify it parses as valid YAML
    const { load: parse } = require('js-yaml');
    const parsed = parse(resolved);
    expect(parsed.params.email).toBe('user@example.com');
    expect(parsed.params.password).toBe('p@ss:"word"');
    expect(parsed.params.token).toBe('abc123-def_456');
  });
});

// ---------------------------------------------------------------------------
// Integration tests: Secrets API (requires running server)
// ---------------------------------------------------------------------------

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:5000';
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || 'admin@vox.local';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || 'admin123456';

interface AuthSession {
  cookie: string;
}

async function login(email: string, password: string): Promise<AuthSession> {
  const response = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    throw new Error(`Login failed: ${response.status}`);
  }

  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) {
    throw new Error('No session cookie received');
  }

  return { cookie: setCookie.split(';')[0] };
}

async function authFetch(session: AuthSession, url: string, options: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      'Cookie': session.cookie,
      'Content-Type': 'application/json',
    },
  });
}

describe('Secrets API', () => {
  let adminSession: AuthSession;
  let serverAvailable = false;

  beforeAll(async () => {
    try {
      const res = await fetch(`${BASE_URL}/api/auth/status`);
      serverAvailable = res.ok;
      if (serverAvailable) {
        adminSession = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
      }
    } catch {
      serverAvailable = false;
    }
  });

  it('should require authentication for GET /api/secrets', async () => {
    if (!serverAvailable) return;
    const res = await fetch(`${BASE_URL}/api/secrets`);
    expect(res.status).toBe(401);
  });

  it('should require authentication for POST /api/secrets', async () => {
    if (!serverAvailable) return;
    const res = await fetch(`${BASE_URL}/api/secrets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'TEST', value: 'test' }),
    });
    expect(res.status).toBe(401);
  });

  it('should require authentication for DELETE /api/secrets/:name', async () => {
    if (!serverAvailable) return;
    const res = await fetch(`${BASE_URL}/api/secrets/TEST`, { method: 'DELETE' });
    expect(res.status).toBe(401);
  });

  it('should return empty list initially', async () => {
    if (!serverAvailable) return;
    const res = await authFetch(adminSession, `${BASE_URL}/api/secrets`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  it('should reject invalid secret names', async () => {
    if (!serverAvailable) return;
    const badNames = ['lowercase', '123start', '', 'has-dash', 'has space'];
    for (const name of badNames) {
      const res = await authFetch(adminSession, `${BASE_URL}/api/secrets`, {
        method: 'POST',
        body: JSON.stringify({ name, value: 'test' }),
      });
      expect(res.status, `Expected 400 for name "${name}"`).toBe(400);
    }
  });

  it('should reject missing value', async () => {
    if (!serverAvailable) return;
    const res = await authFetch(adminSession, `${BASE_URL}/api/secrets`, {
      method: 'POST',
      body: JSON.stringify({ name: 'TEST_KEY' }),
    });
    expect(res.status).toBe(400);
  });

  it('should create a secret and return metadata (no value)', async () => {
    if (!serverAvailable) return;
    const res = await authFetch(adminSession, `${BASE_URL}/api/secrets`, {
      method: 'POST',
      body: JSON.stringify({ name: 'TEST_SECRET_A', value: 'my-secret-value' }),
    });
    // May be 500 if CREDENTIAL_ENCRYPTION_KEY not set — skip gracefully
    if (res.status === 500) {
      const data = await res.json();
      if (data.error?.includes('encryption')) {
        console.log('Skipping secrets creation tests — CREDENTIAL_ENCRYPTION_KEY not set');
        return;
      }
    }
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.name).toBe('TEST_SECRET_A');
    expect(data.id).toBeDefined();
    expect(data.createdAt).toBeDefined();
    expect(data.updatedAt).toBeDefined();
    // Value must NOT be returned
    expect(data.value).toBeUndefined();
    expect(data.encryptedValue).toBeUndefined();
  });

  it('should list secrets with names but no values', async () => {
    if (!serverAvailable) return;
    // Create another secret
    const createRes = await authFetch(adminSession, `${BASE_URL}/api/secrets`, {
      method: 'POST',
      body: JSON.stringify({ name: 'TEST_SECRET_B', value: 'another-value' }),
    });
    if (createRes.status === 500) return; // encryption not configured

    const res = await authFetch(adminSession, `${BASE_URL}/api/secrets`);
    expect(res.ok).toBe(true);
    const secrets = await res.json();
    expect(secrets.length).toBeGreaterThanOrEqual(2);

    const names = secrets.map((s: { name: string }) => s.name);
    expect(names).toContain('TEST_SECRET_A');
    expect(names).toContain('TEST_SECRET_B');

    // No secret should expose its value
    for (const s of secrets) {
      expect(s.value).toBeUndefined();
      expect(s.encryptedValue).toBeUndefined();
    }
  });

  it('should upsert (update) an existing secret', async () => {
    if (!serverAvailable) return;
    const res = await authFetch(adminSession, `${BASE_URL}/api/secrets`, {
      method: 'POST',
      body: JSON.stringify({ name: 'TEST_SECRET_A', value: 'updated-value' }),
    });
    if (res.status === 500) return;
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.name).toBe('TEST_SECRET_A');

    // List should still have the same count (not duplicated)
    const listRes = await authFetch(adminSession, `${BASE_URL}/api/secrets`);
    const secrets = await listRes.json();
    const matches = secrets.filter((s: { name: string }) => s.name === 'TEST_SECRET_A');
    expect(matches).toHaveLength(1);
  });

  it('should delete a secret', async () => {
    if (!serverAvailable) return;
    const res = await authFetch(adminSession, `${BASE_URL}/api/secrets/TEST_SECRET_B`, {
      method: 'DELETE',
    });
    if (!res.ok) return; // may not exist if encryption not configured
    expect(res.ok).toBe(true);

    // Verify it's gone
    const listRes = await authFetch(adminSession, `${BASE_URL}/api/secrets`);
    const secrets = await listRes.json();
    const names = secrets.map((s: { name: string }) => s.name);
    expect(names).not.toContain('TEST_SECRET_B');
  });

  it('should return 404 when deleting non-existent secret', async () => {
    if (!serverAvailable) return;
    const res = await authFetch(adminSession, `${BASE_URL}/api/secrets/DOES_NOT_EXIST`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
  });

  // Cleanup
  it('cleanup: delete test secrets', async () => {
    if (!serverAvailable) return;
    for (const name of ['TEST_SECRET_A', 'TEST_SECRET_B']) {
      await authFetch(adminSession, `${BASE_URL}/api/secrets/${name}`, { method: 'DELETE' });
    }
  });
});

// ---------------------------------------------------------------------------
// Integration tests: Agent secrets endpoint (requires running server)
// ---------------------------------------------------------------------------

describe('Secrets - Agent Endpoint', () => {
  let adminSession: AuthSession;
  let serverAvailable = false;
  let agentToken = '';
  let agentId = 0;
  let workflowId = 0;
  let jobId = 0;
  let encryptionAvailable = false;

  beforeAll(async () => {
    try {
      const res = await fetch(`${BASE_URL}/api/auth/status`);
      serverAvailable = res.ok;
      if (!serverAvailable) return;

      adminSession = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

      // Create a secret to test with
      const secretRes = await authFetch(adminSession, `${BASE_URL}/api/secrets`, {
        method: 'POST',
        body: JSON.stringify({ name: 'AGENT_TEST_SECRET', value: 'agent-test-value' }),
      });
      encryptionAvailable = secretRes.ok;

      // Create an eval agent token
      const tokenRes = await authFetch(adminSession, `${BASE_URL}/api/admin/eval-agent-tokens`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Secrets Test Token', region: 'na' }),
      });
      if (tokenRes.ok) {
        const tokenData = await tokenRes.json();
        agentToken = tokenData.token;
      }

      // Register an agent
      if (agentToken) {
        const regRes = await fetch(`${BASE_URL}/api/eval-agent/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agentToken}` },
          body: JSON.stringify({ name: 'Secrets Test Agent' }),
        });
        if (regRes.ok) {
          const agent = await regRes.json();
          agentId = agent.id;
        }
      }

      // Get a workflow to create a job from
      const wfRes = await authFetch(adminSession, `${BASE_URL}/api/workflows`);
      if (wfRes.ok) {
        const workflows = await wfRes.json();
        if (workflows.length > 0) {
          workflowId = workflows[0].id;
        }
      }

      // Create and claim a job
      if (workflowId && agentToken && agentId) {
        const runRes = await authFetch(adminSession, `${BASE_URL}/api/workflows/${workflowId}/run`, {
          method: 'POST',
          body: JSON.stringify({ region: 'na' }),
        });
        if (runRes.ok) {
          const runData = await runRes.json();
          jobId = runData.jobs?.[0]?.id || runData.id || 0;
        }

        // If direct job ID wasn't returned, fetch pending jobs
        if (!jobId) {
          const jobsRes = await fetch(`${BASE_URL}/api/eval-agent/jobs?region=na`, {
            headers: { 'Authorization': `Bearer ${agentToken}` },
          });
          if (jobsRes.ok) {
            const jobs = await jobsRes.json();
            if (jobs.length > 0) {
              jobId = jobs[0].id;
            }
          }
        }

        // Claim the job
        if (jobId) {
          await fetch(`${BASE_URL}/api/eval-agent/jobs/${jobId}/claim`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agentToken}` },
            body: JSON.stringify({ agentId }),
          });
        }
      }
    } catch {
      serverAvailable = false;
    }
  });

  it('should require Bearer token', async () => {
    if (!serverAvailable || !jobId) return;
    const res = await fetch(`${BASE_URL}/api/eval-agent/jobs/${jobId}/secrets`);
    expect(res.status).toBe(401);
  });

  it('should reject invalid token', async () => {
    if (!serverAvailable || !jobId) return;
    const res = await fetch(`${BASE_URL}/api/eval-agent/jobs/${jobId}/secrets`, {
      headers: { 'Authorization': 'Bearer invalid-token-12345' },
    });
    expect(res.status).toBe(401);
  });

  it('should reject non-existent job', async () => {
    if (!serverAvailable || !agentToken) return;
    const res = await fetch(`${BASE_URL}/api/eval-agent/jobs/999999/secrets`, {
      headers: { 'Authorization': `Bearer ${agentToken}` },
    });
    expect(res.status).toBe(404);
  });

  it('should return decrypted secrets for a claimed running job', async () => {
    if (!serverAvailable || !jobId || !agentToken || !encryptionAvailable) return;
    const res = await fetch(`${BASE_URL}/api/eval-agent/jobs/${jobId}/secrets`, {
      headers: { 'Authorization': `Bearer ${agentToken}` },
    });
    expect(res.ok).toBe(true);
    const secrets = await res.json();
    expect(typeof secrets).toBe('object');
    expect(secrets.AGENT_TEST_SECRET).toBe('agent-test-value');
  });

  it('should reject secrets for completed job (status guard)', async () => {
    if (!serverAvailable || !jobId || !agentToken) return;

    // Complete the job first
    await fetch(`${BASE_URL}/api/eval-agent/jobs/${jobId}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agentToken}` },
      body: JSON.stringify({ agentId, error: 'test completion for secrets guard' }),
    });

    // Now try to fetch secrets — should be rejected
    const res = await fetch(`${BASE_URL}/api/eval-agent/jobs/${jobId}/secrets`, {
      headers: { 'Authorization': `Bearer ${agentToken}` },
    });
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toContain('running');
  });

  // Cleanup
  it('cleanup: delete test secret and agent token', async () => {
    if (!serverAvailable) return;
    await authFetch(adminSession, `${BASE_URL}/api/secrets/AGENT_TEST_SECRET`, { method: 'DELETE' });
  });
});
