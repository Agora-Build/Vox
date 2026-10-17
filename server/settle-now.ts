import { storage } from "./storage";
import { getMarketplace } from "./marketplace";
import type { EvalJob } from "@shared/schema";

/**
 * Settle paid jobs that just ended without running — cancelled while pending,
 * or failed because their agent was revoked — so the renter is refunded at
 * once instead of when the reap-settle sweep gets to them (#214). Unpaid jobs
 * (no settlementContext) are skipped. Never throws: a failed settle is logged
 * and left to the sweep, which retries it.
 */
export async function settleEndedJobsNow(jobs: EvalJob[], why: string): Promise<void> {
  const marketplace = getMarketplace();
  if (!marketplace) return;
  for (const job of jobs) {
    const settlementContext = (job.snapshot as { settlementContext?: unknown } | null)?.settlementContext;
    if (settlementContext === undefined) continue;
    try {
      await marketplace.settle({ jobId: job.id, status: job.status, hasResult: false, settlementContext });
      await storage.markSettlementDone(job);
    } catch (err) {
      console.error(`[marketplace] refunding ${why} job ${job.id} failed (the sweep retries it):`, err);
    }
  }
}
