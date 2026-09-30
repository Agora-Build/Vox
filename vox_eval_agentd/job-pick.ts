// Which listed job the agent runs (#216). Core lists what this agent may
// claim, oldest first; a claim can still be refused (another agent got there
// first, or a row the list and the claim disagree on). Move on to the next
// instead of retrying the same one every poll — one bad row must never stall
// an agent.
export async function claimFirstAvailable<T>(jobs: T[], claim: (job: T) => Promise<boolean>): Promise<T | null> {
  for (const job of jobs) {
    if (await claim(job)) return job;
  }
  return null;
}
