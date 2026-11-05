import { describe, expect, it } from "vitest";
import { trialAllowance, flowTrialLimitsSchema } from "../shared/credential-trials";

const policy = { enabled: true, maxRuns30Days: 100 };
const usage = { caller24Hours: 0, caller30Days: 0, owner30Days: 0 };
describe("borrowed credential trial limits", () => {
  it("requires explicit owner opt-in and a positive budget", () => {
    expect(trialAllowance({ ...policy, enabled: false }, usage).available).toBe(false);
    expect(trialAllowance({ ...policy, maxRuns30Days: 0 }, usage).available).toBe(false);
  });
  it("exposes the two independent rolling allowances", () => {
    expect(trialAllowance(policy, { ...usage, caller24Hours: 2, caller30Days: 7 })).toMatchObject({ available: true, remaining24Hours: 3, remaining30Days: 73, trialLimit24Hours: 5, trialLimit30Days: 80 });
    expect(trialAllowance(policy, { ...usage, caller24Hours: 5 }).available).toBe(false);
    expect(trialAllowance(policy, { ...usage, caller30Days: 80 }).available).toBe(false);
  });
  it("enforces the owner's aggregate budget independently of the caller", () => {
    expect(trialAllowance(policy, { ...usage, owner30Days: 100 })).toMatchObject({ available: false, remaining24Hours: 5, remaining30Days: 80 });
  });
  it("never returns negative allowances", () => {
    expect(trialAllowance(policy, { ...usage, caller24Hours: 20, caller30Days: 100 })).toMatchObject({ available: false, remaining24Hours: 0, remaining30Days: 0 });
  });
  it("uses flow-specific limits, including zero to disable", () => {
    const limits = { trialLimit24Hours: 2, trialLimit30Days: 6 };
    expect(trialAllowance(policy, usage, limits)).toMatchObject({ available: true, remaining24Hours: 2, remaining30Days: 6 });
    expect(trialAllowance(policy, { ...usage, caller24Hours: 2 }, limits).reason).toContain("2 runs per 24 hours and 6 per 30 days for this flow");
    expect(trialAllowance(policy, usage, { ...limits, trialLimit24Hours: 0 }).available).toBe(false);
  });
  it.each([-1, 1.5, 10001, "5", null])("rejects invalid limits: %s", (value) => {
    expect(flowTrialLimitsSchema.safeParse({ trialLimit24Hours: value }).success).toBe(false);
  });
});
