import { describe, it, expect, afterAll } from "vitest";
import { storage, pool } from "../server/storage";

// #84: the two pending-job reapers on the real SQL (they used to be tested
// through TypeScript copies of their predicates, which a regression in the
// SQL would not have failed):
//   failPendingJobsWithNoAgent — strikes a site-pinned job after 15 min with no
//     online agent for its site; ages from GREATEST(created_at, updated_at), so
//     a requeue restarts that clock (#82 then requeues it, counting the strike);
//   failExpiredPendingJobs — fails any job still pending 24 h after it was
//     CREATED (#213: a requeue doesn't buy more time).
// Every case uses its own site and backdates only its own rows: the dev DB is
// shared with parallel suites, so no zero-minute (global) sweeps.
const d = process.env.DATABASE_URL ? describe : describe.skip;
const jobIds: number[] = [];
const tokenIds: number[] = [];

afterAll(async () => {
  if (jobIds.length) await pool.query("DELETE FROM eval_jobs WHERE id = ANY($1)", [jobIds]);
  if (tokenIds.length) {
    await pool.query("DELETE FROM eval_agents WHERE token_id = ANY($1)", [tokenIds]);
    await pool.query("DELETE FROM eval_agent_tokens WHERE id = ANY($1)", [tokenIds]);
  }
});

const site = (tag: string) => `zz-reap-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}-01`;

/** A site-pinned pending job, created `createdMin` and last queued `updatedMin` minutes ago. */
async function pinnedJob(siteId: string, createdMin: number, updatedMin = createdMin) {
  const job = await storage.createEvalJob({
    evalFlowId: null, triggerType: 2, evalSetId: null, createdBy: 2, siteId, targetRegion: null, targetTier: null, config: {},
    snapshot: { provider: null, evalFlow: null, evalSet: null, creatorPlan: null } as any,
    status: "pending", priority: 0, retryCount: 0, maxRetries: 3,
  } as any);
  jobIds.push(job.id);
  await pool.query(
    "UPDATE eval_jobs SET created_at = now() - make_interval(mins => $2), updated_at = now() - make_interval(mins => $3) WHERE id = $1",
    [job.id, createdMin, updatedMin],
  );
  return job.id;
}

/** An agent at `siteId`, state `state`, last seen `seenMin` minutes ago. */
async function agentAt(siteId: string, state: "idle" | "occupied", seenMin: number) {
  const tok = await storage.createEvalAgentToken({
    name: `reap-${Date.now()}`, tokenHash: `reap-${Date.now()}-${Math.random()}`, siteId, dispatchTier: "public", createdBy: 1,
  } as any);
  tokenIds.push(tok.id);
  const agent = await storage.createEvalAgent({ tokenId: tok.id, name: `reap-a-${Date.now()}`, siteId, state, metadata: {} } as any);
  await pool.query("UPDATE eval_agents SET last_seen_at = now() - make_interval(mins => $2) WHERE id = $1", [agent.id, seenMin]);
}

const sweep = () => storage.failPendingJobsWithNoAgent(15, 5, true);
const struck = async (id: number) => (await storage.getEvalJob(id))!.unclaimedCount > 0;

d("#84 no-agent reaper (real SQL)", () => {
  it("a requeue restarts its clock: old created_at, fresh updated_at is left alone", async () => {
    const fresh = await pinnedJob(site("requeued"), 40, 0);
    const due = await pinnedJob(site("requeued-due"), 40, 20);
    await sweep();
    expect(await struck(fresh)).toBe(false);
    expect(await struck(due)).toBe(true);
  });

  it("an idle agent at the site spares its jobs", async () => {
    const s = site("idle");
    await agentAt(s, "idle", 1);
    const job = await pinnedJob(s, 30);
    await sweep();
    expect(await struck(job)).toBe(false);
  });

  it("a busy agent that still heartbeats spares its site's jobs", async () => {
    const s = site("busy");
    await agentAt(s, "occupied", 1);
    const job = await pinnedJob(s, 30);
    await sweep();
    expect(await struck(job)).toBe(false);
  });

  it("an online agent at another site doesn't count", async () => {
    const s = site("lonely");
    await agentAt(site("elsewhere"), "idle", 1);
    const job = await pinnedJob(s, 30);
    await sweep();
    expect(await struck(job)).toBe(true);
  });

  it("an agent that stopped heartbeating doesn't count", async () => {
    const s = site("stale");
    await agentAt(s, "idle", 10);
    const job = await pinnedJob(s, 30);
    await sweep();
    expect(await struck(job)).toBe(true);
  });

  it("a job younger than the timeout is left alone even with no agent", async () => {
    const job = await pinnedJob(site("young"), 10);
    await sweep();
    expect(await struck(job)).toBe(false);
  });

  it("never touches a running job", async () => {
    const job = await pinnedJob(site("running"), 60);
    await pool.query("UPDATE eval_jobs SET status = 'running' WHERE id = $1", [job]);
    await sweep();
    expect(await struck(job)).toBe(false);
  });

  it("strikes a day-old unstaffed job first, so it gets the clearer 'no agent' reason", async () => {
    const job = await pinnedJob(site("day-unstaffed"), 25 * 60);
    await sweep();
    expect(await struck(job)).toBe(true);
  });

  it("fails the job, naming its site, once its strikes are used up", async () => {
    const s = site("out-of-strikes");
    const job = await pinnedJob(s, 30);
    await pool.query("UPDATE eval_jobs SET unclaimed_count = max_retries WHERE id = $1", [job]);
    await sweep();
    const after = (await storage.getEvalJob(job))!;
    expect(after.status).toBe("failed");
    expect(after.error).toContain(s);
  });
});

d("#84 24 h backstop (real SQL)", () => {
  it("fails a job still pending a day after it was created, and not before", async () => {
    // An online agent at each site, so only the backstop can act.
    const old = site("day-old");
    const young = site("day-young");
    await agentAt(old, "idle", 1);
    await agentAt(young, "idle", 1);
    const dayOld = await pinnedJob(old, 25 * 60);
    const almost = await pinnedJob(young, 23 * 60);
    await storage.failExpiredPendingJobs(24 * 60, true);
    expect((await storage.getEvalJob(dayOld))!.status).toBe("failed");
    expect((await storage.getEvalJob(almost))!.status).toBe("pending");
  });

  it("a requeue doesn't reset the day: it ages from created_at", async () => {
    const s = site("day-requeued");
    await agentAt(s, "idle", 1);
    const job = await pinnedJob(s, 25 * 60, 5);
    await storage.failExpiredPendingJobs(24 * 60, true);
    expect((await storage.getEvalJob(job))!.status).toBe("failed");
  });

  it("never touches a finished job", async () => {
    const job = await pinnedJob(site("day-done"), 48 * 60);
    await pool.query("UPDATE eval_jobs SET status = 'completed' WHERE id = $1", [job]);
    await storage.failExpiredPendingJobs(24 * 60, true);
    expect((await storage.getEvalJob(job))!.status).toBe("completed");
  });
});
