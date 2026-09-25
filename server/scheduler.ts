//
// Background workers: the maintenance sweep and the job scheduler tick.
//
// Extracted verbatim from server/index.ts (which keeps the setInterval wiring)
// so both ticks can be invoked directly — by a test, or by any future runner —
// without booting the HTTP server.

import { storage, mergeEvalConfig, buildJobSnapshot } from "./storage";
import { canScheduleEvalflow, sessionPoolViolation } from "./permissions";
import { parseNextCronRun } from "./cron";
import { getMarketplace } from "./marketplace";
import { getOrganizations, type Membership } from "./organizations";
import { stampOwnerSession, detectSessionNeed, missingSecretNames, sessionScopeForEvalflow, resolvableSecretSources } from "./auth-session";
import { log } from "./log";

// Global hard cap on how long a single eval job may stay "running" before the
// background reaper fails it (agent zombied/superseded/killed). Tune here.
const MAX_JOB_RUN_MINUTES = 90;

// A "pending" job is one no agent has claimed yet. Two reapers keep it from
// hanging forever (nothing else touches the pending state):
//   - PENDING_NO_AGENT_TIMEOUT_MINUTES: fast-fail when the job's site has no
//     online agent — an unstaffed/misconfigured site. Long enough to survive a
//     routine agent restart or host reboot, short enough to give the user an
//     actionable "no agent for site X" result in minutes, not a full day.
//   - PENDING_MAX_WAIT_MINUTES: absolute backstop for anything the fast-fail
//     misses (site has an online agent that somehow never claims the job).
const PENDING_NO_AGENT_TIMEOUT_MINUTES = 15;
const PENDING_MAX_WAIT_MINUTES = 24 * 60;
const REAP_SETTLE_LOOKBACK_MINUTES = 15; // window for the prompt reap-settle sweep
// Skip jobs that turned terminal within the last minute: the complete route commits
// `completed` before it writes the eval-result row, so a sweep in that window would
// refund a job that yields a valid result an instant later (GitHub #90). One minute
// is far longer than the finalize→result gap and well inside the 15-min lookback.
// MUST stay < REAP_SETTLE_LOOKBACK_MINUTES: the sweep selects completed_at in
// [now-lookback, now-grace], so grace ≥ lookback yields an empty range and silently
// disables the catch-up path entirely.
const REAP_SETTLE_GRACE_MINUTES = 1;

const STALE_THRESHOLD_MINUTES = 5;

export async function runMaintenanceTasks() {
  try {
    // Release stale jobs (jobs where agent hasn't sent heartbeat)
    const releasedJobs = await storage.releaseStaleJobs(STALE_THRESHOLD_MINUTES);
    if (releasedJobs > 0) {
      log(`Released ${releasedJobs} stale job(s)`, "worker");
    }

    // Fail jobs stuck "running" past the global hard cap (agent zombied/
    // superseded, so the heartbeat check above never catches them).
    const timedOut = await storage.failTimedOutRunningJobs(MAX_JOB_RUN_MINUTES);
    if (timedOut > 0) {
      log(`Failed ${timedOut} job(s) exceeding ${MAX_JOB_RUN_MINUTES}min run time`, "worker");
    }

    // With organizations unavailable, a team-tier job is un-runnable through no
    // fault of its own — exclude those rows from both sweeps so an outage never
    // converts "waiting" into a permanent `failed` (§7: absence is inert).
    const excludeTeamTier = getOrganizations() === null;

    // Fast-fail pending jobs whose site has no online agent (run before the
    // backstop so those get the clearer "no agent for site" reason).
    const noAgent = await storage.failPendingJobsWithNoAgent(
      PENDING_NO_AGENT_TIMEOUT_MINUTES,
      STALE_THRESHOLD_MINUTES,
      excludeTeamTier,
    );
    if (noAgent > 0) {
      log(`Failed ${noAgent} pending job(s) with no agent for their site`, "worker");
    }

    // Backstop: fail any pending job that has waited past the hard cap.
    const expired = await storage.failExpiredPendingJobs(PENDING_MAX_WAIT_MINUTES, excludeTeamTier);
    if (expired > 0) {
      log(`Failed ${expired} pending job(s) exceeding ${PENDING_MAX_WAIT_MINUTES}min wait`, "worker");
    }

    // Mark offline agents
    const offlineAgents = await storage.markOfflineAgents(STALE_THRESHOLD_MINUTES);
    if (offlineAgents > 0) {
      log(`Marked ${offlineAgents} agent(s) as offline`, "worker");
    }

    // Mark offline brokers (row kept — never deleted)
    const offlineBrokers = await storage.markStaleBrokersOffline(STALE_THRESHOLD_MINUTES);
    if (offlineBrokers > 0) {
      log(`Marked ${offlineBrokers} broker(s) as offline`, "worker");
    }

    // Promptly settle shared-dispatch escrow for recently-terminal targeted jobs:
    // capture on `completed`, release on `failed`. This is the prompt path so a
    // completed-but-unsettled job (complete-route settle threw) is captured here,
    // not eventually released by the 26h leak-reaper. No-op when the marketplace
    // seam is absent; settle() is idempotent, so re-visiting a settled job is cheap.
    const marketplace = getMarketplace();
    if (marketplace) {
      const REAP_SETTLE_BATCH = 200;
      const reapable = await storage.getReapableSharedJobs(REAP_SETTLE_LOOKBACK_MINUTES, REAP_SETTLE_GRACE_MINUTES, REAP_SETTLE_BATCH);
      // Honest saturation signal (not a cry-wolf): a FULL batch alone is normal —
      // settled jobs stay query-eligible (no settled-marker yet), so ~lookback×rate
      // rows always sit in the window even when we're keeping up. The real danger is
      // only when the batch is full AND its oldest row (front of the oldest-first
      // scan) is within 2 min of falling out of the lookback window — that means the
      // rows behind the batch cap are even older and will age out to the 26h
      // leak-reaper unsettled. Warn only then; stays quiet under healthy throughput.
      // The cure (stop settled rows consuming the batch) is a settled-marker
      // follow-up — see GitHub #90.
      const oldestCompletedAt = reapable[0]?.completedAt;
      if (
        reapable.length === REAP_SETTLE_BATCH &&
        oldestCompletedAt &&
        oldestCompletedAt.getTime() < Date.now() - (REAP_SETTLE_LOOKBACK_MINUTES - 2) * 60 * 1000
      ) {
        log(`Reap-settle sweep is falling behind — oldest of ${REAP_SETTLE_BATCH} batched jobs is near the ${REAP_SETTLE_LOOKBACK_MINUTES}min lookback edge; jobs behind the cap may age out unsettled`, "worker");
      }
      for (const job of reapable) {
        try {
          // Pass the artifact gate (hasResult) so a completed-but-resultless job
          // refunds instead of paying out on a bare self-report (review H1).
          const hasResult = await storage.hasEvalResult(job.id);
          await marketplace.settle({
            jobId: job.id,
            status: job.status,
            hasResult,
            settlementContext: (job.snapshot as { settlementContext?: unknown } | null)?.settlementContext,
          });
        } catch (settleErr) {
          console.error(`Reap settlement failed for job ${job.id}:`, settleErr);
        }
      }
    }
  } catch (error) {
    console.error("Background worker error:", error);
  }
}

export async function processScheduledJobs() {
  try {
    // Get all due schedules
    const dueSchedules = await storage.getDueSchedules();
    // Org-dependent schedules skipped this tick because organizations were
    // unavailable — org-owned evalflows AND team-tier schedules (see the
    // discriminator below). Counted, not logged per schedule: a provider outage
    // affects every one of them at once, and one line per tick keeps the log
    // readable (§7).
    let orgSkips = 0;

    for (const schedule of dueSchedules) {
      try {
        // Expired schedules stop firing (kept enabled so an Extend resumes them
        // without re-enabling). getDueSchedules already filters these in SQL;
        // this guard covers the query→loop race and avoids the fetches below.
        if (schedule.expiresAt && schedule.expiresAt.getTime() <= Date.now()) {
          continue;
        }
        // A schedule whose evalflow or eval-set was deleted (FK SET NULL) can never
        // run — DISABLE it so it isn't re-selected on every tick (zombie). It stays
        // in the list (with a placeholder) for the user to clean up.
        const evalflow = schedule.evalflowId != null ? await storage.getEvalflow(schedule.evalflowId) : undefined;
        const evalSet = schedule.evalSetId != null ? await storage.getEvalSet(schedule.evalSetId) : undefined;
        if (!evalflow || !evalSet) {
          log(`Schedule "${schedule.name}" references a deleted evalflow/eval-set — disabling`, "scheduler");
          await storage.updateEvalSchedule(schedule.id, { isEnabled: false });
          continue;
        }
        // Re-check at runtime that the schedule's creator may still schedule
        // this evalflow (secrets resolve from the evalflow owner). This disables
        // schedules whose creator lost the right — e.g. legacy ones created by a
        // system admin on someone else's evalflow before scheduling was
        // restricted to the owner — so they stop spending the owner's secrets.
        if (schedule.createdBy == null || !canScheduleEvalflow({ id: schedule.createdBy }, evalflow)) {
          log(`Schedule "${schedule.name}" creator is no longer authorized to schedule its evalflow — disabling`, "scheduler");
          await storage.updateEvalSchedule(schedule.id, { isEnabled: false });
          continue;
        }
        const provider = await storage.getProvider(evalflow.providerId);
        // The row is still needed for `creator.plan` in the job snapshot below.
        // Its org columns are NOT read here: the scheduler runs outside the auth
        // boundary, so it asks the seam directly. Passing the raw row would
        // structurally satisfy sessionPoolViolation's `{ organizationId }` param
        // and silently bypass the seam — see server/organizations.ts.
        const creator = schedule.createdBy ? await storage.getUser(schedule.createdBy) : undefined;
        // Membership comes from the seam, and the answer is load-bearing
        // whenever the RESULTING JOB would depend on an org:
        //   - an ORG evalflow: membership picks the session pool
        //     (sessionPoolViolation) and fences the job's org secrets;
        //   - a TEAM-TIER schedule (on an org OR a personal evalflow — an org
        //     member may legally schedule their own personal evalflow onto
        //     their org's agents): membership freezes creator_org_id, and the
        //     team claim arm matches `ej.creator_org_id` exactly. A job stamped
        //     NULL-because-the-provider-was-absent is unclaimable FOREVER, not
        //     just during the outage.
        // "Cannot answer" is not "no org" (organizations.ts §4), so an
        // UNAVAILABLE provider — absent OR throwing — makes such a schedule
        // unprocessable, and the design's answer (§7) is to SKIP it: still
        // enabled, next_run untouched, no job row, no mint. Never disabled: the
        // provider being down is not the schedule's fault, and the schedule
        // must resume by itself once orgs come back. Deliberately placed BEFORE
        // detectSessionNeed/stampOwnerSession so a skipped schedule can never
        // burn a broker login attempt.
        let creatorMembership: Membership | null = null;
        if (evalflow.organizationId != null || schedule.targetTier === "team") {
          const orgs = getOrganizations();
          let orgsAnswered = orgs !== null;
          if (orgs) {
            try {
              creatorMembership = schedule.createdBy
                ? (await orgs.getMembership(schedule.createdBy)) ?? null
                : null;
            } catch {
              orgsAnswered = false; // failure == absence in a tick (§4 error contract)
            }
          }
          if (!orgsAnswered) {
            orgSkips++;
            continue; // skip — enabled, undispatched, unwritten
          }
        } else {
          // Personal evalflow, non-team tier: membership only decorates the
          // job's creator_org_id stamp (no claim arm reads it), so absence stays
          // fail-closed ("no org") exactly as before, and a provider FAILURE
          // still propagates to the per-schedule catch below (no job created)
          // rather than silently stamping null.
          creatorMembership = schedule.createdBy
            ? (await getOrganizations()?.getMembership(schedule.createdBy)) ?? null
            : null;
        }

        // scheduled jobs are inherently owner-dispatched —
        // canScheduleEvalflow (re-checked above) is owner/creator-only, so the
        // schedule creator IS the evalflow owner and the untargeted owner/team
        // gate the run route applies is satisfied structurally. stampOwnerSession
        // (shared with the run-now route) strips/stamps config.sessionInjection,
        // pre-warms the mint, and returns the immutable snapshot stamp so
        // /session derives from it, not live data. A split-class credential pair
        // can never run safely (it would leak the runtime-class secret) — disable
        // the schedule so it stops firing failing/unsafe jobs every tick.
        const jobConfig = mergeEvalConfig(evalflow.config, evalSet?.config);
        // The evalflow's secrets are mutable after schedule creation: a
        // public/team schedule whose evalflow LATER gained a login-class
        // secret would emit an unclaimable session job every tick (the claim
        // predicate refuses them, and pooled rows ride the 24h backstop).
        // Check with the PURE detector BEFORE stampOwnerSession — the stamp
        // helper mutates config and pre-warms a broker mint (ensureSession),
        // and a schedule we are about to disable must not burn a login
        // attempt first.
        const schedSessionReq = await detectSessionNeed(evalflow);
        if (schedSessionReq.kind === "need") {
          const violation = sessionPoolViolation(schedule.targetTier, evalflow, {
            organizationId: creatorMembership?.organizationId ?? null,
          });
          if (violation) {
            log(`Schedule "${schedule.name}" would dispatch into a disallowed pool (${violation}) — disabling`, "scheduler");
            await storage.updateEvalSchedule(schedule.id, { isEnabled: false });
            continue;
          }
        }
        // A secret the evalflow references can be deleted AFTER the schedule
        // was created; every tick would then emit a job that can only fail on
        // an unresolved ${secrets.X}. Mirror the misconfigured/pool handling:
        // disable the schedule with a named reason instead of queueing doomed
        // work forever. This keys on whether the secret ROW exists, not on
        // whether it reaches the agent — so a brokered login secret that
        // exists is fine (Core mints from it), and one that doesn't is
        // correctly flagged, since the mint would fail too.
        {
          const missing = await missingSecretNames(sessionScopeForEvalflow(evalflow), resolvableSecretSources([evalflow.config, evalSet?.config]));
          if (missing.length > 0) {
            log(`Schedule "${schedule.name}" references unconfigured secret(s) ${missing.join(", ")} — disabling`, "scheduler");
            await storage.updateEvalSchedule(schedule.id, { isEnabled: false });
            continue;
          }
        }
        const stamp = await stampOwnerSession(evalflow, jobConfig as Record<string, unknown>, schedSessionReq);
        if (stamp.kind === "misconfigured") {
          log(`Schedule "${schedule.name}" evalflow has a split-class credential pair (${stamp.reason}) — disabling`, "scheduler");
          await storage.updateEvalSchedule(schedule.id, { isEnabled: false });
          continue;
        }
        const baseSnapshot = buildJobSnapshot(evalflow, evalSet, provider, creator?.plan ?? null);
        const snapshot = stamp.snapshotInjection
          ? { ...baseSnapshot, sessionInjection: stamp.snapshotInjection }
          : baseSnapshot;

        // Create the eval job
        const job = await storage.createEvalJob({
          scheduleId: schedule.id,
          triggerType: 1, // scheduled
          evalflowId: schedule.evalflowId,
          evalSetId: schedule.evalSetId,
          createdBy: schedule.createdBy,
          // R2 (§11): freeze the creator's org here, from the seam-resolved
          // membership already computed above (never users.organization_id).
          creatorOrgId: creatorMembership?.organizationId ?? null,
          siteId: null,
          targetRegion: schedule.region,
          targetTier: schedule.targetTier,
          config: jobConfig,
          snapshot,
          status: "pending",
          priority: 0,
          retryCount: 0,
          maxRetries: 3,
        });

        log(`Created job ${job.id} from schedule "${schedule.name}" (${schedule.scheduleType})`, "scheduler");

        // Calculate next run time
        let nextRunAt: Date | null = null;

        if (schedule.scheduleType === "recurring" && schedule.cronExpression) {
          // Check if max runs reached
          const newRunCount = schedule.runCount + 1;
          if (schedule.maxRuns && newRunCount >= schedule.maxRuns) {
            // Max runs reached, disable the schedule
            await storage.disableSchedule(schedule.id);
            log(`Schedule "${schedule.name}" disabled (max runs reached: ${schedule.maxRuns})`, "scheduler");
          } else {
            // Calculate next run time from cron expression
            nextRunAt = parseNextCronRun(schedule.cronExpression);
          }
        } else {
          // One-time schedule, disable after running
          await storage.disableSchedule(schedule.id);
          log(`One-time schedule "${schedule.name}" completed and disabled`, "scheduler");
        }

        // Update schedule with new run count and next run time
        if (nextRunAt) {
          await storage.markScheduleRun(schedule.id, nextRunAt);
          log(`Schedule "${schedule.name}" next run at ${nextRunAt.toISOString()}`, "scheduler");
        }
      } catch (error) {
        console.error(`Failed to process schedule ${schedule.id}:`, error);
      }
    }
    if (orgSkips) {
      log(`${orgSkips} org schedule(s) skipped — organizations unavailable (org-owned evalflow or team tier)`, "scheduler");
    }
  } catch (error) {
    console.error("Scheduler error:", error);
  }
}
