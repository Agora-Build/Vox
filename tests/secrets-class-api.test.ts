import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BASE_NA } from './helpers/regions';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:5000';
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || 'admin@vox.local';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || 'admin123456';

interface AuthSession {
  cookie: string;
}

interface SecretEntry {
  id: number;
  name: string;
  class: string;
  isTestAccount: boolean;
  createdAt: string;
  updatedAt: string;
}

interface SecretsResponse {
  encryptionConfigured: boolean;
  secrets: SecretEntry[];
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

describe('Secrets class + attestation API', () => {
  let adminSession: AuthSession;
  const stamp = Date.now();
  const loginName = `API_LOGIN_${stamp}`;
  const runtimeName = `API_RT_${stamp}`;

  beforeAll(async () => {
    adminSession = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  });

  afterAll(async () => {
    await authFetch(adminSession, `${BASE_URL}/api/secrets/${encodeURIComponent(loginName)}`, { method: 'DELETE' });
    await authFetch(adminSession, `${BASE_URL}/api/secrets/${encodeURIComponent(runtimeName)}`, { method: 'DELETE' });
  });

  async function getSecret(name: string): Promise<SecretEntry | undefined> {
    const res = await authFetch(adminSession, `${BASE_URL}/api/secrets`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SecretsResponse;
    return body.secrets.find((s) => s.name === name);
  }

  it('1. creates a protected-class secret with test-account attestation', async () => {
    const res = await authFetch(adminSession, `${BASE_URL}/api/secrets`, {
      method: 'POST',
      body: JSON.stringify({ name: loginName, value: 'x', secretClass: 'protected', isTestAccount: true }),
    });
    expect(res.status).toBe(200);

    const row = await getSecret(loginName);
    expect(row).toBeDefined();
    expect(row?.class).toBe('protected');
    expect(row?.isTestAccount).toBe(true);
  });

  it('2. rejects reclassifying an existing protected secret to runtime (one-way rule)', async () => {
    const res = await authFetch(adminSession, `${BASE_URL}/api/secrets`, {
      method: 'POST',
      body: JSON.stringify({ name: loginName, value: 'x2', secretClass: 'runtime' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('A protected secret cannot be reclassified to runtime — delete and recreate it instead');

    // class must remain unchanged
    const row = await getSecret(loginName);
    expect(row?.class).toBe('protected');
  });

  it('3. allows re-attesting an existing protected secret (attestation is editable)', async () => {
    const res = await authFetch(adminSession, `${BASE_URL}/api/secrets`, {
      method: 'POST',
      body: JSON.stringify({ name: loginName, value: 'x3', secretClass: 'protected', isTestAccount: false }),
    });
    expect(res.status).toBe(200);

    const row = await getSecret(loginName);
    expect(row?.class).toBe('protected');
    expect(row?.isTestAccount).toBe(false);
  });

  it('4. defaults to runtime class when secretClass is omitted', async () => {
    const res = await authFetch(adminSession, `${BASE_URL}/api/secrets`, {
      method: 'POST',
      body: JSON.stringify({ name: runtimeName, value: 'y' }),
    });
    expect(res.status).toBe(200);

    const row = await getSecret(runtimeName);
    expect(row?.class).toBe('runtime');
  });

  it('5. allows upgrading a runtime secret to protected', async () => {
    const res = await authFetch(adminSession, `${BASE_URL}/api/secrets`, {
      method: 'POST',
      body: JSON.stringify({ name: runtimeName, value: 'y2', secretClass: 'protected' }),
    });
    expect(res.status).toBe(200);

    const row = await getSecret(runtimeName);
    expect(row?.class).toBe('protected');
  });
});

// ---------------------------------------------------------------------------
// A protected secret is never delivered to an agent's job payload (any tier).
// ---------------------------------------------------------------------------

describe('Secrets class — job-secrets withhold', () => {
  let adminSession: AuthSession;
  let agentToken = '';
  let agentId = 0;
  let leaseId = '';
  let workflowId = 0;
  let evalSetId = 0;
  let jobId = 0;
  let tokenId = 0;
  let serverAvailable = false;
  const stamp = Date.now();
  const protectedName = `PROTECTED_LOGIN_EMAIL_${stamp}`;
  const runtimeName = `WITHHOLD_RUNTIME_${stamp}`;

  beforeAll(async () => {
    adminSession = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

    // A protected-class secret and a runtime-class secret, both owned by admin.
    await authFetch(adminSession, `${BASE_URL}/api/secrets`, {
      method: 'POST',
      body: JSON.stringify({ name: protectedName, value: 'admin@example.com', secretClass: 'protected', isTestAccount: true }),
    });
    await authFetch(adminSession, `${BASE_URL}/api/secrets`, {
      method: 'POST',
      body: JSON.stringify({ name: runtimeName, value: 'runtime-value' }),
    });

    let agentRegion = '';
    const tokenRes = await authFetch(adminSession, `${BASE_URL}/api/admin/eval-agent-tokens`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Secrets Class Withhold Token', regionLocationBaseId: BASE_NA }),
    });
    if (tokenRes.ok) {
      const tokenData = await tokenRes.json();
      agentToken = tokenData.token;
      agentRegion = tokenData.region;
      tokenId = tokenData.id;
    }

    if (agentToken) {
      const regRes = await fetch(`${BASE_URL}/api/eval-agent/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agentToken}` },
        body: JSON.stringify({ name: 'Secrets Class Withhold Agent' }),
      });
      if (regRes.ok) {
        const agent = await regRes.json();
        agentId = agent.id;
        leaseId = agent.leaseId;
      }
    }

    const wfRes = await authFetch(adminSession, `${BASE_URL}/api/workflows`);
    if (wfRes.ok) {
      const workflows = await wfRes.json();
      if (workflows.length > 0) workflowId = workflows[0].id;
    }

    const esRes = await authFetch(adminSession, `${BASE_URL}/api/eval-sets`);
    if (esRes.ok) {
      const evalSets = await esRes.json();
      if (evalSets.length > 0) evalSetId = evalSets[0].id;
    }

    if (workflowId && evalSetId && agentToken && agentId) {
      const runRes = await authFetch(adminSession, `${BASE_URL}/api/workflows/${workflowId}/run`, {
        method: 'POST',
        body: JSON.stringify({ region: agentRegion, evalSetId }),
      });
      if (runRes.ok) {
        const runData = await runRes.json();
        jobId = runData.job?.id || runData.jobs?.[0]?.id || runData.id || 0;
      }
      if (!jobId) {
        const jobsRes = await fetch(`${BASE_URL}/api/eval-agent/jobs?region=${agentRegion}`, {
          headers: { 'Authorization': `Bearer ${agentToken}` },
        });
        if (jobsRes.ok) {
          const jobs = await jobsRes.json();
          if (jobs.length > 0) jobId = jobs[0].id;
        }
      }
      if (jobId) {
        await fetch(`${BASE_URL}/api/eval-agent/jobs/${jobId}/claim`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agentToken}` },
          body: JSON.stringify({ agentId, leaseId }),
        });
      }
    }

    serverAvailable = !!(jobId && agentToken);
  });

  afterAll(async () => {
    await authFetch(adminSession, `${BASE_URL}/api/secrets/${encodeURIComponent(protectedName)}`, { method: 'DELETE' });
    await authFetch(adminSession, `${BASE_URL}/api/secrets/${encodeURIComponent(runtimeName)}`, { method: 'DELETE' });
    if (tokenId) {
      await authFetch(adminSession, `${BASE_URL}/api/eval-agent-tokens/${tokenId}/revoke`, { method: 'POST' });
    }
  });

  it('withholds protected-class secrets from job secrets', async () => {
    if (!serverAvailable) {
      throw new Error('Setup failed to produce a claimed job — cannot verify withhold invariant');
    }
    const res = await fetch(`${BASE_URL}/api/eval-agent/jobs/${jobId}/secrets?leaseId=${encodeURIComponent(leaseId)}`, {
      headers: { 'Authorization': `Bearer ${agentToken}` },
    });
    expect(res.ok).toBe(true);
    const jobSecrets = await res.json();
    const names = Object.keys(jobSecrets);
    expect(names).not.toContain(protectedName);
    expect(names).toContain(runtimeName);
  });
});
