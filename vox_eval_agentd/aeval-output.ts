/**
 * Pure helpers for interpreting an aeval run's console output.
 * Kept in its own module (not vox-agentd.ts) so tests can import it without
 * pulling in the daemon entrypoint, which runs main() and calls process.exit.
 * Daemon-local rather than shared/: nothing outside the daemon uses it.
 */

/**
 * Pick the most informative line from a failed aeval run.
 *
 * The old heuristic — last line of stderr — is actively wrong for a
 * PyInstaller-packaged binary: its generic
 * "[PYI-####:ERROR] Failed to execute script 'pyi_entrypoint'..." banner is
 * printed AFTER the real traceback, so the one line we kept was structurally
 * guaranteed to be the least useful one.
 *
 * Order of preference:
 *  1. aeval's own loguru ERROR lines (its actual diagnosis, e.g.
 *     "Step 1 failed: platform.setup - Unknown variable source: secrets").
 *     Scans BOTH streams — loguru's sink may be either.
 *  2. Otherwise the last few non-noise lines, so we surface a traceback tail
 *     rather than the packaging banner.
 */
export function summarizeAevalFailure(stdout: string, stderr: string): string {
  const NOISE = /^\s*(\[PYI-\d+[^\]]*\]|Traceback \(most recent call last\):)/;
  const lines = `${stdout}\n${stderr}`
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // Strip loguru's "TIMESTAMP | LEVEL | " prefix for a compact message.
  const strip = (l: string) => l.replace(/^\S+\s+\S+\s*\|\s*\w+\s*\|\s*/, '').trim();

  const errors = lines.filter((l) => /\|\s*(ERROR|CRITICAL)\s*\|/.test(l)).map(strip);
  if (errors.length > 0) {
    // The most specific diagnosis is usually the FIRST error; later ones are
    // cascades ("Test 1 failed: Step 1 failed: ...").
    return errors.slice(0, 3).join(' | ').slice(0, 500);
  }

  const meaningful = lines.filter((l) => !NOISE.test(l));
  const tail = (meaningful.length > 0 ? meaningful : lines).slice(-3).join(' | ');
  return (tail || 'unknown error').slice(0, 500);
}
