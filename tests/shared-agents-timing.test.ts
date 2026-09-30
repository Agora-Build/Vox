import { describe, it, expect } from "vitest";
import { MAX_JOB_RUN_MINUTES, PENDING_MAX_WAIT_MINUTES } from "../server/scheduler";
import { LEAK_TTL_MS, LEAK_REAPER_INTERVAL_MS } from "../plugins/shared-agents/server/index";
import { STALE_HOLD_MS } from "../plugins/credits/server/reconcile";

// #91: the three clocks on a paid dispatch hold must stay in this order, or a
// legitimate long wait trips credits' invariant alarm (error log + degraded
// health) before the leak reaper has had a chance to refund a real leak:
//   longest legitimate hold  <  leak-reaper TTL  <  credits stale-hold alarm
// The longest legitimate hold is a day in the queue and then one full run. That
// holds however often a job is requeued, because the 24h backstop counts from
// the job's creation, not from its last requeue (tests/tier-pool-claim.test.ts).
const MIN = 60 * 1000;

describe("dispatch hold timings", () => {
  const longestLegitimateHold = (PENDING_MAX_WAIT_MINUTES + MAX_JOB_RUN_MINUTES) * MIN;

  it("the leak reaper never refunds a hold that is still legitimate", () => {
    expect(LEAK_TTL_MS).toBeGreaterThan(longestLegitimateHold);
  });

  it("credits' stale-hold alarm fires only after the reaper had a full sweep to refund a leak", () => {
    expect(STALE_HOLD_MS).toBeGreaterThan(LEAK_TTL_MS + LEAK_REAPER_INTERVAL_MS);
  });

  it("so the documented worst case (a day in the queue, then a full run) is no alarm", () => {
    expect(STALE_HOLD_MS).toBeGreaterThan(longestLegitimateHold);
  });
});
