/**
 * Libretto step-script policy shared by Core (save-time validation, run gate,
 * restful endpoint) and the eval-agent daemon (splitter + compiler) — ONE
 * source for the segment vocabulary rules so the save-time and run-time
 * checks cannot drift apart (design 2026-09-25 §1/§5).
 *
 * Client-safe: no Node imports, no YAML parsing here — callers hand in
 * already-parsed step arrays.
 */

/** The phone-number shape every dialable value must match — also what keeps a
 * number safe inside a double-quoted YAML scalar (no quotes/backslashes). */
export const PHONE_NUMBER_RE = /^\+?[0-9 ()-]{5,20}$/;

export type StepSegment = "setup" | "conversation" | "teardown";

/**
 * Segment vocabulary policy for PHONE scripts. Returns an error string when
 * `type` is illegal in `segment`, else null. MUST be applied to the
 * POST-substitution type wherever templating exists (a for_each item can
 * smuggle a type past any raw-text scan) — the daemon compiler is that
 * boundary; raw-text callers use it for early, precise errors.
 */
export function illegalPhoneStepType(type: string, segment: StepSegment): string | null {
  if (segment === "conversation") {
    if (type.startsWith("call.") || type === "restful.request" || type.startsWith("sms.")) {
      return `'${type}' is evalflow Setup/Teardown vocabulary — illegal in an eval-set conversation`;
    }
    return null;
  }
  if (segment === "teardown") {
    if ((type.startsWith("call.") && type !== "call.hangup") || type === "restful.request" || type.startsWith("sms.")) {
      return `'${type}' is illegal in Teardown Steps (only call.hangup ends the session)`;
    }
    return null;
  }
  return null; // setup: full call.* vocabulary (restful ordering is positional, checked separately)
}

/** Cross-mode rule for PHONE scripts: web-session vocabulary never belongs
 * there (the DialF compiler has no browser). */
export function illegalWebVocabInPhone(type: string): string | null {
  if (type.startsWith("platform.") || type.startsWith("browser.")) {
    return `'${type}' is web-session vocabulary — illegal in a phone evalflow`;
  }
  return null;
}

/** Cross-mode rule for WEB scripts: phone vocabulary never belongs there.
 * Everything else passes — aeval owns the web vocabulary. */
export function illegalWebStepType(type: string): string | null {
  if (type.startsWith("call.") || type === "restful.request" || type.startsWith("sms.")) {
    return `'${type}' is phone vocabulary — illegal in a web evalflow`;
  }
  return null;
}

/** DoS bounds for walking parsed YAML step graphs: js-yaml aliases produce
 * SHARED object references, so a few KB of nested aliases can expand a naive
 * recursive walk exponentially (and a self-referencing alias would loop
 * forever). Every walk over untrusted step YAML must be node- and
 * depth-bounded with cycle detection. */
export const MAX_STEP_WALK_NODES = 10_000;
export const MAX_STEP_WALK_DEPTH = 16;

export type StepVisit = (step: Record<string, unknown>, depth: number) => string | null;

/**
 * Bounded, cycle-safe walk over a parsed step list (recursing into nested
 * `steps` arrays, the control.for_each shape). `visit` returns an error
 * string to stop, else null. Returns:
 *   null            — walk completed, no error
 *   'too-complex'   — budget exceeded (treat as invalid, fail closed)
 *   any other string — the visitor's error
 */
export function walkStepList(steps: unknown[], visit: StepVisit): string | null {
  const seen = new WeakSet<object>();
  let nodes = 0;
  const rec = (list: unknown[], depth: number): string | null => {
    if (depth > MAX_STEP_WALK_DEPTH) return "too-complex";
    for (const raw of list) {
      if (typeof raw !== "object" || raw === null) continue;
      if (seen.has(raw)) continue; // aliased subtree already checked once
      seen.add(raw);
      if (++nodes > MAX_STEP_WALK_NODES) return "too-complex";
      const step = raw as Record<string, unknown>;
      const err = visit(step, depth);
      if (err) return err;
      if (Array.isArray(step.steps)) {
        const nested = rec(step.steps, depth + 1);
        if (nested) return nested;
      }
    }
    return null;
  };
  return rec(steps, 0);
}

/** Bounded recursive scan for a call.dial step (the phone run gate — the
 * compiler unrolls for_each, so nested dials count). Fails CLOSED: a
 * too-complex graph reports no dial, and such a script can no longer be
 * saved anyway (validation walks with the same budget). */
export function stepsContainCallDial(steps: unknown[]): boolean {
  return walkStepList(steps, (step) => (step.type === "call.dial" ? "found" : null)) === "found";
}
