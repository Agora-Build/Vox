import { z } from "zod";

export const TRIAL_LIMIT_24_HOURS = 5;
export const TRIAL_LIMIT_30_DAYS = 80;
export const trialLimitSchema = z.number().int().min(0).max(10000);
export const flowTrialLimitsSchema = z.object({
  trialLimit24Hours: trialLimitSchema.optional(),
  trialLimit30Days: trialLimitSchema.optional(),
});
export interface FlowTrialLimits {
  trialLimit24Hours: number;
  trialLimit30Days: number;
}
export const DEFAULT_FLOW_TRIAL_LIMITS: FlowTrialLimits = {
  trialLimit24Hours: TRIAL_LIMIT_24_HOURS,
  trialLimit30Days: TRIAL_LIMIT_30_DAYS,
};

export interface CredentialTrialPolicy {
  enabled: boolean;
  maxRuns30Days: number;
}

export interface CredentialTrialAllowance extends FlowTrialLimits {
  available: boolean;
  reason: string | null;
  remaining24Hours: number;
  remaining30Days: number;
}

export function trialAllowance(
  policy: CredentialTrialPolicy,
  usage: { caller24Hours: number; caller30Days: number; owner30Days: number },
  limits: FlowTrialLimits = DEFAULT_FLOW_TRIAL_LIMITS,
): CredentialTrialAllowance {
  const remaining24Hours = Math.max(0, limits.trialLimit24Hours - usage.caller24Hours);
  const remaining30Days = Math.max(0, limits.trialLimit30Days - usage.caller30Days);
  const reason = !policy.enabled || policy.maxRuns30Days <= 0
    ? "The credential owner has not enabled public trials. Bring your own credentials by copying this flow."
    : usage.owner30Days >= policy.maxRuns30Days
      ? "The credential owner's 30-day trial budget is exhausted. Bring your own credentials or try again later."
      : remaining24Hours === 0 || remaining30Days === 0
        ? `Trial allowance exhausted (${limits.trialLimit24Hours} runs per 24 hours and ${limits.trialLimit30Days} per 30 days for this flow). Bring your own credentials or wait for the rolling window to reset.`
        : null;
  return { trialLimit24Hours: limits.trialLimit24Hours, trialLimit30Days: limits.trialLimit30Days,
    available: reason == null, reason, remaining24Hours, remaining30Days };
}
