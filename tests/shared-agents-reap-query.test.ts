import { describe, it, expect, afterAll } from "vitest";
import { storage, pool } from "../server/storage";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

d("storage.getReapableSharedJobs", () => {
  // Everything this suite creates, removed afterwards (#95): these rows live in
  // the shared dev DB, and the live server's reap sweep would otherwise keep
  // picking up their fake settlement ids.
  const jobIds: number[] = [];
  const tokenIds: number[] = [];
  afterAll(async () => {
    if (jobIds.length) await pool.query("DELETE FROM eval_jobs WHERE id = ANY($1::int[])", [jobIds]);
    if (tokenIds.length) await pool.query("DELETE FROM eval_agent_tokens WHERE id = ANY($1::int[])", [tokenIds]);
  });

  it("includes recently-failed targeted jobs with settlementContext, excludes those without", async () => {
    // createdBy=1 (admin) and region na-us-ashburn-01 exist after dev-DB init/seed.
    const token = await storage.createEvalAgentToken({
      name: "reap-query-test",
      tokenHash: `reap-test-${Date.now()}`,
      siteId: "na-us-ashburn-01",
      createdBy: 1,
    } as any);
    tokenIds.push(token.id);

    // Targeted + carries settlementContext → should be returned once failed.
    const included = await storage.createEvalJob({
      evalFlowId: null, triggerType: 2, evalSetId: null, createdBy: 1,
      siteId: "na-us-ashburn-01", targetTokenId: token.id,
      config: {}, snapshot: { provider: null, evalFlow: null, evalSet: null, creatorPlan: null,
        settlementContext: { settlementId: 424242 } } as any,
      status: "pending", priority: 0, retryCount: 0, maxRetries: 3,
    } as any);
    jobIds.push(included.id);

    // Targeted but NO settlementContext → must be excluded.
    const excluded = await storage.createEvalJob({
      evalFlowId: null, triggerType: 2, evalSetId: null, createdBy: 1,
      siteId: "na-us-ashburn-01", targetTokenId: token.id,
      config: {}, snapshot: { provider: null, evalFlow: null, evalSet: null, creatorPlan: null } as any,
      status: "pending", priority: 0, retryCount: 0, maxRetries: 3,
    } as any);
    jobIds.push(excluded.id);

    // Make both genuinely failed with a fresh completed_at (completeEvalJob sets
    // status=failed + completedAt=now on any job, unlike finalizeRunningJob which
    // only touches running jobs).
    await storage.completeEvalJob(included.id, "boom");
    await storage.completeEvalJob(excluded.id, "boom");

    // COMPLETED + settlementContext → must ALSO be returned (review C1: a
    // completed-but-unsettled job must be re-driven for capture, not left to the
    // leak-reaper). completeEvalJob sets status=failed, so drive completed via the
    // running→completed transition.
    const includedCompleted = await storage.createEvalJob({
      evalFlowId: null, triggerType: 2, evalSetId: null, createdBy: 1,
      siteId: "na-us-ashburn-01", targetTokenId: token.id,
      config: {}, snapshot: { provider: null, evalFlow: null, evalSet: null, creatorPlan: null,
        settlementContext: { settlementId: 424243 } } as any,
      status: "running", priority: 0, retryCount: 0, maxRetries: 3,
    } as any);
    jobIds.push(includedCompleted.id);
    await storage.finalizeRunningJob(includedCompleted.id, undefined); // running → completed

    // graceMinutes=0 → no grace exclusion, so jobs completed just now are eligible.
    const rows = await storage.getReapableSharedJobs(60, 0, 500);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(included.id);      // the real assertion: query returns it
    expect(ids).not.toContain(excluded.id);  // no settlementContext → excluded
    expect(ids).toContain(includedCompleted.id); // completed jobs are reapable too (C1)
  });

  it("grace period excludes a job that turned terminal too recently (GitHub #90)", async () => {
    const token = await storage.createEvalAgentToken({
      name: "reap-grace-test",
      tokenHash: `reap-grace-${Date.now()}`,
      siteId: "na-us-ashburn-01",
      createdBy: 1,
    } as any);
    tokenIds.push(token.id);

    // A completed, targeted, settlement-bearing job — the money path. Drive it
    // through running→completed so its completed_at is ~now (inside the grace window).
    const job = await storage.createEvalJob({
      evalFlowId: null, triggerType: 2, evalSetId: null, createdBy: 1,
      siteId: "na-us-ashburn-01", targetTokenId: token.id,
      config: {}, snapshot: { provider: null, evalFlow: null, evalSet: null, creatorPlan: null,
        settlementContext: { settlementId: 909090 } } as any,
      status: "running", priority: 0, retryCount: 0, maxRetries: 3,
    } as any);
    jobIds.push(job.id);
    await storage.finalizeRunningJob(job.id, undefined); // running → completed, completed_at=now

    // With a 1-minute grace, a just-completed job must NOT be swept: this is the
    // window where its evalResults row may not be written yet, so settling now would
    // refund a valid job. It is excluded until it ages past the grace.
    const withGrace = await storage.getReapableSharedJobs(60, 1, 500);
    expect(withGrace.map((r) => r.id)).not.toContain(job.id);

    // Same job with no grace IS eligible — proves the exclusion is the grace bound,
    // not some other filter.
    const noGrace = await storage.getReapableSharedJobs(60, 0, 500);
    expect(noGrace.map((r) => r.id)).toContain(job.id);
  });

  it("returns candidates oldest-first so a backlog drains before aging out (#7)", async () => {
    const token = await storage.createEvalAgentToken({
      name: "reap-order-test",
      tokenHash: `reap-order-${Date.now()}`,
      siteId: "na-us-ashburn-01",
      createdBy: 1,
    } as any);
    tokenIds.push(token.id);

    // Seed two targeted, settlement-bearing jobs and finalize them in sequence so
    // this test proves ordering on its OWN rows rather than relying on state left by
    // earlier tests in this describe (which would let it pass vacuously if they were
    // removed or reordered). Two awaited finalizes give distinct completed_at.
    const first = await storage.createEvalJob({
      evalFlowId: null, triggerType: 2, evalSetId: null, createdBy: 1,
      siteId: "na-us-ashburn-01", targetTokenId: token.id,
      config: {}, snapshot: { provider: null, evalFlow: null, evalSet: null, creatorPlan: null,
        settlementContext: { settlementId: 707071 } } as any,
      status: "running", priority: 0, retryCount: 0, maxRetries: 3,
    } as any);
    jobIds.push(first.id);
    await storage.finalizeRunningJob(first.id, undefined);
    const second = await storage.createEvalJob({
      evalFlowId: null, triggerType: 2, evalSetId: null, createdBy: 1,
      siteId: "na-us-ashburn-01", targetTokenId: token.id,
      config: {}, snapshot: { provider: null, evalFlow: null, evalSet: null, creatorPlan: null,
        settlementContext: { settlementId: 707072 } } as any,
      status: "running", priority: 0, retryCount: 0, maxRetries: 3,
    } as any);
    jobIds.push(second.id);
    await storage.finalizeRunningJob(second.id, undefined);

    const rows = await storage.getReapableSharedJobs(60, 0, 500);
    // Not vacuous: our two seeded rows must be present.
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(first.id);
    expect(ids).toContain(second.id);
    expect(rows.length).toBeGreaterThanOrEqual(2);

    const times = rows.map((r) => (r.completedAt as Date).getTime());
    const sorted = [...times].sort((a, b) => a - b);
    expect(times).toEqual(sorted); // completed_at ascending (robust to equal-time ties)
  });

  // #97: settled jobs used to stay eligible for the whole lookback window, so
  // under load they filled every batch and an unsettled job behind them aged
  // out to the leak reaper's refund. Jobs here sit in a private completion-time
  // window (50–51 min ago) so the shared dev DB can't crowd the batch.
  it("settled jobs leave the sweep, so a backlog larger than the batch still reaches the unsettled job", async () => {
    const token = await storage.createEvalAgentToken({
      name: "reap-done-test", tokenHash: `reap-done-${Date.now()}`, siteId: "na-us-ashburn-01", createdBy: 1,
    } as any);
    tokenIds.push(token.id);
    const mk = async (settlementId: number, minutesAgo: number) => {
      const job = await storage.createEvalJob({
        evalFlowId: null, triggerType: 2, evalSetId: null, createdBy: 1,
        siteId: "na-us-ashburn-01", targetTokenId: token.id,
        config: {}, snapshot: { provider: null, evalFlow: null, evalSet: null, creatorPlan: null,
          settlementContext: { settlementId } } as any,
        status: "running", priority: 0, retryCount: 0, maxRetries: 3,
      } as any);
      jobIds.push(job.id);
      await storage.finalizeRunningJob(job.id, undefined);
      await pool.query("UPDATE eval_jobs SET completed_at = now() - make_interval(secs => $2) WHERE id = $1", [job.id, minutesAgo * 60]);
      return job.id;
    };
    // Five already-settled jobs, older than the one that still needs settling.
    const settled: number[] = [];
    for (let i = 0; i < 5; i++) settled.push(await mk(818180 + i, 50.9 - i * 0.01));
    const unsettled = await mk(818189, 50.5);
    for (const id of settled) await storage.markSettlementDone((await storage.getEvalJob(id))!);

    // Window [now-51m, now-50m], batch of 3: before the marker, the 3 oldest
    // (settled) rows filled it and the unsettled job was never reached.
    const rows = await storage.getReapableSharedJobs(51, 50, 3);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(unsettled);
    for (const id of settled) expect(ids).not.toContain(id);
  });

  it("markSettlementDone only marks a terminal job — a job rolled back to running stays sweepable", async () => {
    const token = await storage.createEvalAgentToken({
      name: "reap-done-running", tokenHash: `reap-done-run-${Date.now()}`, siteId: "na-us-ashburn-01", createdBy: 1,
    } as any);
    tokenIds.push(token.id);
    const job = await storage.createEvalJob({
      evalFlowId: null, triggerType: 2, evalSetId: null, createdBy: 1,
      siteId: "na-us-ashburn-01", targetTokenId: token.id,
      config: {}, snapshot: { provider: null, evalFlow: null, evalSet: null, creatorPlan: null,
        settlementContext: { settlementId: 818199 } } as any,
      status: "running", priority: 0, retryCount: 0, maxRetries: 3,
    } as any);
    jobIds.push(job.id);
    await storage.markSettlementDone({ id: job.id, status: "running" });
    expect((await storage.getEvalJob(job.id))!.settlementDoneAt).toBeNull();
    // settle() saw it running (and did nothing); a reaper then fails it before
    // the mark is written. The mark must still not hide it from the sweep.
    await storage.finalizeRunningJob(job.id, undefined);
    await storage.markSettlementDone({ id: job.id, status: "running" });
    expect((await storage.getEvalJob(job.id))!.settlementDoneAt).toBeNull();
    // Settled as terminal: marked.
    const final = (await storage.getEvalJob(job.id))!;
    await storage.markSettlementDone(final);
    expect((await storage.getEvalJob(job.id))!.settlementDoneAt).not.toBeNull();
  });
});

