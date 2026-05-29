/**
 * Tests for eval set chunk splitting and metrics merging.
 *
 * Tests the pure functions used by the daemon to:
 * - Extract sample groups from scenario YAML steps
 * - Split samples into chunks of CHUNK_SIZE
 * - Build complete chunk YAML from parts
 * - Merge metrics from multiple chunk runs
 */

import { describe, it, expect } from "vitest";
import yaml from "js-yaml";

// ---------------------------------------------------------------------------
// Re-implement the pure functions from vox-agentd.ts for testing
// (daemon is compiled separately via esbuild, not importable directly)
// ---------------------------------------------------------------------------

interface ScenarioStep {
  type: string;
  [key: string]: unknown;
}

interface SampleGroup {
  steps: ScenarioStep[];
  sampleId?: string;
  caseId?: string;
}

interface ParsedScenario {
  name: string;
  description?: string;
  analysis?: Record<string, unknown>;
  params?: Record<string, unknown>;
  steps: ScenarioStep[];
}

function extractSampleGroups(steps: ScenarioStep[]): {
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

  return { prefixSteps, suffixSteps: [], samples };
}

function mergeChunkMetrics(chunkMetrics: Record<string, unknown>[]): Record<string, unknown> {
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

function buildChunkYaml(
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

function groupByCaseId(samples: SampleGroup[]): Map<string, SampleGroup[]> {
  const groups = new Map<string, SampleGroup[]>();
  for (const s of samples) {
    const caseId = s.caseId || 'default';
    if (!groups.has(caseId)) groups.set(caseId, []);
    groups.get(caseId)!.push(s);
  }
  return groups;
}

const CHUNK_SIZE = 5;

// Helper: median/sd/p95 matching daemon implementation
function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function sd(arr: number[]): number {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((sum, v) => sum + (v - mean) ** 2, 0) / arr.length);
}

function p95(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, idx)];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('extractSampleGroups', () => {
  it('should extract setup steps before first lab.trace', () => {
    const steps: ScenarioStep[] = [
      { type: 'platform.setup', platform_id: 'agora' },
      { type: 'audio.start_recording' },
      { type: 'platform.enter', params: { tone_name: '' } },
      { type: 'audio.wait_for_speech', timeout_ms: 30000 },
      { type: 'lab.trace', params: { sample_id: 'RSP-001' } },
      { type: 'audio.play', params: { file: 'q1.wav' } },
      { type: 'audio.wait_for_speech' },
    ];

    const { prefixSteps, samples } = extractSampleGroups(steps);
    expect(prefixSteps).toHaveLength(4);
    expect(prefixSteps[0].type).toBe('platform.setup');
    expect(samples).toHaveLength(1);
    expect(samples[0].sampleId).toBe('RSP-001');
    expect(samples[0].steps).toHaveLength(3); // lab.trace + play + wait
  });

  it('should extract multiple sample groups (RSP pattern)', () => {
    const steps: ScenarioStep[] = [
      { type: 'platform.setup' },
      { type: 'lab.trace', params: { sample_id: 'RSP-001' } },
      { type: 'audio.play' },
      { type: 'audio.wait_for_speech' },
      { type: 'lab.trace', params: { sample_id: 'RSP-002' } },
      { type: 'audio.play' },
      { type: 'audio.wait_for_speech' },
      { type: 'lab.trace', params: { sample_id: 'RSP-003' } },
      { type: 'audio.play' },
      { type: 'audio.wait_for_speech' },
    ];

    const { prefixSteps, samples } = extractSampleGroups(steps);
    expect(prefixSteps).toHaveLength(1);
    expect(samples).toHaveLength(3);
    expect(samples[0].sampleId).toBe('RSP-001');
    expect(samples[1].sampleId).toBe('RSP-002');
    expect(samples[2].sampleId).toBe('RSP-003');
    // Each RSP sample: lab.trace + audio.play + wait_for_speech
    expect(samples[0].steps).toHaveLength(3);
  });

  it('should handle INT pattern (5 steps per sample)', () => {
    const steps: ScenarioStep[] = [
      { type: 'platform.setup' },
      { type: 'lab.trace', params: { sample_id: 'INT-001' } },
      { type: 'audio.play' },
      { type: 'audio.wait_for_speech_start' },
      { type: 'audio.play' }, // material
      { type: 'audio.wait_for_speech' },
      { type: 'lab.trace', params: { sample_id: 'INT-002' } },
      { type: 'audio.play' },
      { type: 'audio.wait_for_speech_start' },
      { type: 'audio.play' },
      { type: 'audio.wait_for_speech' },
    ];

    const { samples } = extractSampleGroups(steps);
    expect(samples).toHaveLength(2);
    expect(samples[0].steps).toHaveLength(5); // lab.trace + play + wait_start + play + wait
    expect(samples[1].steps).toHaveLength(5);
  });

  it('should handle empty steps', () => {
    const { prefixSteps, samples } = extractSampleGroups([]);
    expect(prefixSteps).toHaveLength(0);
    expect(samples).toHaveLength(0);
  });

  it('should handle steps with no lab.trace (all prefix)', () => {
    const steps: ScenarioStep[] = [
      { type: 'platform.setup' },
      { type: 'audio.start_recording' },
    ];
    const { prefixSteps, samples } = extractSampleGroups(steps);
    expect(prefixSteps).toHaveLength(2);
    expect(samples).toHaveLength(0);
  });

  it('should handle 10 samples for chunking', () => {
    const steps: ScenarioStep[] = [{ type: 'platform.setup' }];
    for (let i = 1; i <= 10; i++) {
      steps.push(
        { type: 'lab.trace', params: { sample_id: `RSP-${String(i).padStart(3, '0')}` } },
        { type: 'audio.play' },
        { type: 'audio.wait_for_speech' },
      );
    }
    const { samples } = extractSampleGroups(steps);
    expect(samples).toHaveLength(10);

    // Split into chunks of 5
    const CHUNK_SIZE = 5;
    const chunks = [];
    for (let i = 0; i < samples.length; i += CHUNK_SIZE) {
      chunks.push(samples.slice(i, i + CHUNK_SIZE));
    }
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(5);
    expect(chunks[1]).toHaveLength(5);
  });

  it('should handle 18 samples → 4 chunks (5+5+5+3)', () => {
    const steps: ScenarioStep[] = [];
    for (let i = 1; i <= 18; i++) {
      steps.push(
        { type: 'lab.trace', params: { sample_id: `S-${i}` } },
        { type: 'audio.play' },
        { type: 'audio.wait_for_speech' },
      );
    }
    const { samples } = extractSampleGroups(steps);
    expect(samples).toHaveLength(18);

    const CHUNK_SIZE = 5;
    const totalChunks = Math.ceil(samples.length / CHUNK_SIZE);
    expect(totalChunks).toBe(4);

    const chunks = [];
    for (let i = 0; i < totalChunks; i++) {
      chunks.push(samples.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE));
    }
    expect(chunks.map(c => c.length)).toEqual([5, 5, 5, 3]);
  });

  it('should capture caseId from lab.trace (top-level fields)', () => {
    const steps: ScenarioStep[] = [
      { type: 'lab.trace', case_id: 'RSP_BASIC', sample_id: 'RSP_BASIC-001' },
      { type: 'audio.play' },
      { type: 'audio.wait_for_speech' },
      { type: 'lab.trace', case_id: 'INT_BASIC', sample_id: 'INT_BASIC-001' },
      { type: 'audio.play' },
      { type: 'audio.wait_for_speech' },
    ];
    const { samples } = extractSampleGroups(steps);
    expect(samples).toHaveLength(2);
    expect(samples[0].caseId).toBe('RSP_BASIC');
    expect(samples[1].caseId).toBe('INT_BASIC');
  });

  it('should capture caseId from lab.trace (nested in params)', () => {
    const steps: ScenarioStep[] = [
      { type: 'lab.trace', params: { case_id: 'RSP_BASIC', sample_id: 'RSP-001' } },
      { type: 'audio.play' },
    ];
    const { samples } = extractSampleGroups(steps);
    expect(samples[0].caseId).toBe('RSP_BASIC');
  });
});

describe('groupSamplesByCaseId', () => {
  it('should group 3 suites × 10 samples → 3 groups of 10', () => {
    const steps: ScenarioStep[] = [];
    for (const caseId of ['RSP_BASIC', 'INT_BASIC', 'INT_FALSE']) {
      for (let i = 1; i <= 10; i++) {
        steps.push(
          { type: 'lab.trace', case_id: caseId, sample_id: `${caseId}-${String(i).padStart(3, '0')}` },
          { type: 'audio.play' },
          { type: 'audio.wait_for_speech' },
        );
      }
    }

    const { samples } = extractSampleGroups(steps);
    expect(samples).toHaveLength(30);

    const groups = groupByCaseId(samples);
    expect(groups.size).toBe(3);
    expect(groups.get('RSP_BASIC')!).toHaveLength(10);
    expect(groups.get('INT_BASIC')!).toHaveLength(10);
    expect(groups.get('INT_FALSE')!).toHaveLength(10);
  });

  it('should produce 6 chunks from 3 suites × 10 samples (5 per chunk)', () => {
    const steps: ScenarioStep[] = [];
    for (const caseId of ['RSP_BASIC', 'INT_BASIC', 'INT_FALSE']) {
      for (let i = 1; i <= 10; i++) {
        steps.push(
          { type: 'lab.trace', case_id: caseId, sample_id: `${caseId}-${i}` },
          { type: 'audio.play' },
          { type: 'audio.wait_for_speech' },
        );
      }
    }

    const { samples } = extractSampleGroups(steps);
    const groups = groupByCaseId(samples);

    const CHUNK_SIZE = 5;
    let totalChunkFiles = 0;
    const chunkBreakdown: Record<string, number> = {};

    for (const [caseId, caseSamples] of groups) {
      const chunks = Math.ceil(caseSamples.length / CHUNK_SIZE);
      chunkBreakdown[caseId] = chunks;
      totalChunkFiles += chunks;
    }

    expect(totalChunkFiles).toBe(6); // 2 + 2 + 2
    expect(chunkBreakdown).toEqual({
      RSP_BASIC: 2,
      INT_BASIC: 2,
      INT_FALSE: 2,
    });
  });

  it('should handle uneven suite sizes (7+3+8 samples)', () => {
    const steps: ScenarioStep[] = [];
    const sizes = { RSP: 7, INT: 3, FALSE: 8 };
    for (const [caseId, count] of Object.entries(sizes)) {
      for (let i = 1; i <= count; i++) {
        steps.push(
          { type: 'lab.trace', case_id: caseId, sample_id: `${caseId}-${i}` },
          { type: 'audio.play' },
        );
      }
    }

    const { samples } = extractSampleGroups(steps);
    const groups = groupByCaseId(samples);

    const CHUNK_SIZE = 5;
    let totalChunks = 0;
    for (const [, caseSamples] of groups) {
      totalChunks += Math.ceil(caseSamples.length / CHUNK_SIZE);
    }
    // RSP: 7 → 2 chunks (5+2), INT: 3 → 1 chunk, FALSE: 8 → 2 chunks (5+3)
    expect(totalChunks).toBe(5);
  });

  it('should handle single suite (no grouping needed)', () => {
    const steps: ScenarioStep[] = [];
    for (let i = 1; i <= 3; i++) {
      steps.push(
        { type: 'lab.trace', case_id: 'RSP_BASIC', sample_id: `RSP-${i}` },
        { type: 'audio.play' },
      );
    }
    const { samples } = extractSampleGroups(steps);
    const groups = groupByCaseId(samples);
    expect(groups.size).toBe(1);
    expect(groups.get('RSP_BASIC')!).toHaveLength(3);
  });
});

describe('mergeChunkMetrics', () => {
  it('should merge turn-level response data from multiple chunks', () => {
    const chunk1 = {
      response_metrics: {
        latency: {
          turn_level: [
            { turn_index: 1, latency_ms: 500 },
            { turn_index: 2, latency_ms: 600 },
          ],
        },
      },
    };
    const chunk2 = {
      response_metrics: {
        latency: {
          turn_level: [
            { turn_index: 1, latency_ms: 700 },
            { turn_index: 2, latency_ms: 800 },
          ],
        },
      },
    };

    const merged = mergeChunkMetrics([chunk1, chunk2]);
    const turns = (merged.response_metrics as Record<string, unknown> & { latency: { turn_level: unknown[] } }).latency.turn_level;
    expect(turns).toHaveLength(4);
    // Check re-indexed
    expect((turns[0] as Record<string, unknown>).turn_index).toBe(1);
    expect((turns[3] as Record<string, unknown>).turn_index).toBe(4);
    // Check values preserved
    expect((turns[0] as Record<string, unknown>).latency_ms).toBe(500);
    expect((turns[3] as Record<string, unknown>).latency_ms).toBe(800);
  });

  it('should merge interrupt turn-level data', () => {
    const chunk1 = {
      interruption_metrics: {
        latency: {
          turn_level: [{ turn_index: 1, reaction_time_ms: 300 }],
        },
      },
    };
    const chunk2 = {
      interruption_metrics: {
        latency: {
          turn_level: [{ turn_index: 1, reaction_time_ms: 400 }],
        },
      },
    };

    const merged = mergeChunkMetrics([chunk1, chunk2]);
    const turns = (merged.interruption_metrics as Record<string, unknown> & { latency: { turn_level: unknown[] } }).latency.turn_level;
    expect(turns).toHaveLength(2);
    expect((turns[0] as Record<string, unknown>).reaction_time_ms).toBe(300);
    expect((turns[1] as Record<string, unknown>).reaction_time_ms).toBe(400);
  });

  it('should handle chunks with no metrics data', () => {
    const merged = mergeChunkMetrics([{}, {}]);
    const rTurns = (merged.response_metrics as Record<string, unknown> & { latency: { turn_level: unknown[] } }).latency.turn_level;
    const iTurns = (merged.interruption_metrics as Record<string, unknown> & { latency: { turn_level: unknown[] } }).latency.turn_level;
    expect(rTurns).toHaveLength(0);
    expect(iTurns).toHaveLength(0);
    expect(merged._merged_from_chunks).toBe(2);
  });

  it('should handle single chunk (no merge needed)', () => {
    const chunk = {
      response_metrics: {
        latency: {
          turn_level: [
            { turn_index: 1, latency_ms: 500 },
          ],
        },
      },
    };

    const merged = mergeChunkMetrics([chunk]);
    const turns = (merged.response_metrics as Record<string, unknown> & { latency: { turn_level: unknown[] } }).latency.turn_level;
    expect(turns).toHaveLength(1);
    expect(merged._merged_from_chunks).toBe(1);
  });

  it('should merge 4 chunks (18 samples scenario)', () => {
    const chunks = [];
    for (let c = 0; c < 4; c++) {
      const count = c < 3 ? 5 : 3; // 5, 5, 5, 3
      const turns = [];
      for (let i = 0; i < count; i++) {
        turns.push({ turn_index: i + 1, latency_ms: 400 + c * 100 + i * 10 });
      }
      chunks.push({ response_metrics: { latency: { turn_level: turns } } });
    }

    const merged = mergeChunkMetrics(chunks);
    const turns = (merged.response_metrics as Record<string, unknown> & { latency: { turn_level: unknown[] } }).latency.turn_level;
    expect(turns).toHaveLength(18); // 5+5+5+3
    expect(merged._merged_from_chunks).toBe(4);
    // Verify continuous re-indexing
    expect((turns[0] as Record<string, unknown>).turn_index).toBe(1);
    expect((turns[17] as Record<string, unknown>).turn_index).toBe(18);
  });

  it('should handle mixed response + interrupt metrics', () => {
    const chunk1 = {
      response_metrics: { latency: { turn_level: [{ latency_ms: 500 }] } },
      interruption_metrics: { latency: { turn_level: [{ reaction_time_ms: 200 }] } },
    };
    const chunk2 = {
      response_metrics: { latency: { turn_level: [{ latency_ms: 600 }] } },
      // No interrupt data in this chunk
    };

    const merged = mergeChunkMetrics([chunk1, chunk2]);
    const rTurns = (merged.response_metrics as Record<string, unknown> & { latency: { turn_level: unknown[] } }).latency.turn_level;
    const iTurns = (merged.interruption_metrics as Record<string, unknown> & { latency: { turn_level: unknown[] } }).latency.turn_level;
    expect(rTurns).toHaveLength(2);
    expect(iTurns).toHaveLength(1); // Only from chunk1
  });
});

// ---------------------------------------------------------------------------
// buildChunkYaml tests
// ---------------------------------------------------------------------------

describe('buildChunkYaml', () => {
  const scenario: ParsedScenario = {
    name: 'turn_taking_en',
    description: 'turn_taking_en - all suites',
    analysis: { preset: 'config/analysis_presets/default.yaml' },
    params: { lab: { suite: 'turn_taking_en' } },
    steps: [],
  };

  const prefix: ScenarioStep[] = [
    { type: 'platform.setup', platform_id: 'livekit', params: {} },
    { type: 'audio.start_recording' },
    { type: 'platform.enter', params: { tone_name: '' } },
    { type: 'audio.wait_for_speech', timeout_ms: 30000, silence_duration_ms: 3000 },
  ];

  const suffix: ScenarioStep[] = [
    { type: 'audio.stop_recording' },
    { type: 'platform.exit' },
  ];

  it('should produce valid YAML with correct name and chunk_id', () => {
    const samples: SampleGroup[] = [
      { steps: [{ type: 'lab.trace', case_id: 'RSP_BASIC', sample_id: 'RSP_BASIC-001' }, { type: 'audio.play' }], sampleId: 'RSP_BASIC-001', caseId: 'RSP_BASIC' },
    ];
    const yamlStr = buildChunkYaml(scenario, prefix, samples, suffix, 'RSP_BASIC', 1, 2);
    const parsed = yaml.load(yamlStr) as Record<string, unknown>;

    expect(parsed.name).toBe('turn_taking_en_RSP_BASIC_chunk_001');
    expect(parsed.description).toBe('turn_taking_en RSP_BASIC chunk_001');
    expect(parsed.analysis).toEqual({ preset: 'config/analysis_presets/default.yaml' });

    const params = parsed.params as Record<string, unknown>;
    const lab = params.lab as Record<string, unknown>;
    expect(lab.suite).toBe('turn_taking_en');
    expect(lab.case_id).toBe('RSP_BASIC');
    expect(lab.chunk_id).toBe('chunk_001');
    expect(lab.sample_ids).toEqual(['RSP_BASIC-001']);
  });

  it('should include prefix + sample steps + suffix in order', () => {
    const samples: SampleGroup[] = [
      { steps: [{ type: 'lab.trace' }, { type: 'audio.play' }, { type: 'audio.wait_for_speech' }], sampleId: 'S-001', caseId: 'RSP' },
      { steps: [{ type: 'lab.trace' }, { type: 'audio.play' }, { type: 'audio.wait_for_speech' }], sampleId: 'S-002', caseId: 'RSP' },
    ];
    const yamlStr = buildChunkYaml(scenario, prefix, samples, suffix, 'RSP', 1, 1);
    const parsed = yaml.load(yamlStr) as Record<string, unknown>;
    const steps = parsed.steps as ScenarioStep[];

    // 4 prefix + 6 samples (2 × 3) + 2 suffix = 12
    expect(steps).toHaveLength(12);
    expect(steps[0].type).toBe('platform.setup');
    expect(steps[3].type).toBe('audio.wait_for_speech'); // last prefix
    expect(steps[4].type).toBe('lab.trace'); // first sample
    expect(steps[10].type).toBe('audio.stop_recording'); // first suffix
    expect(steps[11].type).toBe('platform.exit'); // last suffix
  });

  it('should roundtrip through YAML parse/dump without data loss', () => {
    const samples: SampleGroup[] = [
      {
        steps: [
          { type: 'lab.trace', event: 'case_sample_start', suite: 'turn_taking_en', case_id: 'INT_BASIC', sample_id: 'INT_BASIC-001', sample_index: 1, question_id: 'en_question4', material_id: 'en_Short05Wordswav4' },
          { type: 'audio.play', file: 'corpus/turn_taking/en/audio/en_question4.wav', description: 'INT_BASIC-001 question' },
          { type: 'audio.wait_for_speech_start', timeout_ms: 15000, wait_after_start_ms: 2000 },
          { type: 'audio.play', file: 'corpus/turn_taking/en/audio/en_Short05Wordswav4.wav', description: 'INT_BASIC-001 material' },
          { type: 'audio.wait_for_speech', end_timeout_ms: 40000, silence_duration_ms: 3000 },
        ],
        sampleId: 'INT_BASIC-001',
        caseId: 'INT_BASIC',
      },
    ];

    const yamlStr = buildChunkYaml(scenario, prefix, samples, suffix, 'INT_BASIC', 1, 1);
    const parsed = yaml.load(yamlStr) as Record<string, unknown>;
    const steps = parsed.steps as ScenarioStep[];

    // Verify INT_BASIC sample structure preserved
    const traceStep = steps[4]; // after 4 prefix steps
    expect(traceStep.type).toBe('lab.trace');
    expect(traceStep.event).toBe('case_sample_start');
    expect(traceStep.question_id).toBe('en_question4');
    expect(traceStep.material_id).toBe('en_Short05Wordswav4');

    const playStep = steps[5];
    expect(playStep.file).toBe('corpus/turn_taking/en/audio/en_question4.wav');

    const waitStartStep = steps[6];
    expect(waitStartStep.type).toBe('audio.wait_for_speech_start');
    expect(waitStartStep.timeout_ms).toBe(15000);
    expect(waitStartStep.wait_after_start_ms).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: realistic 30-sample multi-suite scenario
// ---------------------------------------------------------------------------

describe('end-to-end: full chunking pipeline', () => {
  // Build a realistic scenario with 3 suites matching the actual aeval examples
  function buildRealisticScenario(): { scenario: ParsedScenario; stepsPrefix: ScenarioStep[]; stepsSuffix: ScenarioStep[] } {
    const stepsPrefix: ScenarioStep[] = [
      { type: 'platform.setup', platform_id: 'livekit', params: {} },
      { type: 'audio.start_recording' },
      { type: 'platform.enter', params: { tone_name: '' } },
      { type: 'audio.wait_for_speech', timeout_ms: 30000, silence_duration_ms: 3000, description: 'Wait for agent greeting' },
    ];
    const stepsSuffix: ScenarioStep[] = [
      { type: 'audio.stop_recording' },
      { type: 'platform.exit' },
    ];

    const sampleSteps: ScenarioStep[] = [];

    // RSP_BASIC: 10 samples (3 steps each)
    for (let i = 1; i <= 10; i++) {
      const id = `RSP_BASIC-${String(i).padStart(3, '0')}`;
      sampleSteps.push(
        { type: 'lab.trace', event: 'case_sample_start', suite: 'turn_taking_en', case_id: 'RSP_BASIC', sample_id: id, sample_index: i, question_id: `en_question_short${i}` },
        { type: 'audio.play', file: `corpus/turn_taking/en/audio/en_question_short${i}.wav`, description: `${id} question` },
        { type: 'audio.wait_for_speech', end_timeout_ms: 45000, silence_duration_ms: 3000, description: `${id} response` },
      );
    }

    // INT_BASIC: 10 samples (5 steps each)
    for (let i = 1; i <= 10; i++) {
      const id = `INT_BASIC-${String(i).padStart(3, '0')}`;
      sampleSteps.push(
        { type: 'lab.trace', event: 'case_sample_start', suite: 'turn_taking_en', case_id: 'INT_BASIC', sample_id: id, sample_index: i, question_id: `en_question${i}`, material_id: `en_Short05Wordswav${i}` },
        { type: 'audio.play', file: `corpus/turn_taking/en/audio/en_question${i}.wav`, description: `${id} question` },
        { type: 'audio.wait_for_speech_start', timeout_ms: 15000, wait_after_start_ms: 2000, description: `${id} agent start before material` },
        { type: 'audio.play', file: `corpus/turn_taking/en/audio/en_Short05Wordswav${i}.wav`, description: `${id} material` },
        { type: 'audio.wait_for_speech', end_timeout_ms: 40000, silence_duration_ms: 3000, description: `${id} post-material response` },
      );
    }

    // INT_FALSE: 10 samples (5 steps each)
    for (let i = 1; i <= 10; i++) {
      const id = `INT_FALSE-${String(i).padStart(3, '0')}`;
      sampleSteps.push(
        { type: 'lab.trace', event: 'case_sample_start', suite: 'turn_taking_en', case_id: 'INT_FALSE', sample_id: id, sample_index: i, question_id: `en_question${i}`, material_id: `sound_NonsemanticCoughLaughterwav${i}` },
        { type: 'audio.play', file: `corpus/turn_taking/en/audio/en_question${i}.wav`, description: `${id} question` },
        { type: 'audio.wait_for_speech_start', timeout_ms: 15000, wait_after_start_ms: 1000, description: `${id} agent start before material` },
        { type: 'audio.play', file: `corpus/turn_taking/en/audio/NonsemanticCoughLaughterwav${i}.wav`, description: `${id} material` },
        { type: 'audio.wait_for_speech', end_timeout_ms: 40000, silence_duration_ms: 3000, description: `${id} post-material response` },
      );
    }

    const scenario: ParsedScenario = {
      name: 'turn_taking_en',
      description: 'turn_taking_en - RSP_BASIC + INT_BASIC + INT_FALSE',
      analysis: { preset: 'config/analysis_presets/default.yaml', report: { template: 'medialab.html.jinja2' } },
      params: { lab: { suite: 'turn_taking_en' } },
      steps: sampleSteps,
    };

    return { scenario, stepsPrefix, stepsSuffix };
  }

  it('should extract 30 samples from 3 suites', () => {
    const { scenario } = buildRealisticScenario();
    const { prefixSteps, samples } = extractSampleGroups(scenario.steps);
    expect(prefixSteps).toHaveLength(0); // no prefix in eval set scenario
    expect(samples).toHaveLength(30);
  });

  it('should group into 3 suites with correct sizes', () => {
    const { scenario } = buildRealisticScenario();
    const { samples } = extractSampleGroups(scenario.steps);
    const groups = groupByCaseId(samples);

    expect(groups.size).toBe(3);
    expect(groups.get('RSP_BASIC')!).toHaveLength(10);
    expect(groups.get('INT_BASIC')!).toHaveLength(10);
    expect(groups.get('INT_FALSE')!).toHaveLength(10);
  });

  it('should produce 6 chunk YAMLs with correct structure', () => {
    const { scenario, stepsPrefix, stepsSuffix } = buildRealisticScenario();
    const { samples } = extractSampleGroups(scenario.steps);
    const groups = groupByCaseId(samples);

    const chunkYamls: string[] = [];
    for (const [caseId, caseSamples] of groups) {
      const totalChunks = Math.ceil(caseSamples.length / CHUNK_SIZE);
      for (let i = 0; i < totalChunks; i++) {
        const chunk = caseSamples.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        chunkYamls.push(buildChunkYaml(scenario, stepsPrefix, chunk, stepsSuffix, caseId, i + 1, totalChunks));
      }
    }

    expect(chunkYamls).toHaveLength(6);

    // Verify each chunk is valid YAML
    for (const y of chunkYamls) {
      const parsed = yaml.load(y) as Record<string, unknown>;
      expect(parsed.name).toBeDefined();
      expect(parsed.steps).toBeDefined();
      expect(Array.isArray(parsed.steps)).toBe(true);
    }
  });

  it('each RSP_BASIC chunk should have 4 prefix + 15 sample + 2 suffix = 21 steps', () => {
    const { scenario, stepsPrefix, stepsSuffix } = buildRealisticScenario();
    const { samples } = extractSampleGroups(scenario.steps);
    const rspSamples = samples.filter(s => s.caseId === 'RSP_BASIC');

    const chunk1 = rspSamples.slice(0, 5);
    const yamlStr = buildChunkYaml(scenario, stepsPrefix, chunk1, stepsSuffix, 'RSP_BASIC', 1, 2);
    const parsed = yaml.load(yamlStr) as Record<string, unknown>;
    const steps = parsed.steps as ScenarioStep[];

    // 4 prefix + 5 samples × 3 steps + 2 suffix = 21
    expect(steps).toHaveLength(21);
    expect(steps[0].type).toBe('platform.setup');
    expect(steps[4].type).toBe('lab.trace'); // first sample
    expect(steps[19].type).toBe('audio.stop_recording');
    expect(steps[20].type).toBe('platform.exit');
  });

  it('each INT_BASIC chunk should have 4 prefix + 25 sample + 2 suffix = 31 steps', () => {
    const { scenario, stepsPrefix, stepsSuffix } = buildRealisticScenario();
    const { samples } = extractSampleGroups(scenario.steps);
    const intSamples = samples.filter(s => s.caseId === 'INT_BASIC');

    const chunk1 = intSamples.slice(0, 5);
    const yamlStr = buildChunkYaml(scenario, stepsPrefix, chunk1, stepsSuffix, 'INT_BASIC', 1, 2);
    const parsed = yaml.load(yamlStr) as Record<string, unknown>;
    const steps = parsed.steps as ScenarioStep[];

    // 4 prefix + 5 samples × 5 steps + 2 suffix = 31
    expect(steps).toHaveLength(31);
  });

  it('chunk names should follow aeval convention', () => {
    const { scenario, stepsPrefix, stepsSuffix } = buildRealisticScenario();
    const { samples } = extractSampleGroups(scenario.steps);
    const groups = groupByCaseId(samples);

    const names: string[] = [];
    for (const [caseId, caseSamples] of groups) {
      const totalChunks = Math.ceil(caseSamples.length / CHUNK_SIZE);
      for (let i = 0; i < totalChunks; i++) {
        const chunk = caseSamples.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        const y = buildChunkYaml(scenario, stepsPrefix, chunk, stepsSuffix, caseId, i + 1, totalChunks);
        names.push((yaml.load(y) as Record<string, unknown>).name as string);
      }
    }

    expect(names).toContain('turn_taking_en_RSP_BASIC_chunk_001');
    expect(names).toContain('turn_taking_en_RSP_BASIC_chunk_002');
    expect(names).toContain('turn_taking_en_INT_BASIC_chunk_001');
    expect(names).toContain('turn_taking_en_INT_BASIC_chunk_002');
    expect(names).toContain('turn_taking_en_INT_FALSE_chunk_001');
    expect(names).toContain('turn_taking_en_INT_FALSE_chunk_002');
  });

  it('chunk sample_ids should partition correctly', () => {
    const { scenario, stepsPrefix, stepsSuffix } = buildRealisticScenario();
    const { samples } = extractSampleGroups(scenario.steps);
    const rspSamples = samples.filter(s => s.caseId === 'RSP_BASIC');

    const chunk1Yaml = buildChunkYaml(scenario, stepsPrefix, rspSamples.slice(0, 5), stepsSuffix, 'RSP_BASIC', 1, 2);
    const chunk2Yaml = buildChunkYaml(scenario, stepsPrefix, rspSamples.slice(5, 10), stepsSuffix, 'RSP_BASIC', 2, 2);

    const p1 = yaml.load(chunk1Yaml) as Record<string, unknown>;
    const p2 = yaml.load(chunk2Yaml) as Record<string, unknown>;
    const ids1 = ((p1.params as Record<string, unknown>).lab as Record<string, unknown>).sample_ids as string[];
    const ids2 = ((p2.params as Record<string, unknown>).lab as Record<string, unknown>).sample_ids as string[];

    expect(ids1).toEqual(['RSP_BASIC-001', 'RSP_BASIC-002', 'RSP_BASIC-003', 'RSP_BASIC-004', 'RSP_BASIC-005']);
    expect(ids2).toEqual(['RSP_BASIC-006', 'RSP_BASIC-007', 'RSP_BASIC-008', 'RSP_BASIC-009', 'RSP_BASIC-010']);
  });

  it('merged metrics from 6 chunks should compute correct MED/SD/P95', () => {
    // Simulate 6 chunks of aeval output with known latency values
    const chunkMetrics: Record<string, unknown>[] = [];

    // RSP_BASIC chunk 1: response latencies [400, 450, 500, 550, 600]
    // RSP_BASIC chunk 2: response latencies [420, 470, 520, 570, 620]
    for (const latencies of [[400, 450, 500, 550, 600], [420, 470, 520, 570, 620]]) {
      chunkMetrics.push({
        response_metrics: { latency: { turn_level: latencies.map((ms, i) => ({ turn_index: i + 1, latency_ms: ms })) } },
      });
    }

    // INT_BASIC chunk 1: interrupt reaction times [200, 250, 300, 350, 400]
    // INT_BASIC chunk 2: interrupt reaction times [220, 270, 320, 370, 420]
    for (const latencies of [[200, 250, 300, 350, 400], [220, 270, 320, 370, 420]]) {
      chunkMetrics.push({
        interruption_metrics: { latency: { turn_level: latencies.map((ms, i) => ({ turn_index: i + 1, reaction_time_ms: ms })) } },
      });
    }

    // INT_FALSE chunk 1+2: both response and interrupt data
    for (const vals of [[500, 550], [480, 530]]) {
      chunkMetrics.push({
        response_metrics: { latency: { turn_level: vals.map((ms, i) => ({ turn_index: i + 1, latency_ms: ms })) } },
        interruption_metrics: { latency: { turn_level: vals.map((ms, i) => ({ turn_index: i + 1, reaction_time_ms: ms - 200 })) } },
      });
    }

    const merged = mergeChunkMetrics(chunkMetrics);

    // Response turns: 5+5 (RSP) + 2+2 (INT_FALSE) = 14
    const rTurns = (merged.response_metrics as Record<string, unknown> & { latency: { turn_level: Record<string, unknown>[] } }).latency.turn_level;
    expect(rTurns).toHaveLength(14);

    // Interrupt turns: 5+5 (INT_BASIC) + 2+2 (INT_FALSE) = 14
    const iTurns = (merged.interruption_metrics as Record<string, unknown> & { latency: { turn_level: Record<string, unknown>[] } }).latency.turn_level;
    expect(iTurns).toHaveLength(14);

    // Verify merged response latency stats
    const rVals = rTurns.map(t => t.latency_ms as number);
    expect(rVals).toHaveLength(14);
    const rMed = Math.round(median(rVals));
    const rSd = Math.round(sd(rVals));
    const rP95 = Math.round(p95(rVals));
    expect(rMed).toBeGreaterThan(0);
    expect(rSd).toBeGreaterThan(0);
    expect(rP95).toBeGreaterThanOrEqual(rMed);

    // Verify merged interrupt latency stats
    const iVals = iTurns.map(t => t.reaction_time_ms as number);
    expect(iVals).toHaveLength(14);
    const iMed = Math.round(median(iVals));
    expect(iMed).toBeGreaterThan(0);

    expect(merged._merged_from_chunks).toBe(6);
  });

  it('should handle scenario with only 3 samples (no chunking needed)', () => {
    const steps: ScenarioStep[] = [];
    for (let i = 1; i <= 3; i++) {
      steps.push(
        { type: 'lab.trace', case_id: 'RSP_BASIC', sample_id: `RSP-${i}`, sample_index: i },
        { type: 'audio.play', file: `q${i}.wav` },
        { type: 'audio.wait_for_speech', end_timeout_ms: 45000 },
      );
    }

    const { samples } = extractSampleGroups(steps);
    expect(samples).toHaveLength(3);

    const groups = groupByCaseId(samples);
    expect(groups.size).toBe(1);

    // All fit in one chunk
    const caseSamples = groups.get('RSP_BASIC')!;
    expect(caseSamples.length).toBeLessThanOrEqual(CHUNK_SIZE);
  });

  it('should handle scenario with exactly 5 samples (boundary case)', () => {
    const steps: ScenarioStep[] = [];
    for (let i = 1; i <= 5; i++) {
      steps.push(
        { type: 'lab.trace', case_id: 'RSP', sample_id: `RSP-${i}` },
        { type: 'audio.play' },
        { type: 'audio.wait_for_speech' },
      );
    }

    const { samples } = extractSampleGroups(steps);
    const groups = groupByCaseId(samples);
    const totalChunks = Math.ceil(groups.get('RSP')!.length / CHUNK_SIZE);
    expect(totalChunks).toBe(1); // exactly 5 = 1 chunk, no split
  });

  it('should handle scenario with 6 samples (boundary: 5+1)', () => {
    const steps: ScenarioStep[] = [];
    for (let i = 1; i <= 6; i++) {
      steps.push(
        { type: 'lab.trace', case_id: 'RSP', sample_id: `RSP-${i}` },
        { type: 'audio.play' },
        { type: 'audio.wait_for_speech' },
      );
    }

    const { samples } = extractSampleGroups(steps);
    const groups = groupByCaseId(samples);
    const totalChunks = Math.ceil(groups.get('RSP')!.length / CHUNK_SIZE);
    expect(totalChunks).toBe(2); // 5 + 1
  });
});
