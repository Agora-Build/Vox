import type { EvalJob, JobSnapshot } from "@shared/schema";

// Tools → Analyze (design 2026-09-30).

/**
 * A job as listed to an agent that might claim it. Every agent that could take
 * an analysis sees it listed — public agents included — so before the claim
 * it learns only what it needs to decide: not the uploader's file name or
 * where the file is stored. The agent that claims it fetches the file through
 * the lease-fenced /upload endpoint.
 */
export function forAgentJobList(job: EvalJob): EvalJob {
  if (job.kind !== "analyze") return job;
  const { analyze: _upload, ...snapshot } = (job.snapshot ?? {}) as JobSnapshot;
  return { ...job, snapshot: snapshot as JobSnapshot };
}
