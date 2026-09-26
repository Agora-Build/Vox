/**
 * Eval set chunk splitting — pure functions, no side effects.
 *
 * One eval-set body can hold many samples across several cases (RSP_BASIC,
 * INT_BASIC, INT_FALSE, ...). Each sample's `lab.trace` carries its `case_id`
 * and `chunk_id`, and the daemon emits ONE aeval file per (case_id, chunk_id)
 * group — the file boundaries are defined by the data, not by a fixed size.
 * CHUNK_SIZE is only a soft limit: a group larger than it gets a warning.
 *
 * Each emitted file's analysis preset is resolved per case from
 * `params.lab.cases[case_id].analysis` (falling back to the scenario's
 * top-level `analysis`), since different cases need different presets
 * (e.g. INT_FALSE uses lab_int_false.yaml).
 *
 * This module is imported by both the daemon (vox-agentd.ts) and the tests,
 * so the tested logic is the same code that runs in production.
 */

import yaml from 'js-yaml';

export const CHUNK_SIZE = 5; // soft max samples per aeval run — warn if exceeded

export interface ScenarioStep {
  type: string;
  [key: string]: unknown;
}

export interface ParsedScenario {
  name: string;
  description?: string;
  analysis?: Record<string, unknown>;
  params?: Record<string, unknown>;
  steps: ScenarioStep[];
}

/** A sample group = lab.trace step + all following steps until the next lab.trace */
export interface SampleGroup {
  steps: ScenarioStep[];
  sampleId?: string;
  caseId?: string;
  chunkId?: string;
}

/** Samples sharing one (case_id, chunk_id) → one emitted aeval file. */
export interface ChunkGroup {
  caseId: string;
  chunkId: string;
  samples: SampleGroup[];
}

// Step types that mark scenario teardown (run once at the end, not per-sample).
const TEARDOWN_STEP_TYPES = new Set(['audio.stop_recording', 'platform.exit']);

/**
 * Sanitize a value for safe use in a filename. Strips anything that could
 * enable path traversal or escape the temp dir — keeps only [A-Za-z0-9._-],
 * collapses everything else to '-'. Guards against ".." and empty results.
 */
export function sanitizeForFilename(value: string | undefined, fallback = 'x'): string {
  if (!value) return fallback;
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '-').replace(/\.{2,}/g, '-');
  const trimmed = cleaned.replace(/^[-.]+|[-.]+$/g, '');
  return trimmed.length > 0 ? trimmed.slice(0, 64) : fallback;
}

/**
 * Extract sample groups from a scenario's steps array.
 *
 * - Steps before the first `lab.trace` are setup steps (prefix).
 * - Each `lab.trace` starts a new sample group that includes all following
 *   steps until the next `lab.trace`.
 * - Trailing teardown steps (audio.stop_recording, platform.exit) after the
 *   last sample are pulled OUT into suffixSteps so they aren't bound to a
 *   single chunk — every chunk gets its own teardown.
 */
export function extractSampleGroups(steps: ScenarioStep[]): {
  prefixSteps: ScenarioStep[];
  suffixSteps: ScenarioStep[];
  samples: SampleGroup[];
} {
  const prefixSteps: ScenarioStep[] = [];
  const samples: SampleGroup[] = [];
  let current: SampleGroup | null = null;
  let foundFirstSample = false;

  for (const step of steps) {
    if (step.type === 'lab.trace') {
      if (current) samples.push(current);
      // lab.trace fields may be top-level or nested in params
      const p = step.params as Record<string, unknown> | undefined;
      const sampleId = (step.sample_id ?? p?.sample_id) as string | undefined;
      const caseId = (step.case_id ?? p?.case_id) as string | undefined;
      const chunkId = (step.chunk_id ?? p?.chunk_id) as string | undefined;
      current = { steps: [step], sampleId, caseId, chunkId };
      foundFirstSample = true;
    } else if (!foundFirstSample) {
      prefixSteps.push(step);
    } else if (current) {
      current.steps.push(step);
    }
  }
  if (current) samples.push(current);

  // Pull trailing teardown steps off the last sample so they become a shared
  // suffix applied to every chunk (not just the chunk with the last sample).
  const suffixSteps: ScenarioStep[] = [];
  if (current) {
    while (current.steps.length > 1 && TEARDOWN_STEP_TYPES.has(current.steps[current.steps.length - 1].type)) {
      suffixSteps.unshift(current.steps.pop()!);
    }
  }

  return { prefixSteps, suffixSteps, samples };
}

/**
 * Group samples into emitted files by (case_id, chunk_id), preserving first-seen
 * order. Samples with no caseId fall under 'default'; with no chunkId, under
 * 'chunk_001'. The file boundaries come from the data — there is no size-based
 * splitting here (CHUNK_SIZE is only a soft warning threshold, applied by the
 * caller).
 */
export function groupSamplesByChunk(samples: SampleGroup[]): ChunkGroup[] {
  const order: string[] = [];
  const map = new Map<string, ChunkGroup>();
  for (const s of samples) {
    const caseId = s.caseId || 'default';
    const chunkId = s.chunkId || 'chunk_001';
    const key = `${caseId}\0${chunkId}`;
    let g = map.get(key);
    if (!g) {
      g = { caseId, chunkId, samples: [] };
      map.set(key, g);
      order.push(key);
    }
    g.samples.push(s);
  }
  return order.map(k => map.get(k)!);
}

/**
 * Resolve the analysis block for a case: prefer the per-case override at
 * `params.lab.cases[caseId].analysis`, else the scenario's top-level `analysis`.
 */
export function resolveCaseAnalysis(scenario: ParsedScenario, caseId: string): unknown {
  const lab = scenario.params?.lab as Record<string, unknown> | undefined;
  const cases = lab?.cases as Record<string, { analysis?: unknown }> | undefined;
  return cases?.[caseId]?.analysis ?? scenario.analysis;
}

/**
 * Build a complete chunk YAML from parts:
 *   metadata + stepsPrefix + chunk samples + stepsSuffix
 * The chunk's analysis is resolved per case; the `cases` map is stripped from
 * params.lab so it doesn't leak into every emitted file.
 */
export function buildChunkYaml(
  scenario: ParsedScenario,
  stepsPrefix: ScenarioStep[],
  chunkSamples: SampleGroup[],
  stepsSuffix: ScenarioStep[],
  caseId: string,
  chunkId: string,
): string {
  const sampleIds = chunkSamples.map(s => s.sampleId).filter(Boolean);

  const chunkSteps = [
    ...stepsPrefix,
    ...chunkSamples.flatMap(s => s.steps),
    ...stepsSuffix,
  ];

  const baseName = scenario.name || 'scenario';
  const chunkScenario: Record<string, unknown> = {
    name: `${baseName}_${caseId}_${chunkId}`,
    description: `${baseName} ${caseId} ${chunkId}`,
  };
  const analysis = resolveCaseAnalysis(scenario, caseId);
  if (analysis) chunkScenario.analysis = analysis;

  const labBase = (scenario.params?.lab && typeof scenario.params.lab === 'object')
    ? { ...(scenario.params.lab as Record<string, unknown>) }
    : {};
  delete labBase.cases; // per-case analysis map is resolved above, not emitted
  chunkScenario.params = {
    ...(scenario.params || {}),
    lab: { ...labBase, case_id: caseId, chunk_id: chunkId, sample_ids: sampleIds },
  };
  chunkScenario.steps = chunkSteps;

  return yaml.dump(chunkScenario, { lineWidth: -1, noRefs: true });
}

/**
 * Compose a single scenario YAML from evalFlow setup/teardown wrapped around an
 * eval-set body, preserving the scenario's metadata. Used when the body is not a
 * clean set of lab.trace samples (e.g. control.for_each) so it can't be chunked —
 * we run it as one file: prefix + body + suffix.
 */
export function composeScenarioYaml(
  scenario: ParsedScenario,
  prefix: ScenarioStep[],
  body: ScenarioStep[],
  suffix: ScenarioStep[],
): string {
  const out: Record<string, unknown> = { name: scenario.name || 'scenario' };
  if (scenario.description) out.description = scenario.description;
  if (scenario.analysis) out.analysis = scenario.analysis;
  if (scenario.params) out.params = scenario.params;
  out.steps = [...prefix, ...body, ...suffix];
  return yaml.dump(out, { lineWidth: -1, noRefs: true });
}

/** One chunk run's metrics plus what the daemon knows about the chunk. */
export interface ChunkMetricsEntry {
  caseId: string;
  chunkId: string;
  /** Samples in this chunk — the rate denominator contribution. */
  sampleCount: number;
  /** True when samples measure interruption (audio.wait_for_speech_start present). */
  hasInterruptPhase: boolean;
  metrics: Record<string, unknown>;
}

export interface ComputedRates {
  /** Fraction of samples that produced a response turn (0..1), or null. */
  response_rate: number | null;
  /** Reactions per sample over true-interrupt cases (0..1), or null. */
  interrupt_rate: number | null;
  /** Reactions per sample over false-interrupt cases — lower is better — or null. */
  false_interrupt_rate: number | null;
  /**
   * Turn Success Rate (0..1), or null when there were no evaluable turns.
   * Opportunity-weighted across all three dimensions: every thing the agent was
   * asked to do (respond, stop on interrupt, don't false-barge) is one scored
   * opportunity, and TSR is the fraction it got right. No per-dimension
   * priority — each turn counts once, so the metric reflects what happened.
   * Unlike latency, a no-response run is INCLUDED here (it's a failed turn),
   * which is what makes TSR the resilience signal for realtime/leaderboard.
   */
  turn_success_rate: number | null;
}

/**
 * False-interrupt cases are identified by naming convention: a case_id with a
 * FALSE segment (e.g. INT_FALSE). Their samples play non-semantic material the
 * agent should NOT react to, so a detected reaction counts against them.
 */
export function isFalseInterruptCase(caseId: string): boolean {
  return /(^|_)FALSE(_|$)/i.test(caseId);
}

/** A group measures interruption when any sample waits for speech start. */
export function groupHasInterruptPhase(g: ChunkGroup): boolean {
  return g.samples.some(s => s.steps.some(st => st.type === 'audio.wait_for_speech_start'));
}

const median = (a: number[]) => {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const popSd = (a: number[]) => {
  if (a.length < 2) return 0;
  const mean = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((sum, v) => sum + (v - mean) ** 2, 0) / a.length);
};
const p95 = (a: number[]) => {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.max(0, Math.ceil(s.length * 0.95) - 1)];
};

function turnsOf(metrics: Record<string, unknown>, family: 'response_metrics' | 'interruption_metrics'): Record<string, unknown>[] {
  const fam = metrics[family] as Record<string, unknown> | undefined;
  const lat = fam?.latency as Record<string, unknown> | undefined;
  return Array.isArray(lat?.turn_level) ? (lat!.turn_level as Record<string, unknown>[]) : [];
}

/** One entry of aeval's analysis/turns.json (turn segmentation + STT). */
export interface TurnsJsonEntry {
  index: number;
  start: number;
  end: number;
  user_segments?: Array<{ start: number; end: number; text?: string }>;
  agent_segments?: Array<{ start: number; end: number; text?: string }>;
}

/**
 * Case-scoped turn values for the headline latency columns. When per_case is
 * present (merged chunked runs):
 * - response latency comes from response-type cases only — interrupt cases'
 *   answers (the cut-off answer + the post-material answer) belong to the
 *   interrupt story, not the response metric;
 * - interrupt latency comes from true-interrupt cases only — reaction times
 *   from false-interrupt cases measure the failure mode, not interrupt
 *   handling.
 * Without per_case / case_id (single-file runs), all turns count as before.
 */
export function headlineLatencyVals(metrics: Record<string, unknown>): { respVals: number[]; intVals: number[] } {
  const perCase = (metrics.per_case ?? {}) as Record<string, { has_interrupt_phase?: boolean; false_interrupt_case?: boolean }>;
  const intCaseIds = new Set(Object.entries(perCase).filter(([, c]) => c?.has_interrupt_phase).map(([id]) => id));
  const falseCaseIds = new Set(Object.entries(perCase).filter(([, c]) => c?.false_interrupt_case).map(([id]) => id));
  const respTurns = turnsOf(metrics, 'response_metrics')
    .filter(t => t.case_id == null || !intCaseIds.has(String(t.case_id)));
  const intTurns = turnsOf(metrics, 'interruption_metrics')
    .filter(t => t.case_id == null || !falseCaseIds.has(String(t.case_id)));
  return { respVals: validResponseVals(respTurns), intVals: validReactionVals(intTurns) };
}

/**
 * Parse aeval's turns.json, which is not strict JSON: it can contain bare
 * Infinity/NaN value tokens (Python json.dump output, e.g. "turn_boundary":
 * Infinity). Replace them with null in value position only (directly after
 * ':', ',' or '[') so transcript strings are never touched.
 */
export function parseTurnsJson(raw: string): TurnsJsonEntry[] | null {
  try {
    const sanitized = raw.replace(/([:,[]\s*)(-?Infinity|NaN)(?=\s*[,\]}])/g, '$1null');
    const parsed = JSON.parse(sanitized);
    return Array.isArray(parsed) ? parsed as TurnsJsonEntry[] : null;
  } catch {
    return null;
  }
}

/**
 * Join turns.json onto a metrics.json IN PLACE: every response/interruption
 * turn gains turn_start / turn_end (the turn's boundaries in the recording)
 * and user_transcript / agent_transcript (STT text). Keyed by turn_index ==
 * turns.json index (verified against real output). Best-effort: turns without
 * a matching entry are left untouched.
 */
export function enrichMetricsWithTurns(metrics: Record<string, unknown>, turns: TurnsJsonEntry[]): void {
  const byIndex = new Map(turns.map(t => [t.index, t]));
  const joinText = (segs?: Array<{ text?: string }>) =>
    (segs ?? []).map(s => s.text).filter(Boolean).join(' ') || undefined;
  for (const family of ['response_metrics', 'interruption_metrics'] as const) {
    for (const turn of turnsOf(metrics, family)) {
      const t = byIndex.get(turn.turn_index as number);
      if (!t) continue;
      turn.turn_start = t.start;
      turn.turn_end = t.end;
      const user = joinText(t.user_segments);
      const agent = joinText(t.agent_segments);
      if (user) turn.user_transcript = user;
      if (agent) turn.agent_transcript = agent;
    }
  }
}
// Response turns flagged is_greeting are the agent's opening line, not an
// answered sample — exclude them from response counts (field confirmed
// against real aeval metrics.json output).
const validResponseVals = (turns: Record<string, unknown>[]) =>
  turns.filter(t => t.is_greeting !== true)
    .map(t => t.latency_ms as number)
    .filter(v => v != null && v >= 0);
// Single source of truth shared with the console UI (shared/metrics.ts).
export { INTERRUPT_ACTION_MAX_MS } from '../shared/metrics';
import { INTERRUPT_ACTION_MAX_MS } from '../shared/metrics';

// Always use interrupt_action_ms (= agent_stop_time − interruption time,
// aeval v0.2.1's primary metric): whether the agent actually stopped decides
// reaction-hood. reaction_time_ms_diagnostic is an internal estimator and is
// never consulted. reaction_time_ms only exists in pre-v0.2.1 output (where
// interrupt_action_ms is absent) and is the same stop-time semantic.
const validReactionVals = (turns: Record<string, unknown>[]) =>
  turns.map(t => (t.interrupt_action_ms ?? t.reaction_time_ms) as number)
    .filter(v => v != null && v >= 0 && v <= INTERRUPT_ACTION_MAX_MS);

/**
 * Aggregate per-case stats and cross-chunk rates from chunk metrics.
 * Denominators come from the daemon's own sample counts (ground truth), not
 * from aeval summaries — so rates are true aggregates, not last-chunk-wins.
 */
export function computePerCaseAndRates(entries: ChunkMetricsEntry[]): {
  perCase: Record<string, unknown>;
  rates: ComputedRates;
} {
  interface Acc {
    sampleCount: number; chunkCount: number; hasInterruptPhase: boolean;
    respVals: number[]; intVals: number[];
  }
  const byCase = new Map<string, Acc>();
  for (const e of entries) {
    let acc = byCase.get(e.caseId);
    if (!acc) {
      acc = { sampleCount: 0, chunkCount: 0, hasInterruptPhase: false, respVals: [], intVals: [] };
      byCase.set(e.caseId, acc);
    }
    acc.sampleCount += e.sampleCount;
    acc.chunkCount += 1;
    acc.hasInterruptPhase = acc.hasInterruptPhase || e.hasInterruptPhase;
    acc.respVals.push(...validResponseVals(turnsOf(e.metrics, 'response_metrics')));
    acc.intVals.push(...validReactionVals(turnsOf(e.metrics, 'interruption_metrics')));
  }

  const perCase: Record<string, unknown> = {};
  let totalSamples = 0, totalResponses = 0;
  let intSamples = 0, intReactions = 0;       // true-interrupt cases
  let falseSamples = 0, falseReactions = 0;   // false-interrupt cases

  for (const [caseId, a] of byCase) {
    const isFalse = isFalseInterruptCase(caseId);
    perCase[caseId] = {
      sample_count: a.sampleCount,
      chunk_count: a.chunkCount,
      has_interrupt_phase: a.hasInterruptPhase,
      false_interrupt_case: isFalse,
      response: {
        turn_count: a.respVals.length,
        median_ms: Math.round(median(a.respVals)),
        sd_ms: Math.round(popSd(a.respVals)),
        p95_ms: Math.round(p95(a.respVals)),
      },
      interruption: {
        turn_count: a.intVals.length,
        median_ms: Math.round(median(a.intVals)),
        sd_ms: Math.round(popSd(a.intVals)),
        p95_ms: Math.round(p95(a.intVals)),
      },
    };
    totalSamples += a.sampleCount;
    // A sample can legitimately yield multiple response turns (an interrupted
    // answer + the post-material answer both count as responses in v0.2.1 lab
    // output), so cap the numerator per case: the rate reads "fraction of
    // samples that got answered", never above 1 per case.
    totalResponses += Math.min(a.respVals.length, a.sampleCount);
    if (a.hasInterruptPhase) {
      if (a.intVals.length > a.sampleCount) {
        // >1 reaction per sample is unexpected — surface it, then cap.
        console.warn(`[chunking] case ${caseId}: ${a.intVals.length} reactions for ${a.sampleCount} samples — capping`);
      }
      const reactions = Math.min(a.intVals.length, a.sampleCount);
      if (isFalse) { falseSamples += a.sampleCount; falseReactions += reactions; }
      else { intSamples += a.sampleCount; intReactions += reactions; }
    }
  }

  const ratio = (num: number, den: number) => den > 0 ? Math.min(1, num / den) : null;

  // Turn Success Rate: pool every scored opportunity across all three
  // dimensions and take the fraction that succeeded. A response opportunity
  // succeeds when the agent responded; an interrupt opportunity when it stopped;
  // a false-interrupt opportunity when it did NOT barge in (falseSamples minus
  // the spurious reactions). Opportunity-weighted (each turn counts once) so
  // frequent dimensions naturally dominate — no arbitrary priority.
  const successfulTurns = totalResponses + intReactions + (falseSamples - falseReactions);
  const totalTurns = totalSamples + intSamples + falseSamples;
  const turnSuccessRate = totalTurns > 0 ? Math.min(1, successfulTurns / totalTurns) : null;

  return {
    perCase,
    rates: {
      response_rate: ratio(totalResponses, totalSamples),
      interrupt_rate: ratio(intReactions, intSamples),
      false_interrupt_rate: ratio(falseReactions, falseSamples),
      turn_success_rate: turnSuccessRate,
    },
  };
}

/**
 * Merge metrics.json outputs from multiple chunks into a single structure.
 *
 * Turn-level arrays are concatenated (each turn annotated with its case_id)
 * and re-indexed; the daemon's parser recomputes MED/SD/P95 from them — the
 * source of truth for the normal aeval path. For families/chunks that only
 * emit summary data, the last seen `summary`, `aggregated_summary`, and
 * scalar metrics are carried through so the parser's summary fallback works.
 * Also emits `per_case` (case-keyed stats) and `rates` (true cross-chunk
 * aggregates, denominators from the daemon's sample counts).
 */
export function mergeChunkMetrics(entries: ChunkMetricsEntry[]): Record<string, unknown> {
  const allResponseTurns: Record<string, unknown>[] = [];
  const allInterruptTurns: Record<string, unknown>[] = [];
  let responseSummary: unknown;
  let interruptSummary: unknown;
  let aggregated: unknown;
  let networkResilience: unknown;
  let naturalness: unknown;
  let noiseReduction: unknown;

  for (const e of entries) {
    const m = e.metrics;
    const rl = (m.response_metrics as Record<string, unknown> | undefined)?.latency as Record<string, unknown> | undefined;
    const il = (m.interruption_metrics as Record<string, unknown> | undefined)?.latency as Record<string, unknown> | undefined;
    // Annotate every turn with its case + chunk so merged data stays
    // attributable and turns from the same chunk can be cross-referenced.
    allResponseTurns.push(...turnsOf(m, 'response_metrics').map(t => ({ ...t, case_id: e.caseId, chunk_id: e.chunkId })));
    allInterruptTurns.push(...turnsOf(m, 'interruption_metrics').map(t => ({ ...t, case_id: e.caseId, chunk_id: e.chunkId })));
    // Carry through summary/scalar data (last non-empty wins) as a fallback
    // for families that lack turn-level data in the merged set.
    if (rl?.summary) responseSummary = rl.summary;
    if (il?.summary) interruptSummary = il.summary;
    if (m.aggregated_summary) aggregated = m.aggregated_summary;
    if (m.network_resilience != null) networkResilience = m.network_resilience;
    if (m.naturalness != null) naturalness = m.naturalness;
    if (m.noise_reduction != null) noiseReduction = m.noise_reduction;
  }

  // Re-index continuously across chunks, preserving each turn's original
  // (chunk-local) index — it keys back to the chunk's turns.json and lets the
  // UI pair an interruption with its follow-up response turn (index + 1).
  allResponseTurns.forEach((t, i) => {
    if (t.source_turn_index == null) t.source_turn_index = t.turn_index;
    t.turn_index = i + 1;
  });
  allInterruptTurns.forEach((t, i) => {
    if (t.source_turn_index == null) t.source_turn_index = t.turn_index;
    t.turn_index = i + 1;
  });

  const responseLatency: Record<string, unknown> = { turn_level: allResponseTurns };
  if (responseSummary) responseLatency.summary = responseSummary;
  const interruptLatency: Record<string, unknown> = { turn_level: allInterruptTurns };
  if (interruptSummary) interruptLatency.summary = interruptSummary;

  const { perCase, rates } = computePerCaseAndRates(entries);

  const merged: Record<string, unknown> = {
    response_metrics: { latency: responseLatency },
    interruption_metrics: { latency: interruptLatency },
    per_case: perCase,
    rates,
    _merged_from_chunks: entries.length,
  };
  if (aggregated) merged.aggregated_summary = aggregated;
  if (networkResilience != null) merged.network_resilience = networkResilience;
  if (naturalness != null) merged.naturalness = naturalness;
  if (noiseReduction != null) merged.noise_reduction = noiseReduction;

  return merged;
}
