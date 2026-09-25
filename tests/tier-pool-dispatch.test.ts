import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { BASE_NA, BASE_EU } from "./helpers/regions";
import { eq } from "drizzle-orm";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || "admin@vox.local";
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || "admin123456";

async function login(): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const cookie = res.headers.get("set-cookie");
  if (!cookie) throw new Error("no session cookie");
  return cookie.split(";")[0];
}
const authFetch = (cookie: string, url: string, init: RequestInit = {}) =>
  fetch(url, { ...init, headers: { ...(init.headers || {}), Cookie: cookie, "Content-Type": "application/json" } });

describe("pooled dispatch API", () => {
  let cookie: string; let evalflowId: number; let evalSetId: number;

  beforeAll(async () => {
    cookie = await login();
    // canScheduleEvalflow is owner/creator-only (no admin bypass) — the seeded
    // evalflows (id 1/2) are owned by Scout, not admin, so the schedule-create
    // assertions below need an admin-OWNED evalflow rather than the seed's
    // wf[0]. Create one here so both the run-route and schedule-route tests
    // in this file share a evalflow the logged-in test user actually owns.
    const providers = await (await authFetch(cookie, `${BASE_URL}/api/providers`)).json();
    const providerId = providers[0].id;
    const wfRes = await authFetch(cookie, `${BASE_URL}/api/evalflows`, {
      method: "POST",
      body: JSON.stringify({ name: `tt-dispatch-wf-${Date.now()}`, visibility: "public", providerId, config: {} }),
    });
    expect(wfRes.ok).toBe(true);
    evalflowId = (await wfRes.json()).id;
    const es = await (await authFetch(cookie, `${BASE_URL}/api/eval-sets?includePublic=true`)).json();
    evalSetId = es[0].id;
  });

  afterAll(async () => {
    if (evalflowId != null) {
      await authFetch(cookie, `${BASE_URL}/api/evalflows/${evalflowId}`, { method: "DELETE" });
    }
  });

  const run = (body: Record<string, unknown>) =>
    authFetch(cookie, `${BASE_URL}/api/evalflows/${evalflowId}/run`, { method: "POST", body: JSON.stringify(body) });

  it("public pool dispatch creates a site-less job carrying region+tier", async () => {
    const res = await run({ region: BASE_NA, targetTier: "public", evalSetId });
    expect(res.status).toBe(200);
    const { job } = await res.json();
    expect(job.siteId).toBeNull();
    expect(job.targetRegion).toBe(BASE_NA);
    expect(job.targetTier).toBe("public");
    expect(job.targetTokenId).toBeNull();
  });

  it("private pool dispatch works for anyone", async () => {
    const res = await run({ region: BASE_NA, targetTier: "private", evalSetId });
    expect(res.status).toBe(200);
    expect((await res.json()).job.targetTier).toBe("private");
  });

  it("rejects: missing tier, unknown tier, shared, inactive region, both forms", async () => {
    expect((await run({ region: BASE_NA, evalSetId })).status).toBe(400);
    expect((await run({ region: BASE_NA, targetTier: "bogus", evalSetId })).status).toBe(400);
    expect((await run({ region: BASE_NA, targetTier: "shared", evalSetId })).status).toBe(400);
    expect((await run({ region: "not-a-region", targetTier: "public", evalSetId })).status).toBe(400);
    expect((await run({ region: BASE_NA, targetTier: "public", targetTokenId: 1, evalSetId })).status).toBe(400);
  });

  it("rejects team pool for a user with no org", async () => {
    // admin has no organization in the dev seed
    const res = await run({ region: BASE_NA, targetTier: "team", evalSetId });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/organization/i);
  });

  it("schedule create takes region+targetTier and the scheduler contract stores them", async () => {
    const res = await authFetch(cookie, `${BASE_URL}/api/eval-schedules`, {
      method: "POST",
      body: JSON.stringify({
        name: `tt-sched-${Date.now()}`, evalflowId, evalSetId,
        region: BASE_NA, targetTier: "public", scheduleType: "recurring", cronExpression: "0 3 * * *",
      }),
    });
    expect(res.status).toBe(200);
    const sched = await res.json();
    expect(sched.region).toBe(BASE_NA);
    expect(sched.targetTier).toBe("public");
    // cleanup
    await authFetch(cookie, `${BASE_URL}/api/eval-schedules/${sched.id}`, { method: "DELETE" });
  });

  it("schedule create rejects: shared tier, bogus tier, team without org, inactive region, missing tier", async () => {
    const base = { name: `tt-neg-${Date.now()}`, evalflowId, evalSetId, scheduleType: "recurring", cronExpression: "0 3 * * *" };
    const post = (body: Record<string, unknown>) =>
      authFetch(cookie, `${BASE_URL}/api/eval-schedules`, { method: "POST", body: JSON.stringify(body) });
    expect((await post({ ...base, region: BASE_NA, targetTier: "shared" })).status).toBe(400);
    expect((await post({ ...base, region: BASE_NA, targetTier: "bogus" })).status).toBe(400);
    expect((await post({ ...base, region: BASE_NA, targetTier: "team" })).status).toBe(400); // admin has no org
    expect((await post({ ...base, region: "not-a-region", targetTier: "public" })).status).toBe(400);
    expect((await post({ ...base, region: BASE_NA })).status).toBe(400);
  });

  it("schedule PATCH accepts region+targetTier with the same validation as create, and round-trips", async () => {
    const createRes = await authFetch(cookie, `${BASE_URL}/api/eval-schedules`, {
      method: "POST",
      body: JSON.stringify({
        name: `tt-patch-sched-${Date.now()}`, evalflowId, evalSetId,
        region: BASE_NA, targetTier: "public", scheduleType: "recurring", cronExpression: "0 3 * * *",
      }),
    });
    expect(createRes.status).toBe(200);
    const sched = await createRes.json();

    const patchRes = await authFetch(cookie, `${BASE_URL}/api/eval-schedules/${sched.id}`, {
      method: "PATCH",
      body: JSON.stringify({ region: BASE_EU, targetTier: "private" }),
    });
    expect(patchRes.status).toBe(200);
    const updated = await patchRes.json();
    expect(updated.region).toBe(BASE_EU);
    expect(updated.targetTier).toBe("private");

    const badRes = await authFetch(cookie, `${BASE_URL}/api/eval-schedules/${sched.id}`, {
      method: "PATCH",
      body: JSON.stringify({ targetTier: "shared" }),
    });
    expect(badRes.status).toBe(400);

    await authFetch(cookie, `${BASE_URL}/api/eval-schedules/${sched.id}`, { method: "DELETE" });
  });

  // Reuses this describe's own admin-owned evalflow/eval-set (created in its
  // beforeAll above) rather than fetching `?includePublic=true` and taking
  // index 0 — that global listing is shared across every test file hitting
  // this dev DB (vitest runs files in parallel), so index 0 can flakily land
  // on a session-injected evalflow from a concurrently-running suite (e.g.
  // session-dispatch.test.ts's login-secret evalflows), which would flip
  // needsSession and make the public-tier assertion flaky. The evalflow this
  // describe owns has an empty config (no platform.setup), so it never needs
  // a session — deterministic.
  it("run-targets advertises per-tier availability with online counts for the region", async () => {
    const res = await authFetch(cookie, `${BASE_URL}/api/evalflows/${evalflowId}/run-targets?region=${BASE_NA}&evalSetId=${evalSetId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.tiers)).toBe(true);
    const byTier = Object.fromEntries(body.tiers.map((t: any) => [t.tier, t]));
    expect(byTier.public.available).toBe(true);
    expect(typeof byTier.public.onlineAgents).toBe("number");
    expect(byTier.private.available).toBe(true);
    expect(byTier.team.available).toBe(false); // admin has no org in dev seed
    expect(byTier.team.reason).toBe("no-org");
    expect(byTier.shared.available).toBe(false);
    expect(byTier.shared.reason).toBe("not-pooled-yet");
  });
});

// ---------------------------------------------------------------------------
// Missing-secret dispatch gate (job #31006 regression)
// ---------------------------------------------------------------------------

describe("missing secrets are rejected at dispatch, not discovered by a failed run", () => {
  let cookie: string;
  let brokenEvalflowId: number;
  let evalSetId: number;
  const GHOST = `GHOST_SECRET_${Date.now()}`;

  beforeAll(async () => {
    cookie = await login();
    const providers = await (await fetch(`${BASE_URL}/api/providers`)).json();
    // A evalflow whose scenario references a secret nobody has configured.
    const wfRes = await authFetch(cookie, `${BASE_URL}/api/evalflows`, {
      method: "POST",
      body: JSON.stringify({
        name: `missing-secret-wf-${Date.now()}`,
        visibility: "private",
        providerId: providers[0].id,
        // stepsPrefix is the evalflow's platform.setup — exactly where the
        // reported failure (job #31006) referenced its secrets.
        config: { framework: "aeval", stepsPrefix: `platform:\n  setup:\n    - type: control.log\n      message: \${secrets.${GHOST}}\n` },
      }),
    });
    expect(wfRes.ok).toBe(true);
    brokenEvalflowId = (await wfRes.json()).id;

    const esRes = await authFetch(cookie, `${BASE_URL}/api/eval-sets`, {
      method: "POST",
      body: JSON.stringify({ name: `ms-es-${Date.now()}`, visibility: "private", config: { scenario: "name: y" } }),
    });
    expect(esRes.ok).toBe(true);
    evalSetId = (await esRes.json()).id;
  });

  afterAll(async () => {
    if (brokenEvalflowId) await authFetch(cookie, `${BASE_URL}/api/evalflows/${brokenEvalflowId}`, { method: "DELETE" });
    if (evalSetId) await authFetch(cookie, `${BASE_URL}/api/eval-sets/${evalSetId}`, { method: "DELETE" });
  });

  it("gates a evalflow that OMITS framework (the reported job #31006 shape)", async () => {
    // No `framework` key and no `app`: the run can only be aeval, so the gate
    // must still cover stepsPrefix. Previously this slipped through entirely.
    const providers = await (await fetch(`${BASE_URL}/api/providers`)).json();
    const ghost = `GHOST_NOFW_${Date.now()}`;
    const wfRes = await authFetch(cookie, `${BASE_URL}/api/evalflows`, {
      method: "POST",
      body: JSON.stringify({
        name: `missing-secret-nofw-${Date.now()}`,
        visibility: "private",
        providerId: providers[0].id,
        config: { stepsPrefix: `platform:\n  setup:\n    - type: control.log\n      message: \${secrets.${ghost}}\n` },
      }),
    });
    expect(wfRes.ok).toBe(true);
    const wfId = (await wfRes.json()).id;

    const res = await authFetch(cookie, `${BASE_URL}/api/evalflows/${wfId}/run`, {
      method: "POST",
      body: JSON.stringify({ region: BASE_NA, targetTier: "private", evalSetId }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(ghost);

    await authFetch(cookie, `${BASE_URL}/api/evalflows/${wfId}`, { method: "DELETE" });
  });

  it("run route 400s and NAMES the missing secret (no job created)", async () => {
    const res = await authFetch(cookie, `${BASE_URL}/api/evalflows/${brokenEvalflowId}/run`, {
      method: "POST",
      body: JSON.stringify({ region: BASE_NA, targetTier: "private", evalSetId }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    // The whole point: the operator learns WHICH secret, before burning a run.
    expect(body.error).toContain(GHOST);
  });

  it("re-enabling a schedule with a missing secret 400s instead of flapping", async () => {
    // A schedule created while the secret existed, then the secret deleted:
    // re-enable used to 200 and be silently disabled again on the next tick.
    // We can't create one through the gated route, so insert directly.
    const { db } = await import("../server/storage");
    const { evalSchedules } = await import("../shared/schema");
    const [sched] = await db.insert(evalSchedules).values({
      name: `ms-reenable-${Date.now()}`,
      evalflowId: brokenEvalflowId,
      evalSetId,
      createdBy: 1,
      region: BASE_NA,
      targetTier: "public",
      scheduleType: "recurring",
      cronExpression: "0 3 * * *",
      isEnabled: false,
    } as any).returning();

    const res = await authFetch(cookie, `${BASE_URL}/api/eval-schedules/${sched.id}`, {
      method: "PATCH",
      body: JSON.stringify({ isEnabled: true }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(GHOST);

    await db.delete(evalSchedules).where(eq(evalSchedules.id, sched.id));
  });

  it("schedule create 400s on the same evalflow", async () => {
    const res = await authFetch(cookie, `${BASE_URL}/api/eval-schedules`, {
      method: "POST",
      body: JSON.stringify({
        name: `ms-sched-${Date.now()}`, evalflowId: brokenEvalflowId, evalSetId,
        region: BASE_NA, targetTier: "private", scheduleType: "recurring", cronExpression: "0 3 * * *",
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(GHOST);
  });
});
