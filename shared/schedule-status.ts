// Pure derivation of an eval schedule's lifecycle status, shared by the API
// (server/routes.ts eval-schedules list) and unit tests.

export type ScheduleStatus = "active" | "paused" | "inactive";

const EXPIRING_SOON_MS = 14 * 24 * 60 * 60 * 1000; // amber warning within 2 weeks

/**
 * Derive a schedule's status from its enabled flag and expiry:
 *  - `inactive`: expired (expiresAt in the past) — the scheduler no longer fires it
 *  - `paused`:   the user disabled it (and it hasn't expired)
 *  - `active`:   enabled and not expired; `expiringSoon` when within 14 days of expiry
 */
export function deriveScheduleStatus(
  isEnabled: boolean,
  expiresAt: Date | string | null | undefined,
  now: number = Date.now(),
): { status: ScheduleStatus; expiringSoon: boolean } {
  const exp = expiresAt != null ? new Date(expiresAt).getTime() : null;
  const expired = exp != null && exp <= now;
  const status: ScheduleStatus = expired ? "inactive" : !isEnabled ? "paused" : "active";
  const expiringSoon = status === "active" && exp != null && exp <= now + EXPIRING_SOON_MS;
  return { status, expiringSoon };
}
