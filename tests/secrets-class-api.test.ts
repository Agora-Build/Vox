import { describe, it, expect, beforeAll, afterAll } from 'vitest';

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

  it('1. creates a login-class secret with test-account attestation', async () => {
    const res = await authFetch(adminSession, `${BASE_URL}/api/secrets`, {
      method: 'POST',
      body: JSON.stringify({ name: loginName, value: 'x', secretClass: 'login', isTestAccount: true }),
    });
    expect(res.status).toBe(200);

    const row = await getSecret(loginName);
    expect(row).toBeDefined();
    expect(row?.class).toBe('login');
    expect(row?.isTestAccount).toBe(true);
  });

  it('2. rejects reclassifying an existing login secret to runtime (one-way rule)', async () => {
    const res = await authFetch(adminSession, `${BASE_URL}/api/secrets`, {
      method: 'POST',
      body: JSON.stringify({ name: loginName, value: 'x2', secretClass: 'runtime' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('A login secret cannot be reclassified to runtime — delete and recreate it instead');

    // class must remain unchanged
    const row = await getSecret(loginName);
    expect(row?.class).toBe('login');
  });

  it('3. allows re-attesting an existing login secret (attestation is editable)', async () => {
    const res = await authFetch(adminSession, `${BASE_URL}/api/secrets`, {
      method: 'POST',
      body: JSON.stringify({ name: loginName, value: 'x3', secretClass: 'login', isTestAccount: false }),
    });
    expect(res.status).toBe(200);

    const row = await getSecret(loginName);
    expect(row?.class).toBe('login');
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

  it('5. allows upgrading a runtime secret to login', async () => {
    const res = await authFetch(adminSession, `${BASE_URL}/api/secrets`, {
      method: 'POST',
      body: JSON.stringify({ name: runtimeName, value: 'y2', secretClass: 'login' }),
    });
    expect(res.status).toBe(200);

    const row = await getSecret(runtimeName);
    expect(row?.class).toBe('login');
  });
});
