// Which listed job the agent runs (#216, #219). Core lists what this agent may
// claim, oldest first; a claim can still be refused for that job (another
// agent got there first, a fence, the job is gone): move on to the next
// instead of retrying the same one every poll — one bad row must never stall
// an agent. But when the claim failed for another reason (Core erroring,
// network down), stop: walking the whole list would only send Core a burst of
// claims it can't serve. The next poll tries again.

/** claimed; taken = refused for this job (try the next); error = stop. */
export type ClaimOutcome = "claimed" | "taken" | "error";

export async function claimFirstAvailable<T>(jobs: T[], claim: (job: T) => Promise<ClaimOutcome>): Promise<T | null> {
  for (const job of jobs) {
    const outcome = await claim(job);
    if (outcome === "claimed") return job;
    if (outcome === "error") return null;
  }
  return null;
}

/** A claim response's meaning: 409/403/404 are about the job itself. */
export function claimOutcome(status: number): ClaimOutcome {
  if (status >= 200 && status < 300) return "claimed";
  return status === 409 || status === 403 || status === 404 ? "taken" : "error";
}
