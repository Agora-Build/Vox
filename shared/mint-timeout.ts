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

/** One hour. Past this a mint is a hung browser, not a slow login. */
export const MAX_MINT_TIMEOUT_SECONDS = 3600;

export function mintTimeoutSeconds(): number {
  // parseInt never returns Infinity, so isFinite here is exactly a NaN check.
  const configured = Number.parseInt(
    process.env.WEB_SESSION_MINT_TIMEOUT_SECONDS || String(DEFAULT_MINT_TIMEOUT_SECONDS),
    10,
  );
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_MINT_TIMEOUT_SECONDS;
  return Math.min(configured, MAX_MINT_TIMEOUT_SECONDS);
}
