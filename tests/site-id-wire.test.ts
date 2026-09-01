import { describe, it, expect, beforeAll } from 'vitest';
import { REGION_NA, BASE_NA } from './helpers/regions';

/**
 * Site-ID wire-contract tests (region → siteId refactor).
 *
 * Locks the JSON key each public surface uses for the site value, so a silent
 * key flip (which type-checks fine on hand-rolled client interfaces but renders
 * `undefined` at runtime) is caught here instead of in the browser.
 *
 * Contract:
 *  - Response surfaces emit `siteId`, never `region`, with two sanctioned
 *    exceptions: the clash-runner daemon wire, which dual-keys `siteId` +
 *    `region` until deployed runners are upgraded (covered in
 *    clash-runner-lifecycle); and `GET /api/eval-agents`, which deliberately
 *    adds `region` (the Vox-detected baseId, nullable) and `locationTrust`
 *    alongside `siteId` per the zero-trust agent-region design
 *    (designs/2026-09-01-zero-trust-agent-region-design.md) — covered below.
 *  - Run and schedule request bodies (workflow run, v1 run, eval-schedules
 *    create/PATCH) take `region` + `targetTier` (pooled dispatch, spec
 *    2026-08-24-tier-targeting) — the exact-site `siteId` body key is dead on
 *    those routes and must be rejected, not silently read. CLASH-token /
 *    clash-runner bodies are unaffected and still take `siteId`.
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
  it('GET /api/eval-agents emits siteId, region, and locationTrust (sanctioned exception)', async () => {
    // Zero-trust agent-region design: this surface deliberately carries the
    // Vox-detected `region` (nullable baseId) and `locationTrust` alongside
    // `siteId` — see the header comment above.
    const res = await fetch(`${BASE_URL}/api/eval-agents`);
    expect(res.status).toBe(200);
    const agents = await res.json();
    expect(Array.isArray(agents)).toBe(true);
    for (const a of agents) {
      expect(a).toHaveProperty('siteId');
      if (a.siteId != null) expect(a.siteId).toMatch(SITE_ID_RE);
      expect(a).toHaveProperty('region');
      if (a.region != null) expect(typeof a.region).toBe('string');
      expect(a).toHaveProperty('locationTrust');
      expect(typeof a.locationTrust).toBe('string');
      expect(a).not.toHaveProperty('locationSource');
      expect(a).not.toHaveProperty('observedIp');
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

  it('GET /api/eval-jobs?region= filters by region, keeps pending pooled rows, rejects garbage', async () => {
    const ok = await authFetch(`/api/eval-jobs?region=${BASE_NA}&limit=20`);
    expect(ok.status).toBe(200);
    const { data } = await ok.json();
    for (const job of data) {
      // Claimed rows carry a concrete site under the region; pending pooled
      // rows carry a null site with targetRegion — BOTH must match the filter.
      if (job.siteId != null) {
        expect(job.siteId.startsWith(`${BASE_NA}-`)).toBe(true);
      } else {
        expect(job.targetRegion).toBe(BASE_NA);
      }
    }

    const bad = await authFetch('/api/eval-jobs?region=not-a-real-region-zz');
    expect(bad.status).toBe(400);
  });

  it('eval-agent-token create/list emit siteId (not region)', async () => {
    const create = await authFetch('/api/eval-agent-tokens', {
      method: 'POST',
      body: JSON.stringify({ name: `wire-contract-${Date.now()}`, regionLocationBaseId: BASE_NA }),
    });
    expect(create.status).toBe(200);
    const created = await create.json();
    expect(created.siteId).toMatch(SITE_ID_RE);
    expect(created).not.toHaveProperty('region');

    const list = await authFetch('/api/eval-agent-tokens');
    expect(list.status).toBe(200);
    const tokens = await list.json();
    const mine = tokens.find((t: { id: number }) => t.id === created.id);
    expect(mine).toBeDefined();
    expect(mine.siteId).toBe(created.siteId);
    expect(mine).not.toHaveProperty('region');

    // Clean up so repeated runs don't accumulate live tokens.
    const revoke = await authFetch(`/api/eval-agent-tokens/${created.id}/revoke`, { method: 'POST' });
    expect(revoke.status).toBe(200);
  });

  it('request bodies REJECT the dead legacy region key', async () => {
    // The alias was dropped: a valid site under `region` must NOT create a
    // token — the server only reads `siteId` now.
    const viaLegacy = await authFetch('/api/admin/clash-runner-tokens', {
      method: 'POST',
      body: JSON.stringify({ name: `wire-dead-alias-${Date.now()}`, region: REGION_NA }),
    });
    expect(viaLegacy.status).toBe(400);

    // Same request through the canonical key succeeds — proves the 400 above
    // is the missing key, not something else about the request.
    const viaCanonical = await authFetch('/api/admin/clash-runner-tokens', {
      method: 'POST',
      body: JSON.stringify({ name: `wire-canonical-${Date.now()}`, siteId: REGION_NA }),
    });
    expect(viaCanonical.status).toBe(200);
    const created = await viaCanonical.json();
    expect(created.siteId).toBe(REGION_NA);

    // Clean up: revoke so repeated runs don't accumulate live runner tokens.
    const revoke = await authFetch(`/api/admin/clash-runner-tokens/${created.id}/revoke`, { method: 'POST' });
    expect(revoke.status).toBe(200);
  });

  it('run body takes region+targetTier; the siteId body key is dead', async () => {
    const wf = await (await authFetch('/api/workflows?includePublic=true')).json();
    const es = await (await authFetch('/api/eval-sets?includePublic=true')).json();
    const viaSite = await authFetch(`/api/workflows/${wf[0].id}/run`, {
      method: 'POST',
      body: JSON.stringify({ siteId: REGION_NA, evalSetId: es[0].id }),
    });
    expect(viaSite.status).toBe(400); // siteId body key no longer read

    const viaPool = await authFetch(`/api/workflows/${wf[0].id}/run`, {
      method: 'POST',
      body: JSON.stringify({ region: BASE_NA, targetTier: 'public', evalSetId: es[0].id }),
    });
    expect(viaPool.status).toBe(200);
    const { job } = await viaPool.json();
    expect(job.siteId).toBeNull();
    expect(job.targetRegion).toBe(BASE_NA);
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
