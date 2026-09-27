import { describe, it, expect, beforeAll } from "vitest";
import { canViewJob, canCancelJob, type AuthUser } from "../server/permissions";
import { BASE_NA } from "./helpers/regions";

// Who may read / cancel an eval job — one rule each (server/permissions.ts),
// shared by the console (/api/eval-jobs/:id…) and the public API
// (/api/v1/jobs/:id, /api/v1/results/:id). The two used to be separate inline
// checks: a user could open a job in the browser and get 403 for the same job
// through the API with their key.

const u = (id: number, over: Partial<AuthUser> = {}): AuthUser => ({ id, isAdmin: false, membership: null, ...over });

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

describe("canCancelJob — stricter than viewing", () => {
  const job = { createdBy: 2 };

  it("the flow's owner may cancel; viewing a public flow does not let you cancel its jobs", () => {
    expect(canCancelJob(u(1), job, { ownerId: 1 })).toBe(true);
    expect(canCancelJob(u(3), job, { ownerId: 1 })).toBe(false);
  });

  it("once the flow is deleted, the person who ran the job", () => {
    expect(canCancelJob(u(2), job, undefined)).toBe(true);
    expect(canCancelJob(u(1), job, undefined)).toBe(false);
  });

  it("admins may cancel any job", () => {
    expect(canCancelJob(u(99, { isAdmin: true }), job, { ownerId: 1 })).toBe(true);
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
  let owner: Session;
  let other: Session;
  let otherKey: string;
  let ownerKey: string;
  let publicJobRunByOther: number;
  let privateJob: number;

  beforeAll(async () => {
    const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    owner = await newUser(admin, "parity-owner");
    other = await newUser(admin, "parity-other");
    ownerKey = await apiKey(owner);
    otherKey = await apiKey(other);
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

  it("viewing a public flow does not let you cancel its jobs — refused through both", async () => {
    const consoleCancel = await call(other, "DELETE", `/api/eval-jobs/${publicJobRunByOther}`);
    const apiCancel = await fetch(`${BASE_URL}/api/v1/jobs/${publicJobRunByOther}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${otherKey}` },
    });
    expect(consoleCancel.status).toBe(403);
    expect(apiCancel.status).toBe(403);
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
    for (const id of ids.slice(0, 15)) {
      expect(await viaApi(otherKey, id)).toBe(200);
    }
  });

  it("an unknown scope is refused by both", async () => {
    expect((await consoleList(other, "everything")).status).toBe(400);
    expect((await apiList(otherKey, "everything")).status).toBe(400);
  });
});
