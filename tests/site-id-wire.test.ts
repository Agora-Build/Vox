import { describe, it, expect, beforeAll } from 'vitest';
import { REGION_NA, BASE_NA } from './helpers/regions';

/**
 * Site-ID wire-contract tests (region → siteId refactor).
 *
 * Locks the JSON key each public surface uses for the site value, so a silent
 * key flip (which type-checks fine on hand-rolled client interfaces but renders
 * `undefined` at runtime) is caught here instead of in the browser.
 *
 * Two contracts coexist by design:
 *  - RENAMED surfaces emit `siteId` (eval-agents, eval-jobs rows, clash events).
 *  - BACK-COMPAT surfaces still emit the `region` key carrying a site-id value
 *    (eval-agent-tokens list/create) — the documented half-migration. If that
 *    is ever closed, update these assertions together with the client readers.
 */

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:5000';
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || 'admin@vox.local';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || 'admin123456';

// Fully-qualified site ID: <base>-<NN> (e.g. na-us-seattle-01)
const SITE_ID_RE = /^[a-z0-9-]+-\d{2,}$/;

let cookie: string;

async function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE_URL}${url}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(options.headers || {}) },
  });
}

beforeAll(async () => {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status}`);
  cookie = (res.headers.get('set-cookie') || '').split(';')[0];
});

describe('site-id wire contract', () => {
  it('GET /api/eval-agents emits siteId (not region)', async () => {
    const res = await fetch(`${BASE_URL}/api/eval-agents`);
    expect(res.status).toBe(200);
    const agents = await res.json();
    expect(Array.isArray(agents)).toBe(true);
    for (const a of agents) {
      expect(a).toHaveProperty('siteId');
      expect(a.siteId).toMatch(SITE_ID_RE);
      expect(a).not.toHaveProperty('region');
    }
  });

  it('GET /api/eval-jobs returns {data,total}; rows carry siteId', async () => {
    const res = await authFetch('/api/eval-jobs?limit=5');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.total).toBe('number');
    for (const job of body.data) {
      expect(job).toHaveProperty('siteId');
      expect(job).not.toHaveProperty('region');
    }
  });

  it('GET /api/eval-jobs?siteId= filters by exact site and rejects garbage', async () => {
    const ok = await authFetch(`/api/eval-jobs?siteId=${REGION_NA}&limit=5`);
    expect(ok.status).toBe(200);
    const { data } = await ok.json();
    for (const job of data) expect(job.siteId).toBe(REGION_NA);

    const bad = await authFetch('/api/eval-jobs?siteId=not-a-real-site-zz');
    expect(bad.status).toBe(400);
  });

  it('eval-agent-token create/list keep the back-compat region key carrying a site-id', async () => {
    const create = await authFetch('/api/eval-agent-tokens', {
      method: 'POST',
      body: JSON.stringify({ name: `wire-contract-${Date.now()}`, regionLocationBaseId: BASE_NA }),
    });
    expect(create.status).toBe(200);
    const created = await create.json();
    // The response key is `region`, but the VALUE is a fully-qualified site id.
    expect(created.region).toMatch(SITE_ID_RE);
    expect(created).not.toHaveProperty('siteId');

    const list = await authFetch('/api/eval-agent-tokens');
    expect(list.status).toBe(200);
    const tokens = await list.json();
    const mine = tokens.find((t: { id: number }) => t.id === created.id);
    expect(mine).toBeDefined();
    expect(mine.region).toBe(created.region);
    expect(mine).not.toHaveProperty('siteId');

    // Clean up so repeated runs don't accumulate live tokens.
    const revoke = await authFetch(`/api/eval-agent-tokens/${created.id}/revoke`, { method: 'POST' });
    expect(revoke.status).toBe(200);
  });

  it('GET /api/metrics/leaderboard entries carry siteId when present', async () => {
    const res = await fetch(`${BASE_URL}/api/metrics/leaderboard`);
    expect(res.status).toBe(200);
    const entries = await res.json();
    expect(Array.isArray(entries)).toBe(true);
    for (const e of entries) {
      expect(e).toHaveProperty('siteId');
      expect(e).not.toHaveProperty('region');
    }
  });
});
