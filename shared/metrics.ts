/**
 * Shared metric constants — used by the eval-agent daemon (computation) and
 * the console UI (display), so thresholds can never drift between them.
 */

/**
 * A stop more than this long after an interruption is not treated as a
 * reaction — real data shows the analyzer attributes the agent's natural
 * end-of-answer to the interruption window (observed 9–11.5s "stops" amid
 * genuine ~1s reactions). Such events are excluded from reaction counts and
 * reaction-latency stats, and highlighted as warnings in the UI.
 */
export const INTERRUPT_ACTION_MAX_MS = 3000;
