import type { JobSnapshot } from "@shared/schema";
import { publicLineLookup, type LineLookup } from "@shared/tags";

export function publicEvalFlow<T extends { lineLookup?: LineLookup | null }>(flow: T): T {
  return flow.lineLookup ? { ...flow, lineLookup: publicLineLookup(flow.lineLookup) } : flow;
}

export function publicEvalJob<T extends { snapshot: JobSnapshot | null }>(job: T): T {
  if (!job.snapshot?.evalFlow?.lineLookup) return job;
  return { ...job, snapshot: { ...job.snapshot, evalFlow: publicEvalFlow(job.snapshot.evalFlow) } };
}
