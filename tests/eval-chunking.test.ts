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
  // Helper: group samples by caseId (same logic as daemon)
  function groupByCaseId(samples: SampleGroup[]): Map<string, SampleGroup[]> {
    const groups = new Map<string, SampleGroup[]>();
    for (const s of samples) {
      const caseId = s.caseId || 'default';
      if (!groups.has(caseId)) groups.set(caseId, []);
      groups.get(caseId)!.push(s);
    }
    return groups;
  }

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
