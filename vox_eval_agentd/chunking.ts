/**
 * Eval set chunk splitting — pure functions, no side effects.
 *
 * Large eval sets (>CHUNK_SIZE samples) are split into chunk files so each
 * aeval run handles a small number of samples. Samples are grouped by case_id
 * (suite), then each group is chunked independently.
 *
 * This module is imported by both the daemon (vox-agentd.ts) and the tests,
 * so the tested logic is the same code that runs in production.
 */

import yaml from 'js-yaml';

export const CHUNK_SIZE = 5; // max samples per aeval run

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
      const sampleId = (step.sample_id ?? (step.params as Record<string, unknown> | undefined)?.sample_id) as string | undefined;
      const caseId = (step.case_id ?? (step.params as Record<string, unknown> | undefined)?.case_id) as string | undefined;
      current = { steps: [step], sampleId, caseId };
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

/** Group samples by case_id (suite). Samples with no caseId fall under 'default'. */
export function groupByCaseId(samples: SampleGroup[]): Map<string, SampleGroup[]> {
  const groups = new Map<string, SampleGroup[]>();
  for (const s of samples) {
    const caseId = s.caseId || 'default';
    if (!groups.has(caseId)) groups.set(caseId, []);
    groups.get(caseId)!.push(s);
  }
  return groups;
}

/**
 * Build a complete chunk YAML from parts:
 *   metadata + stepsPrefix + chunk samples + stepsSuffix
 */
export function buildChunkYaml(
  scenario: ParsedScenario,
  stepsPrefix: ScenarioStep[],
  chunkSamples: SampleGroup[],
  stepsSuffix: ScenarioStep[],
  caseId: string,
  chunkIndex: number,
  totalChunks: number,
): string {
  const chunkId = `chunk_${String(chunkIndex).padStart(3, '0')}`;
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
  if (scenario.analysis) chunkScenario.analysis = scenario.analysis;

  const labBase = (scenario.params?.lab && typeof scenario.params.lab === 'object')
    ? { ...(scenario.params.lab as Record<string, unknown>) }
    : {};
  chunkScenario.params = {
    ...(scenario.params || {}),
    lab: { ...labBase, case_id: caseId, chunk_id: chunkId, sample_ids: sampleIds },
  };
  chunkScenario.steps = chunkSteps;

  return yaml.dump(chunkScenario, { lineWidth: -1, noRefs: true });
}

/**
 * Merge metrics.json outputs from multiple chunks into a single structure.
 * Concatenates turn-level arrays and re-indexes turn numbers. MED/SD/P95 are
 * recomputed downstream by the daemon's metrics parser from these merged turns.
 */
export function mergeChunkMetrics(chunkMetrics: Record<string, unknown>[]): Record<string, unknown> {
  const allResponseTurns: Record<string, unknown>[] = [];
  const allInterruptTurns: Record<string, unknown>[] = [];

  for (const m of chunkMetrics) {
    const rm = m.response_metrics as Record<string, unknown> | undefined;
    const im = m.interruption_metrics as Record<string, unknown> | undefined;
    const rlTurns = (rm?.latency as Record<string, unknown>)?.turn_level;
    const ilTurns = (im?.latency as Record<string, unknown>)?.turn_level;
    if (Array.isArray(rlTurns)) allResponseTurns.push(...rlTurns);
    if (Array.isArray(ilTurns)) allInterruptTurns.push(...ilTurns);
  }

  allResponseTurns.forEach((t, i) => { t.turn_index = i + 1; });
  allInterruptTurns.forEach((t, i) => { t.turn_index = i + 1; });

  return {
    response_metrics: { latency: { turn_level: allResponseTurns } },
    interruption_metrics: { latency: { turn_level: allInterruptTurns } },
    _merged_from_chunks: chunkMetrics.length,
  };
}
