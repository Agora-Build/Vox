/**
 * How long a login mint may take, in seconds. One definition for all three
 * readers of WEB_SESSION_MINT_TIMEOUT_SECONDS.
 *
 * There were three: Core's `AbortSignal.timeout` bound, `staleMintThresholdSeconds()`
 * derived from it, and the broker sidecar's own `setTimeout` on the aeval child.
 * Each parsed the env var itself, and each failed differently on a bad value:
 *
 *  - `AbortSignal.timeout(NaN)` throws a TypeError ([EnforceRange] unsigned long
 *    long), failing every mint with an opaque error. So does an out-of-range
 *    value like 1e20, which a "finite and positive" check lets through.
 *  - `setTimeout(fn, NaN)` coerces the delay to 0, so the broker SIGTERMs its
 *    child on the next tick and every mint dies instantly — while Core, having
 *    clamped, waits ~195s for a broker that already gave up.
 *
 * Clamped at BOTH ends for that reason. Dependency-free so Core can import it
 * via `@shared/mint-timeout` and the broker via `../shared/mint-timeout` with a
 * Dockerfile COPY, the arrangement `shared/secrets.ts` already uses.
 */

export const DEFAULT_MINT_TIMEOUT_SECONDS = 180;

/**
 * Upper clamp, chosen to keep the four deadlines in order rather than as a
 * round number:
 *
 *   broker child timeout   = T                    (this value)
 *   Core abort             = T + 15
 *   stale-mint reclaim     = T + 30
 *   daemon session poll    = 240s, HARD-CODED in vox-agentd.ts fetchSession
 *
 * The daemon's deadline is not configurable from here — it runs on a different
 * host and cannot read Core's env — so T must stay low enough that the agent
 * outlasts the mint it is waiting on. At 200 the chain is 200 < 215 < 230 < 240.
 * A larger ceiling would let an operator invert it: the agent would give up
 * first, fail the job with "timed out waiting for session mint", and the real
 * diagnosis would never reach the job error while Core was still legitimately
 * working. Raising this means raising that poll deadline too.
 */
export const MAX_MINT_TIMEOUT_SECONDS = 200;

export function mintTimeoutSeconds(): number {
  // parseInt never returns Infinity, so isFinite here is exactly a NaN check.
  const configured = Number.parseInt(
    process.env.WEB_SESSION_MINT_TIMEOUT_SECONDS || String(DEFAULT_MINT_TIMEOUT_SECONDS),
    10,
  );
  if (!Number.isFinite(configured) || configured <= 0) {
    warnOnce(`WEB_SESSION_MINT_TIMEOUT_SECONDS=${process.env.WEB_SESSION_MINT_TIMEOUT_SECONDS} is not a positive integer; using ${DEFAULT_MINT_TIMEOUT_SECONDS}s`);
    return DEFAULT_MINT_TIMEOUT_SECONDS;
  }
  if (configured > MAX_MINT_TIMEOUT_SECONDS) {
    // Said out loud (#139): an operator who set 600 should not have to read
    // this file to learn they got 200.
    warnOnce(`WEB_SESSION_MINT_TIMEOUT_SECONDS=${configured} exceeds the ${MAX_MINT_TIMEOUT_SECONDS}s ceiling (the eval agent stops waiting for a session at 240s); using ${MAX_MINT_TIMEOUT_SECONDS}s`);
    return MAX_MINT_TIMEOUT_SECONDS;
  }
  return configured;
}

// Read on every mint; say it once per process, not once per mint.
const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[mint-timeout] ${message}`);
}
