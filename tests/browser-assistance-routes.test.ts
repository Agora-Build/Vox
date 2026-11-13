import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import type { AuthUser } from "../server/auth";
import type { EvalJob } from "../shared/schema";
import type { BrowserGrant } from "../server/browser-viewers";

const mocks = vi.hoisted(() => ({
  storage: { getEvalJob: vi.fn(), getEvalAgent: vi.fn(), getEvalAgentToken: vi.fn(), getWebSession: vi.fn(), getBroker: vi.fn(), getBrokerRegistrationToken: vi.fn(), getEvalFlow: vi.fn(), cancelRunningEvalJob: vi.fn() },
  user: { value: undefined as unknown }, allowed: vi.fn(), send: vi.fn(), available: vi.fn(), classes: vi.fn(), settle: vi.fn(), secret: vi.fn(),
  grants: new Map<string, BrowserGrant>(), brokerFetch: vi.fn(), capture: vi.fn(), membership: vi.fn(),
}));
vi.mock("../server/storage", () => ({ storage: mocks.storage }));
vi.mock("../server/auth", () => ({
  requireAuth: (req: express.Request, res: express.Response, next: express.NextFunction) => req.session?.userId ? next() : res.sendStatus(401),
  getCurrentUser: async () => mocks.user.value,
}));
vi.mock("../server/auth-session", () => ({
  credentialKeyFor: () => "credentials", sessionScopeForEvalFlow: (owner: { ownerId: number; organizationId: number | null }) => owner.organizationId ? { organizationId: owner.organizationId } : { userId: owner.ownerId },
  classifyReferencedSecrets: mocks.classes,
}));
vi.mock("../server/credential-trials", () => ({ jobMayUseCredentials: mocks.allowed }));
vi.mock("../server/organizations", () => ({ getOrganizations: () => ({ getMembership: mocks.membership }) }));
vi.mock("../server/broker-registry", () => ({ getBrokerTarget: mocks.secret, fetchViaBroker: mocks.brokerFetch }));
vi.mock("../server/browser-captures", () => ({ requestBrowserCapture: mocks.capture }));
vi.mock("../server/browser-viewers", () => ({ browserViewers: {
  create: async (grant: BrowserGrant) => {
    mocks.grants.set(grant.id, grant); return true;
  },
  get: async (id: string) => mocks.grants.get(id), touch: async () => true,
  remove: async (id: string, userId?: number, jobId?: number) => {
    const grant = mocks.grants.get(id);
    if (!grant || (userId && grant.userId !== userId) || (jobId && grant.jobId !== jobId)) return null;
    mocks.grants.delete(id); return grant;
  },
  removeJob: async (jobId: number) => {
    const grants = Array.from(mocks.grants.values()).filter((grant) => grant.jobId === jobId);
    for (const grant of grants) mocks.grants.delete(grant.id);
    return grants;
  }, expire: async () => [],
} }));
vi.mock("../server/settle-now", () => ({ settleEndedJobsNow: mocks.settle }));
vi.mock("../server/browser-agent-bridge", () => ({
  browserAgents: { request: mocks.send, owner: mocks.available },
  hasBrowserAssistance: (metadata: { browserAssistance?: unknown } | null) => metadata?.browserAssistance === "1",
}));
import { canAccessJobBrowser, registerBrowserAssistanceRoutes } from "../server/routes-browser-assistance";

const owner = { ownerId: 10, organizationId: null } as NonNullable<EvalJob["snapshot"]>["evalFlow"];
const user = (id: number, isAdmin = false, membership: AuthUser["membership"] = null) => ({ id, isAdmin, isEnabled: true, membership }) as AuthUser;
let app: express.Express;
let job: EvalJob;
const activeGrants: string[] = [];
const base = "/api/eval-jobs/15/browser";
const status = { session_id: "session", browser_generation: "generation", pages: [], viewing: false, controlling: false, next_sequence: 1, assistance: null, capabilities: [] };
beforeEach(() => {
  vi.clearAllMocks(); mocks.user.value = user(10);
  job = { id: 15, createdBy: 10, kind: "eval", transport: "web", status: "running", evalAgentId: 20,
    startedAt: new Date("2026-11-13T01:00:00Z"), snapshot: { evalFlow: owner } } as EvalJob;
  mocks.storage.getEvalJob.mockImplementation(async () => job);
  mocks.storage.getEvalFlow.mockResolvedValue(owner);
  mocks.storage.getEvalAgent.mockResolvedValue({ id: 20, tokenId: 30, currentLeaseId: "lease", metadata: { browserAssistance: "1" } });
  mocks.storage.getEvalAgentToken.mockResolvedValue({ id: 30, isRevoked: false, createdBy: 10, dispatchTier: "public" });
  mocks.membership.mockResolvedValue(null);
  mocks.storage.getBrokerRegistrationToken.mockResolvedValue({ isRevoked: false, expiresAt: null });
  mocks.available.mockResolvedValue({ generation: "agent-generation" }); mocks.allowed.mockResolvedValue(true);
  mocks.send.mockResolvedValue({ version: 1, type: "response", id: "status", ok: true, result: status });
  mocks.capture.mockImplementation(async (grant, action, request) => mocks.send(grant.target.agentId, grant.target.leaseId,
    { jobId: grant.jobId, startedAt: grant.target.startedAt }, { action: action === "leave" ? "close" : action, viewerId: grant.id, ...(request ? { request } : {}) }));
  app = express(); app.use(express.json());
  app.use((req, _res, next) => { if (req.get("x-test-session") !== "none") req.session = { userId: (mocks.user.value as AuthUser)?.id } as express.Request["session"]; next(); });
  registerBrowserAssistanceRoutes(app);
});
afterEach(async () => {
  for (const id of activeGrants.splice(0)) {
    mocks.user.value = user(mocks.grants.get(id)?.userId ?? 10);
    await request(app).delete(`${base}/viewers/${id}`);
  }
  vi.unstubAllGlobals();
});
const grant = async () => { const response = await request(app).post(`${base}/viewers`); expect(response.status).toBe(200); activeGrants.push(response.body.viewerId); return response.body.viewerId as string; };
const command = () => ({ version: 1, id: randomUUID(), command: "viewer.take_control", session_id: "session", browser_generation: "generation", params: { wait_id: "wait" } });

describe("browser credential authority", () => {
  it("does not equate job visibility, trial creation, agent operation, or moderation with browser authority", async () => {
    for (const caller of [user(11), user(11, true)]) {
      mocks.user.value = caller;
      job.createdBy = caller.id;
      expect((await request(app).get(base)).status).toBe(403);
      expect((await request(app).post(`${base}/viewers`)).status).toBe(403);
    }
    expect(mocks.send).not.toHaveBeenCalled();
    expect(canAccessJobBrowser(user(10), { ...job, createdBy: 10 })).toBe(true);
    expect(canAccessJobBrowser(user(10, true), { ...job, snapshot: null })).toBe(false);
  });

  it("requires personal flow/credential ownership AND launching the job, without an admin bypass", async () => {
    for (const createdBy of [11, null]) {
      job.createdBy = createdBy;
      for (const isAdmin of [false, true]) {
        mocks.user.value = user(10, isAdmin);
        expect(canAccessJobBrowser(mocks.user.value as AuthUser, job)).toBe(false);
        expect((await request(app).get(base)).status).toBe(403);
        expect((await request(app).post(`${base}/viewers`)).status).toBe(403);
      }
    }
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("requires an exact organization's management role, even for the flow owner and job launcher", async () => {
    job.snapshot!.evalFlow = { ...owner, organizationId: 8 };
    for (const role of ["owner", "admin"] as const) {
      mocks.user.value = user(99, false, { organizationId: 8, role });
      expect(canAccessJobBrowser(mocks.user.value as AuthUser, job)).toBe(true);
      expect((await request(app).get(base)).status).toBe(200);
      await grant();
    }
    for (const caller of [
      user(10, false, { organizationId: 8, role: "member" }),
      user(10, true, { organizationId: 9, role: "owner" }),
      user(10, true),
    ]) {
      mocks.user.value = caller;
      expect(canAccessJobBrowser(caller, job)).toBe(false);
      expect((await request(app).get(base)).status).toBe(403);
      expect((await request(app).post(`${base}/viewers`)).status).toBe(403);
    }
  });

  it("revokes commands and removes frame grants when a team manager becomes a member", async () => {
    job.snapshot!.evalFlow = { ...owner, organizationId: 8 };
    mocks.user.value = user(99, false, { organizationId: 8, role: "admin" });
    const frames = await grant(); const input = await grant();
    mocks.user.value = user(99, false, { organizationId: 8, role: "member" });
    expect((await request(app).post(`${base}/viewers/${frames}/commands`).send(command())).status).toBe(403);
    expect((await request(app).get(`${base}/viewers/${frames}/frame`)).status).toBe(410);
    expect((await request(app).post(`${base}/viewers/${input}/commands`).send(command())).status).toBe(403);
    expect(mocks.grants.has(frames)).toBe(false);
    expect(mocks.grants.has(input)).toBe(false);
    expect(mocks.capture.mock.calls.map((call) => call[1])).toEqual(["leave", "leave"]);
  });

  it("denies a completed job even to its personal owner and launcher", async () => {
    job.status = "completed";
    expect((await request(app).get(base)).status).toBe(410);
    expect((await request(app).post(`${base}/viewers`)).status).toBe(410);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("is session-only, refuses cross-origin access, and never caches frames", async () => {
    expect((await request(app).get(base).set("x-test-session", "none").set("Authorization", "Bearer api-key")).status).toBe(401);
    expect((await request(app).get(base).set("Origin", "https://attacker.example")).status).toBe(403);
    const response = await request(app).get(base);
    expect(response.status).toBe(200); expect(response.headers["cache-control"]).toBe("no-store");
    expect(mocks.send.mock.calls[0][3]).toMatchObject({ action: "status" });
  });

  it("rechecks current permission before every command and immediately releases revoked viewers", async () => {
    const id = await grant();
    mocks.allowed.mockResolvedValue(false);
    const response = await request(app).post(`${base}/viewers/${id}/commands`).send(command());
    expect(response.status).toBe(403);
    expect(mocks.send.mock.calls).toHaveLength(1);
    expect(mocks.send.mock.calls[0][3]).toEqual({ action: "close", viewerId: id });
    expect((await request(app).post(`${base}/viewers/${id}/commands`).send(command())).status).toBe(410);
  });

  it("accepts browser-proven HTTPS same-origin requests across HTTP proxy hops, without accepting cross-origin ones", async () => {
    const headers = { Host: "vox.example", Origin: "https://vox.example" };
    expect((await request(app).post(`${base}/viewers`).set(headers)).status).toBe(403);
    expect((await request(app).post(`${base}/viewers`).set(headers).set("Sec-Fetch-Site", "cross-site")).status).toBe(403);
    expect((await request(app).post(`${base}/viewers`).set(headers).set("Sec-Fetch-Site", "same-site")).status).toBe(403);
    expect((await request(app).post(`${base}/viewers`).set(headers).set("Origin", "https://attacker.example").set("Sec-Fetch-Site", "same-origin")).status).toBe(403);
    expect((await request(app).post(`${base}/viewers`).set(headers).set("Origin", "https://vox.example:444").set("Sec-Fetch-Site", "same-origin")).status).toBe(403);
    const admitted = await request(app).post(`${base}/viewers`).set(headers).set("Sec-Fetch-Site", "same-origin");
    expect(admitted.status).toBe(200); activeGrants.push(admitted.body.viewerId);
    app.set("trust proxy", 1);
    expect((await request(app).get(base).set(headers).set("X-Forwarded-Proto", "https")).status).toBe(200);
    expect((await request(app).post(`${base}/viewers`).set(headers).set("Origin", "http://vox.example").set("X-Forwarded-Proto", "https")).status).toBe(403);
  });

  it("fences a grant to the current execution and agent lease", async () => {
    const id = await grant();
    job.startedAt = new Date("2026-11-13T02:00:00Z");
    expect((await request(app).post(`${base}/viewers/${id}/commands`).send(command())).status).toBe(410);
    expect(mocks.send.mock.calls.at(-1)?.[2]).toEqual({ jobId: 15, startedAt: "2026-11-13T01:00:00.000Z" });
    expect(mocks.send.mock.calls.at(-1)?.[3]).toEqual({ action: "close", viewerId: id });
  });

  it("rejects revoked agent tokens and schema-invalid commands before forwarding", async () => {
    const id = await grant();
    expect((await request(app).post(`${base}/viewers/${id}/commands`).send({ ...command(), command: "Runtime.evaluate" })).status).toBe(400);
    expect(mocks.send).not.toHaveBeenCalled();
    mocks.storage.getEvalAgentToken.mockResolvedValue({ id: 30, isRevoked: true });
    expect((await request(app).post(`${base}/viewers/${id}/commands`).send(command())).status).toBe(410);
  });

  it("rejects third-party agent browsers even with shared-session consent, while allowing Mainline and own agents", async () => {
    job.snapshot!.credentialConsent = true;
    for (const dispatchTier of ["public", "private", "shared"]) {
      mocks.storage.getEvalAgentToken.mockResolvedValue({ id: 30, isRevoked: false, createdBy: 10, dispatchTier });
      expect((await request(app).get(base)).body.available).toBe(true);
    }
    mocks.send.mockClear();
    for (const dispatchTier of ["private", "shared", "team"]) {
      mocks.storage.getEvalAgentToken.mockResolvedValue({ id: 30, isRevoked: false, createdBy: 11, dispatchTier });
      expect((await request(app).get(base)).body.available).toBe(false);
      expect((await request(app).post(`${base}/viewers`)).status).toBe(503);
    }
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("allows Team-agent browsers only while the token operator belongs to the frozen organization", async () => {
    job.snapshot!.evalFlow = { ...owner, organizationId: 8 };
    mocks.user.value = user(99, false, { organizationId: 8, role: "admin" });
    mocks.storage.getEvalAgentToken.mockResolvedValue({ id: 30, isRevoked: false, createdBy: 11, dispatchTier: "team" });
    mocks.membership.mockResolvedValue({ organizationId: 8, role: "member" });
    expect((await request(app).get(base)).body.available).toBe(true);
    mocks.membership.mockResolvedValue({ organizationId: 9, role: "owner" });
    expect((await request(app).get(base)).body.available).toBe(false);
  });

  it("routes brokered login viewing only to the broker's private operation, without credentials on the agent bridge", async () => {
    mocks.storage.getEvalAgentToken.mockResolvedValue({ id: 30, isRevoked: false, createdBy: 11, dispatchTier: "shared" });
    job.snapshot!.sessionInjection = { platformId: "fixture", emailSecret: "EMAIL", passwordSecret: "PASSWORD" };
    mocks.classes.mockResolvedValue([{ present: true, brokerType: "auth-session" }]);
    const operation = randomUUID();
    mocks.storage.getWebSession.mockResolvedValue({ status: "minting", mintBrokerId: 9, mintOperationId: operation, mintDeadlineAt: new Date(Date.now() + 30000) });
    mocks.storage.getBroker.mockResolvedValue({ id: 9, url: "http://broker.internal", state: "busy" });
    mocks.secret.mockResolvedValue({ id: 9, owner: { generation: "broker-generation" } });
    mocks.brokerFetch.mockResolvedValue({ ok: true, json: async () => ({ result: { ok: true, result: status } }) });
    const response = await request(app).get(base);
    expect(response.body).toMatchObject({ available: true, target: "broker" });
    expect(mocks.brokerFetch.mock.calls[0][1]).toBe("/browser");
    expect(JSON.parse(mocks.brokerFetch.mock.calls[0][2])).toMatchObject({ operationId: operation, action: "status" });
    expect(JSON.stringify(response.body)).not.toMatch(/private-mint-key|PASSWORD|EMAIL/);
    expect(mocks.send).not.toHaveBeenCalled();
    mocks.storage.getBrokerRegistrationToken.mockResolvedValue({ isRevoked: true });
    expect((await request(app).get(base)).body.available).toBe(false);
  });

  it("admits concurrent grants and asks the capture coordinator to detach only the closed viewer", async () => {
    const id = await grant(); const second = await grant(); expect(second).not.toBe(id);
    expect((await request(app).delete(`${base}/viewers/${id}`)).status).toBe(200);
    expect(mocks.capture.mock.calls.at(-1)?.slice(1)).toEqual(["leave"]);
    expect(mocks.grants.has(second)).toBe(true);
  });

  it("cancels only the fenced web execution, and never sends global cancellation to a shared login mint", async () => {
    job.evalFlowId = 1; mocks.storage.cancelRunningEvalJob.mockResolvedValue({ ...job, status: "failed" });
    mocks.send.mockResolvedValueOnce({ cancelled: true });
    const response = await request(app).post(`${base}/cancel-job`);
    expect(response.status).toBe(200); expect(response.body.cancellationDelivery).toBe("acknowledged");
    expect(mocks.storage.cancelRunningEvalJob).toHaveBeenCalledWith(15, 10, job.startedAt);
    expect(mocks.send.mock.calls.at(-1)?.[3]).toEqual({ action: "cancel" });
    expect(mocks.settle).toHaveBeenCalled();
    mocks.storage.cancelRunningEvalJob.mockResolvedValue(undefined);
    expect((await request(app).post(`${base}/cancel-job`)).status).toBe(409);
  });

  it("does not treat an unrelated or negative reply as an acknowledged stop", async () => {
    mocks.storage.cancelRunningEvalJob.mockResolvedValue({ ...job, status: "failed" });
    for (const result of [undefined, { cancelled: false }, { ok: true }]) {
      mocks.send.mockResolvedValueOnce(result);
      expect((await request(app).post(`${base}/cancel-job`)).body.cancellationDelivery).toBe("pending");
    }
  });

  it("does not cancel for a user disabled after session middleware ran", async () => {
    mocks.user.value = { ...user(10), isEnabled: false };
    expect((await request(app).post(`${base}/cancel-job`)).status).toBe(401);
    expect(mocks.storage.cancelRunningEvalJob).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("reports a pending stop when cancellation cannot reach the agent and does not refund paid active work", async () => {
    mocks.storage.cancelRunningEvalJob.mockResolvedValue({ ...job, status: "failed" });
    mocks.send.mockRejectedValue(new Error("owner offline"));
    const response = await request(app).post(`${base}/cancel-job`);
    expect(response.status).toBe(200); expect(response.body.cancellationDelivery).toBe("pending");
    mocks.storage.cancelRunningEvalJob.mockClear(); mocks.settle.mockClear();
    job.snapshot!.settlementContext = { hold: "paid" };
    expect((await request(app).post(`${base}/cancel-job`)).status).toBe(409);
    expect(mocks.storage.cancelRunningEvalJob).not.toHaveBeenCalled();
    expect(mocks.settle).not.toHaveBeenCalled();
    expect((await request(app).post("/api/eval-jobs/not-a-number/browser/cancel-job")).status).toBe(400);
  });
});
