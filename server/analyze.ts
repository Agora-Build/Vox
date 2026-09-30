import type { Response } from "express";
import { pipeline } from "stream/promises";
import type { EvalJob } from "@shared/schema";

// Tools → Analyze (design 2026-09-30).

/**
 * A job as given to an agent (the pending list and the claim response). Every
 * agent that could take an analysis sees it — public agents included — so an
 * analysis is sent as the bare minimum the daemon runs it with: nothing about
 * who uploaded it, what, or where it is stored. The agent that claims it
 * fetches the file through the lease-fenced /upload endpoint.
 */
export function forAgentJobList(job: EvalJob): EvalJob {
  if (job.kind !== "analyze") return job;
  return { id: job.id, kind: job.kind, transport: job.transport, status: job.status, config: {} } as unknown as EvalJob;
}

/**
 * Stream a file from the uploader's storage to a response. Their endpoint can
 * fail midway (it's theirs); pipe() would leave the response open forever, so
 * end it instead.
 */
export function pipeToResponse(body: NodeJS.ReadableStream, res: Response | import("http").ServerResponse, what: string): void {
  pipeline(body, res).catch((err) => {
    console.warn(`[analyze] streaming ${what} failed:`, err instanceof Error ? err.message : err);
    res.destroy();
  });
}
