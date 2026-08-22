// Display/count-only liveness filter for eval agents. An agent is "stale-offline"
// when it is offline AND we have not heard from it within the threshold (default 24h).
// Stale-offline agents are hidden from listings and excluded from counts — they are
// NEVER deleted from the database.

const DEFAULT_STALE_MS = 24 * 60 * 60 * 1000;

export function isStaleOfflineAgent(
  agent: { state: string; lastSeenAt: Date | string | null },
  now: Date = new Date(),
  thresholdMs: number = DEFAULT_STALE_MS,
): boolean {
  if (agent.state !== "offline") return false;
  if (agent.lastSeenAt == null) return true;
  const seen = agent.lastSeenAt instanceof Date ? agent.lastSeenAt : new Date(agent.lastSeenAt);
  return now.getTime() - seen.getTime() > thresholdMs;
}
