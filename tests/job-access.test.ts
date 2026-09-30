import { describe, it, expect, beforeAll } from "vitest";
import { canViewJob, canCancelJob, type AuthUser } from "../server/permissions";
import { BASE_NA } from "./helpers/regions";

// Who may read / cancel an eval job — one rule each (server/permissions.ts),
// shared by the console (/api/eval-jobs/:id…) and the public API
// (/api/v1/jobs/:id, /api/v1/results/:id). The two used to be separate inline
// checks: a user could open a job in the browser and get 403 for the same job
// through the API with their key.

const u = (id: number, over: Partial<AuthUser> = {}): AuthUser => ({ id, isAdmin: false, membership: null, ...over });

// Tools → Analyze: an analysis is its uploader's alone, served only by the
// /api/tools/analyze routes. The job routes don't serve it to anyone — not an
// admin (who would read the transcripts), and not its uploader either.
describe("analyze jobs through the job routes", () => {
  const analysis = { createdBy: 2, kind: "analyze" as const };
  it("nobody may view one there, admin included", () => {
    expect(canViewJob(u(9, { isAdmin: true }), analysis, undefined)).toBe(false);
    expect(canViewJob(u(2), analysis, undefined)).toBe(false);
  });
  it("nobody may cancel one there (delete it on the Analyze page)", () => {
    expect(canCancelJob(u(9, { isAdmin: true }), analysis, undefined)).toBe(false);
    expect(canCancelJob(u(2), analysis, undefined)).toBe(false);
  });
  it("an eval job is unaffected", () => {
    expect(canViewJob(u(2), { createdBy: 2, kind: "eval" }, undefined)).toBe(true);
  });
});

describe("canViewJob", () => {
  const job = { createdBy: 2 };

  it("anyone may view a job on a public eval flow — including one they ran on someone else's flow", () => {
    expect(canViewJob(u(2), job, { ownerId: 1, visibility: "public" })).toBe(true);
    expect(canViewJob(u(3), job, { ownerId: 1, visibility: "public" })).toBe(true);
  });

  it("a private flow's jobs: its owner and same-org members, not others", () => {
    const flow = { ownerId: 1, visibility: "private", organizationId: 9 };
    expect(canViewJob(u(1), job, flow)).toBe(true);
    expect(canViewJob(u(4, { membership: { organizationId: 9, role: "member" } as AuthUser["membership"] }), job, flow)).toBe(true);
    expect(canViewJob(u(3), job, flow)).toBe(false);
  });

  it("uses the flow's LIVE visibility: a since-privatised flow's jobs stop being visible to others", () => {
    expect(canViewJob(u(3), job, { ownerId: 1, visibility: "private" })).toBe(false);
  });

  it("once the flow is deleted, only the person who ran the job", () => {
    expect(canViewJob(u(2), job, undefined)).toBe(true);
    expect(canViewJob(u(1), job, undefined)).toBe(false);
  });

  it("admins may view any job", () => {
    expect(canViewJob(u(99, { isAdmin: true }), job, { ownerId: 1, visibility: "private" })).toBe(true);
    expect(canViewJob(u(99, { isAdmin: true }), job, undefined)).toBe(true);
  });
});

describe("canCancelJob", () => {
  const job = { createdBy: 2 };
  const personalFlow = { ownerId: 1, visibility: "public" };
  const orgFlow = { ownerId: 1, visibility: "private", organizationId: 9 };
  const member = (id: number, role: string) =>
    u(id, { membership: { organizationId: 9, role } as AuthUser["membership"] });

  it("the person who ran the job may cancel it, whoever owns the flow", () => {
    expect(canCancelJob(u(2), job, personalFlow)).toBe(true);
    expect(canCancelJob(u(2), job, undefined)).toBe(true); // flow deleted
  });

  it("the flow's owner may cancel runs others start on it — they spend the owner's secrets", () => {
    expect(canCancelJob(u(1), job, personalFlow)).toBe(true);
  });

  it("an org manager may cancel a member's job on an org flow; a plain member may not", () => {
    expect(canCancelJob(member(5, "admin"), job, orgFlow)).toBe(true);
    expect(canCancelJob(member(6, "owner"), job, orgFlow)).toBe(true);
    expect(canCancelJob(member(7, "member"), job, orgFlow)).toBe(false);
  });

  it("merely being able to view the flow is not enough", () => {
    expect(canCancelJob(u(3), job, personalFlow)).toBe(false);
  });

  it("an admin may cancel anyone's (browser only — API keys never carry admin)", () => {
    expect(canCancelJob(u(99, { isAdmin: true }), job, personalFlow)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Parity against the running server: the console and the API must give the
// same answer for the same job and the same person.
// ---------------------------------------------------------------------------

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || "admin@vox.local";
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || "admin123456";
const hasDb = !!process.env.DATABASE_URL;

type Session = { cookie: string };
const cookieOf = (res: Response) => (res.headers.get("set-cookie") || "").split(";")[0];

async function login(email: string, password: string): Promise<Session> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login ${email}: ${res.status}`);
  return { cookie: cookieOf(res) };
}

const call = (s: Session, method: string, path: string, body?: unknown) =>
  fetch(`${BASE_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Cookie: s.cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function newUser(admin: Session, tag: string): Promise<Session> {
  const email = `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  const password = "TestPass123!";
  const invite = await call(admin, "POST", "/api/admin/invite", { email, plan: "premium" });
  if (!invite.ok) throw new Error(`invite: ${invite.status}`);
  const { token } = await invite.json();
  const reg = await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: email.split("@")[0].replace(/[^a-z0-9]/gi, ""), password, token }),
  });
  if (!reg.ok) throw new Error(`register: ${reg.status}`);
  return login(email, password);
}

async function apiKey(s: Session): Promise<string> {
  const res = await call(s, "POST", "/api/user/api-keys", { name: `parity-${Date.now()}` });
  return (await res.json()).key;
}

async function flowWithJob(owner: Session, runner: Session, visibility: "public" | "private") {
  const providerId = (await (await fetch(`${BASE_URL}/api/providers`)).json())[0].id;
  const project = await (await call(owner, "POST", "/api/projects", { name: `parity-${Date.now()}` })).json();
  const flow = await (await call(owner, "POST", "/api/eval-flows", {
    name: `parity-${visibility}-${Date.now()}`, visibility, projectId: project.id, providerId,
  })).json();
  const set = await (await call(runner, "POST", "/api/eval-sets", {
    name: `parity-set-${Date.now()}`, visibility: "public", config: {},
  })).json();
  const run = await call(runner, "POST", `/api/eval-flows/${flow.id}/run`, {
    evalSetId: set.id, region: BASE_NA, targetTier: "public",
  });
  if (!run.ok) throw new Error(`run: ${run.status} ${await run.text()}`);
  return (await run.json()).job.id as number;
}

(hasDb ? describe : describe.skip)("console and API agree on who may view a job", () => {
  let admin: Session;
  let adminKey: string;
  let owner: Session;
  let other: Session;
  let outsider: Session;
  let outsiderKey: string;
  let otherKey: string;
  let ownerKey: string;
  let publicJobRunByOther: number;
  let privateJob: number;

  beforeAll(async () => {
    admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    adminKey = await apiKey(admin);
    owner = await newUser(admin, "parity-owner");
    other = await newUser(admin, "parity-other");
    ownerKey = await apiKey(owner);
    otherKey = await apiKey(other);
    // Neither ran the jobs below nor owns their flows: can only VIEW the public one.
    outsider = await newUser(admin, "parity-outsider");
    outsiderKey = await apiKey(outsider);
    // The reported case: someone runs another user's PUBLIC flow.
    publicJobRunByOther = await flowWithJob(owner, other, "public");
    // A PRIVATE flow's job, run by its owner.
    privateJob = await flowWithJob(owner, owner, "private");
  }, 60_000);

  const viaConsole = (s: Session, id: number) => call(s, "GET", `/api/eval-jobs/${id}`).then((r) => r.status);
  const viaApi = (key: string, id: number) =>
    fetch(`${BASE_URL}/api/v1/jobs/${id}`, { headers: { Authorization: `Bearer ${key}` } }).then((r) => r.status);

  it("a job someone ran on another user's PUBLIC flow: both let them read it (the reported 403)", async () => {
    expect(await viaConsole(other, publicJobRunByOther)).toBe(200);
    expect(await viaApi(otherKey, publicJobRunByOther)).toBe(200);
  });

  it("the flow's owner can read it through both", async () => {
    expect(await viaConsole(owner, publicJobRunByOther)).toBe(200);
    expect(await viaApi(ownerKey, publicJobRunByOther)).toBe(200);
  });

  it("a PRIVATE flow's job: refused to an outsider through both", async () => {
    expect(await viaConsole(other, privateJob)).toBe(403);
    expect(await viaApi(otherKey, privateJob)).toBe(403);
  });

  // "Allowed" is asserted as NOT 403: a local agent may already have claimed
  // the job, and cancelling a non-pending job is a 400. The point here is who
  // is permitted, not the job's state.
  const consoleCancel = (sess: Session, id: number) => call(sess, "DELETE", `/api/eval-jobs/${id}`).then((r) => r.status);
  const apiCancel = (key: string, id: number) =>
    fetch(`${BASE_URL}/api/v1/jobs/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${key}` } }).then((r) => r.status);

  it("someone who can merely view a public flow cannot cancel runs on it — refused through both", async () => {
    // A real outsider: can view the public flow (so this is not a 403 for
    // not seeing it), but neither ran the job nor owns the flow.
    expect(await viaConsole(outsider, publicJobRunByOther)).toBe(200);
    expect(await consoleCancel(outsider, publicJobRunByOther)).toBe(403);
    expect(await apiCancel(outsiderKey, publicJobRunByOther)).toBe(403);
    // Through a key an admin is exactly such an outsider too.
    expect(await apiCancel(adminKey, publicJobRunByOther)).toBe(403);
  });

  it("the flow's owner may cancel a run someone else started on it — through both", async () => {
    expect(await consoleCancel(owner, publicJobRunByOther)).not.toBe(403);
    expect(await apiCancel(ownerKey, publicJobRunByOther)).not.toBe(403);
  });

  it("the person who started a job may cancel it, even on someone else's flow — through both", async () => {
    expect(await consoleCancel(other, publicJobRunByOther)).not.toBe(403);
    expect(await apiCancel(otherKey, publicJobRunByOther)).not.toBe(403);
  });

  it("an admin's API key carries no admin rights; the same admin in the browser does", async () => {
    // Read someone else's private job.
    expect(await viaApi(adminKey, privateJob)).toBe(403);
    expect(await viaConsole(admin, privateJob)).toBe(200);
    // Cancel someone else's job.
    expect(await apiCancel(adminKey, privateJob)).toBe(403);
    expect(await consoleCancel(admin, privateJob)).not.toBe(403);
  });

  it("an admin API key cannot perform admin-only console actions; the same admin in the browser can", async () => {
    const list = await fetch(`${BASE_URL}/api/providers`);
    expect(list.ok).toBe(true);
    const providers: Array<{ id: string; name: string }> = await list.json();
    expect(providers.length).toBeGreaterThan(0);
    // Re-sending the current name changes nothing, whoever is allowed.
    const body = JSON.stringify({ name: providers[0].name });

    // /api/admin routes are browser-session only: an API key — even an
    // admin's — is not accepted as a login there at all.
    const viaKey = await fetch(`${BASE_URL}/api/admin/providers/${providers[0].id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminKey}` },
      body,
    });
    expect(viaKey.status).toBe(401);

    // Proves the refusal is about the key, not a broken route.
    const viaBrowser = await call(admin, "PATCH", `/api/admin/providers/${providers[0].id}`, { name: providers[0].name });
    expect(viaBrowser.status).toBe(200);
  });

  // ---- lists: default "mine", scope=visible for everything viewable ----
  const consoleList = async (sess: Session, scope?: string) => {
    const q = scope ? `&scope=${scope}` : "";
    const res = await call(sess, "GET", `/api/eval-jobs?hours=1&limit=200${q}`);
    return { status: res.status, ids: res.ok ? ((await res.json()).data as Array<{ id: number }>).map((j) => j.id) : [] };
  };
  const apiList = async (key: string, scope?: string) => {
    const q = scope ? `&scope=${scope}` : "";
    const res = await fetch(`${BASE_URL}/api/v1/jobs?limit=200${q}`, { headers: { Authorization: `Bearer ${key}` } });
    return { status: res.status, ids: res.ok ? ((await res.json()).data as Array<{ id: number }>).map((j) => j.id) : [] };
  };

  it("by default both lists show only jobs you started", async () => {
    for (const list of [await consoleList(other), await apiList(otherKey)]) {
      expect(list.ids).toContain(publicJobRunByOther);
      expect(list.ids).not.toContain(privateJob);
    }
    // The flow's owner did not start publicJobRunByOther, so it is not "theirs".
    for (const list of [await consoleList(owner), await apiList(ownerKey)]) {
      expect(list.ids).toContain(privateJob);
      expect(list.ids).not.toContain(publicJobRunByOther);
    }
  });

  it("scope=visible shows every job you may view — the same in both", async () => {
    for (const list of [await consoleList(owner, "visible"), await apiList(ownerKey, "visible")]) {
      expect(list.ids).toEqual(expect.arrayContaining([publicJobRunByOther, privateJob]));
    }
    for (const list of [await consoleList(other, "visible"), await apiList(otherKey, "visible")]) {
      expect(list.ids).toContain(publicJobRunByOther);
      expect(list.ids).not.toContain(privateJob);
    }
  });

  it("everything a visible list shows can also be opened on its own", async () => {
    const { ids } = await apiList(otherKey, "visible");
    expect(ids.length).toBeGreaterThan(0);
    const { pool } = await import("../server/storage");
    for (const id of ids.slice(0, 15)) {
      const status = await viaApi(otherKey, id);
      if (status === 403) {
        // The sample includes other suites' jobs, which they clean up while
        // this runs: a flow deleted or made private between the list and the
        // open is a real state change, not a rule mismatch. A 403 on a job
        // whose flow is STILL public is a mismatch and fails.
        const { rows } = await pool.query(
          `SELECT f.visibility FROM eval_jobs j LEFT JOIN eval_flows f ON f.id = j.eval_flow_id WHERE j.id = $1`, [id]);
        expect(rows[0]?.visibility, `job ${id}: listed as visible, refused while its flow is still public`).not.toBe("public");
        continue;
      }
      expect(status).toBe(200);
    }
  });

  it("an admin sees ALL jobs in the browser (All visible); an admin's API key does not", async () => {
    expect((await consoleList(admin, "visible")).ids).toContain(privateJob);
    expect((await apiList(adminKey, "visible")).ids).not.toContain(privateJob);
  });

  it("an unknown scope is refused by both", async () => {
    expect((await consoleList(other, "everything")).status).toBe(400);
    expect((await apiList(otherKey, "everything")).status).toBe(400);
  });
});
