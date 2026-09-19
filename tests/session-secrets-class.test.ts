import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { storage, encryptValue } from "../server/storage";
import { db } from "../server/storage";
import { orgRuntimeSecretsForJob } from "../server/routes";
import { setOrganizations, resetOrganizations } from "../server/organizations";
import { setupOrganizationsDb, type OrgsHarness } from "./helpers/organizations-db";
import { secrets, users, evalJobs, providers } from "../shared/schema";
import { eq } from "drizzle-orm";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

// Resolve a real seeded provider id at run time — provider ids are fresh
// nanoids per seed, so hardcoding one breaks on any freshly-reset DB.
async function anyProviderId(): Promise<string> {
  const [p] = await db.select({ id: providers.id }).from(providers).limit(1);
  if (!p) throw new Error("no providers seeded");
  return p.id;
}

d("login-class secrets are withheld from the job path", () => {
  // The org path runs the fence in Core through the vox.organizations seam (R3),
  // and post-flip the seam's data lives in the `organizations` plugin — so this
  // suite installs the real plugin provider on the dedicated plugin test DB and
  // seeds the org fixtures there. Core-side rows (users, workflow, job,
  // personal secrets) stay in the dev DB.
  let h: OrgsHarness;

  beforeAll(async () => {
    h = await setupOrganizationsDb();
    setOrganizations(h.provider);
  });

  afterAll(async () => {
    resetOrganizations();
    await h.pool.query(`DROP SCHEMA IF EXISTS "${h.schema}" CASCADE`);
    await h.pool.end();
  });

  it("getSecretsForJob returns runtime rows only; login rows never leave Core", async () => {
    const stamp = Date.now();
    const providerId = await anyProviderId();
    // Personal workflow owned by admin (user 1).
    const project = await storage.createProject({ name: `sc-proj-${stamp}`, ownerId: 1 } as any);
    const wf = await storage.createWorkflow({
      name: `sc-wf-${stamp}`, ownerId: 1, projectId: project.id,
      providerId, visibility: "private", isMainline: false, config: {},
    } as any);
    // One runtime + one login secret for the owner.
    await db.insert(secrets).values({
      userId: 1, name: `SC_RUNTIME_${stamp}`, encryptedValue: encryptValue("ok"), brokerType: null,
    });
    await db.insert(secrets).values({
      userId: 1, name: `SC_LOGIN_${stamp}`, encryptedValue: encryptValue("hunter2"), brokerType: "auth-session",
    });
    const job = await storage.createEvalJob({
      workflowId: wf.id, triggerType: 2, evalSetId: null, createdBy: 1,
      siteId: "na-us-ashburn-01", config: {},
      snapshot: { provider: null, workflow: null, evalSet: null, creatorPlan: null } as any,
      status: "pending", priority: 0, retryCount: 0, maxRetries: 3,
    } as any);

    const rows = await storage.getSecretsForJob(job.id);
    const names = rows.map(r => r.name);
    expect(names).toContain(`SC_RUNTIME_${stamp}`);
    expect(names).not.toContain(`SC_LOGIN_${stamp}`);

    // Cleanup (delete only our stamped rows/objects).
    await db.delete(secrets).where(eq(secrets.name, `SC_RUNTIME_${stamp}`));
    await db.delete(secrets).where(eq(secrets.name, `SC_LOGIN_${stamp}`));
    // evalJobs.workflowId is ON DELETE SET NULL, so the job row (left in place,
    // matching the repo's existing test pattern) does not block this delete.
    await storage.deleteWorkflow(wf.id);
    await storage.deleteProject(project.id);
  });

  it("orgRuntimeSecretsForJob returns runtime rows only; login rows never leave Core", async () => {
    const stamp = Date.now();
    const providerId = await anyProviderId();
    // Throwaway org (plugin-side) + throwaway member user, so we never touch
    // admin user 1.
    const orgRow = await h.db.query<{ id: number }>(
      "INSERT INTO organizations (name) VALUES ($1) RETURNING id", [`sc-org-${stamp}`]);
    const orgId = orgRow.rows[0].id;
    const user = await storage.createUser({
      username: `sc-user-${stamp}`,
      email: `sc-user-${stamp}@test.local`,
    } as any);
    await h.provider.addMember(orgId, user.id, "member");
    // Org-owned workflow: organizationId set (an opaque integer since the
    // Release A FK drop), owned by the throwaway member.
    const wf = await storage.createWorkflow({
      name: `sc-org-wf-${stamp}`, ownerId: user.id, organizationId: orgId,
      providerId, visibility: "private", isMainline: false, config: {},
    } as any);
    // One runtime + one login org secret, written through the seam.
    await h.provider.upsertOrgSecret(orgId, {
      name: `SC_ORG_RUNTIME_${stamp}`, encryptedValue: encryptValue("ok"),
      brokerType: null, isTestAccount: false, createdBy: user.id,
    });
    await h.provider.upsertOrgSecret(orgId, {
      name: `SC_ORG_LOGIN_${stamp}`, encryptedValue: encryptValue("hunter2"),
      brokerType: "auth-session", isTestAccount: false, createdBy: user.id,
    });
    const job = await storage.createEvalJob({
      workflowId: wf.id, triggerType: 2, evalSetId: null, createdBy: user.id,
      siteId: "na-us-ashburn-01", config: {},
      snapshot: { provider: null, workflow: null, evalSet: null, creatorPlan: null } as any,
      status: "pending", priority: 0, retryCount: 0, maxRetries: 3,
    } as any);

    const result = await orgRuntimeSecretsForJob(job.id);
    expect(result[`SC_ORG_RUNTIME_${stamp}`]).toBe("ok");
    expect(result).not.toHaveProperty(`SC_ORG_LOGIN_${stamp}`);

    // Cleanup of the Core-side rows, in FK-safe order: job (frees
    // users.createdBy FK, which has no ON DELETE action) -> workflow (frees
    // users.ownerId) -> user. The org + its secrets are plugin-side and die
    // with the throwaway schema in afterAll.
    await db.delete(evalJobs).where(eq(evalJobs.id, job.id));
    await storage.deleteWorkflow(wf.id);
    await db.delete(users).where(eq(users.id, user.id));
  });
});
