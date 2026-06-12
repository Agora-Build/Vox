/**
 * Tests for eval set chunk splitting and metrics merging.
 *
 * These import the SAME pure functions the daemon uses (from
 * vox_eval_agentd/chunking.ts), so a regression in production code is caught
 * here instead of passing against a divergent re-implementation.
 *
 * Chunking is DATA-DRIVEN: each lab.trace carries case_id + chunk_id, and the
 * daemon emits one aeval file per (case_id, chunk_id). CHUNK_SIZE is only a soft
 * warn threshold — there is no size-based splitting.
 */

import { describe, it, expect } from "vitest";
import yaml from "js-yaml";
import {
  CHUNK_SIZE,
  type ScenarioStep,
  type SampleGroup,
  type ParsedScenario,
  type ChunkMetricsEntry,
  sanitizeForFilename,
  extractSampleGroups,
  groupSamplesByChunk,
  groupHasInterruptPhase,
  resolveCaseAnalysis,
  isFalseInterruptCase,
  computePerCaseAndRates,
  buildChunkYaml,
  mergeChunkMetrics,
  composeScenarioYaml,
} from "../vox_eval_agentd/chunking";

const pad = (i: number) => String(i).padStart(3, "0");

// Test-only stats helpers — mirror the daemon's metrics parser so we can assert
// that merged turn-level data produces sensible MED/SD/P95.
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
// sanitizeForFilename — path traversal protection
// ---------------------------------------------------------------------------

describe("sanitizeForFilename", () => {
  it("passes through safe values", () => {
    expect(sanitizeForFilename("RSP_BASIC")).toBe("RSP_BASIC");
    expect(sanitizeForFilename("INT-FALSE.v2")).toBe("INT-FALSE.v2");
    expect(sanitizeForFilename("chunk_001")).toBe("chunk_001");
  });

  it("strips path traversal sequences", () => {
    const out = sanitizeForFilename("../../../etc/passwd");
    expect(out).not.toContain("..");
    expect(out).not.toContain("/");
  });

  it("removes path separators", () => {
    expect(sanitizeForFilename("a/b/c")).not.toContain("/");
    expect(sanitizeForFilename("a\\b")).not.toContain("\\");
  });

  it("collapses repeated dots", () => {
    expect(sanitizeForFilename("a..b")).not.toContain("..");
  });

  it("returns fallback for empty/undefined", () => {
    expect(sanitizeForFilename(undefined)).toBe("x");
    expect(sanitizeForFilename("")).toBe("x");
    expect(sanitizeForFilename("...")).toBe("x");
    expect(sanitizeForFilename("/")).toBe("x");
  });

  it("caps length at 64 chars", () => {
    expect(sanitizeForFilename("a".repeat(200)).length).toBeLessThanOrEqual(64);
  });

  it("a sanitized case_id/chunk_id cannot escape a tmp prefix", () => {
    const prefix = `vox-${sanitizeForFilename("../../../etc/cron.d/evil")}-${sanitizeForFilename("../x")}`;
    expect(prefix).not.toContain("/");
    expect(prefix).not.toContain("..");
  });
});

// ---------------------------------------------------------------------------
// extractSampleGroups
// ---------------------------------------------------------------------------

describe("extractSampleGroups", () => {
  it("extracts setup steps before first lab.trace", () => {
    const steps: ScenarioStep[] = [
      { type: "platform.setup", platform_id: "agora" },
      { type: "audio.start_recording" },
      { type: "platform.enter", params: { tone_name: "" } },
      { type: "audio.wait_for_speech", timeout_ms: 30000 },
      { type: "lab.trace", params: { sample_id: "RSP-001" } },
      { type: "audio.play", params: { file: "q1.wav" } },
      { type: "audio.wait_for_speech" },
    ];
    const { prefixSteps, samples } = extractSampleGroups(steps);
    expect(prefixSteps).toHaveLength(4);
    expect(prefixSteps[0].type).toBe("platform.setup");
    expect(samples).toHaveLength(1);
    expect(samples[0].sampleId).toBe("RSP-001");
    expect(samples[0].steps).toHaveLength(3);
  });

  it("extracts multiple RSP sample groups (3 steps each)", () => {
    const steps: ScenarioStep[] = [{ type: "platform.setup" }];
    for (const id of ["RSP-001", "RSP-002", "RSP-003"]) {
      steps.push(
        { type: "lab.trace", params: { sample_id: id } },
        { type: "audio.play" },
        { type: "audio.wait_for_speech" },
      );
    }
    const { prefixSteps, samples } = extractSampleGroups(steps);
    expect(prefixSteps).toHaveLength(1);
    expect(samples).toHaveLength(3);
    expect(samples.map(s => s.sampleId)).toEqual(["RSP-001", "RSP-002", "RSP-003"]);
    expect(samples[0].steps).toHaveLength(3);
  });

  it("handles INT pattern (5 steps per sample)", () => {
    const steps: ScenarioStep[] = [{ type: "platform.setup" }];
    for (const id of ["INT-001", "INT-002"]) {
      steps.push(
        { type: "lab.trace", params: { sample_id: id } },
        { type: "audio.play" },
        { type: "audio.wait_for_speech_start" },
        { type: "audio.play" },
        { type: "audio.wait_for_speech" },
      );
    }
    const { samples } = extractSampleGroups(steps);
    expect(samples).toHaveLength(2);
    expect(samples[0].steps).toHaveLength(5);
    expect(samples[1].steps).toHaveLength(5);
  });

  it("handles empty steps", () => {
    const { prefixSteps, samples } = extractSampleGroups([]);
    expect(prefixSteps).toHaveLength(0);
    expect(samples).toHaveLength(0);
  });

  it("handles steps with no lab.trace (all prefix)", () => {
    const { prefixSteps, samples } = extractSampleGroups([
      { type: "platform.setup" },
      { type: "audio.start_recording" },
    ]);
    expect(prefixSteps).toHaveLength(2);
    expect(samples).toHaveLength(0);
  });

  it("captures case_id + chunk_id from top-level lab.trace fields", () => {
    const steps: ScenarioStep[] = [
      { type: "lab.trace", case_id: "RSP_BASIC", chunk_id: "chunk_001", sample_id: "RSP_BASIC-001" },
      { type: "audio.play" },
      { type: "lab.trace", case_id: "INT_BASIC", chunk_id: "chunk_002", sample_id: "INT_BASIC-006" },
      { type: "audio.play" },
    ];
    const { samples } = extractSampleGroups(steps);
    expect(samples[0].caseId).toBe("RSP_BASIC");
    expect(samples[0].chunkId).toBe("chunk_001");
    expect(samples[1].caseId).toBe("INT_BASIC");
    expect(samples[1].chunkId).toBe("chunk_002");
  });

  it("captures case_id + chunk_id nested in params", () => {
    const { samples } = extractSampleGroups([
      { type: "lab.trace", params: { case_id: "RSP_BASIC", chunk_id: "chunk_003", sample_id: "RSP-001" } },
      { type: "audio.play" },
    ]);
    expect(samples[0].caseId).toBe("RSP_BASIC");
    expect(samples[0].chunkId).toBe("chunk_003");
  });

  // --- teardown extraction (regression for "teardown only in last chunk") ---

  it("pulls trailing teardown steps into suffixSteps", () => {
    const steps: ScenarioStep[] = [
      { type: "platform.setup" },
      { type: "lab.trace", sample_id: "RSP-001", case_id: "RSP" },
      { type: "audio.play" },
      { type: "audio.wait_for_speech" },
      { type: "audio.stop_recording" },
      { type: "platform.exit" },
    ];
    const { prefixSteps, samples, suffixSteps } = extractSampleGroups(steps);
    expect(prefixSteps).toHaveLength(1);
    expect(suffixSteps.map(s => s.type)).toEqual(["audio.stop_recording", "platform.exit"]);
    expect(samples).toHaveLength(1);
    expect(samples[0].steps.map(s => s.type)).toEqual(["lab.trace", "audio.play", "audio.wait_for_speech"]);
  });

  it("does not strip a sample's own steps when no teardown present", () => {
    const steps: ScenarioStep[] = [
      { type: "lab.trace", sample_id: "RSP-001" },
      { type: "audio.play" },
      { type: "audio.wait_for_speech" },
    ];
    const { samples, suffixSteps } = extractSampleGroups(steps);
    expect(suffixSteps).toHaveLength(0);
    expect(samples[0].steps).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// groupSamplesByChunk — file boundaries come from (case_id, chunk_id)
// ---------------------------------------------------------------------------

describe("groupSamplesByChunk", () => {
  /** Build samples tagged with case_id + chunk_id from a {caseId: [chunkIds...]} spec. */
  function buildSteps(spec: Array<[string, string]>): ScenarioStep[] {
    const steps: ScenarioStep[] = [];
    let n = 0;
    for (const [caseId, chunkId] of spec) {
      n++;
      steps.push(
        { type: "lab.trace", case_id: caseId, chunk_id: chunkId, sample_id: `${caseId}-${pad(n)}` },
        { type: "audio.play" },
        { type: "audio.wait_for_speech" },
      );
    }
    return steps;
  }

  it("groups 3 cases × 2 chunks → 6 groups, order preserved", () => {
    const spec: Array<[string, string]> = [];
    for (const c of ["RSP_BASIC", "INT_BASIC", "INT_FALSE"]) {
      for (let i = 1; i <= 10; i++) spec.push([c, i <= 5 ? "chunk_001" : "chunk_002"]);
    }
    const { samples } = extractSampleGroups(buildSteps(spec));
    expect(samples).toHaveLength(30);

    const groups = groupSamplesByChunk(samples);
    expect(groups).toHaveLength(6);
    expect(groups.map(g => `${g.caseId}/${g.chunkId}`)).toEqual([
      "RSP_BASIC/chunk_001", "RSP_BASIC/chunk_002",
      "INT_BASIC/chunk_001", "INT_BASIC/chunk_002",
      "INT_FALSE/chunk_001", "INT_FALSE/chunk_002",
    ]);
    expect(groups.every(g => g.samples.length === 5)).toBe(true);
  });

  it("respects data-defined boundaries, NOT a fixed size (10 in one chunk → 1 group of 10)", () => {
    const spec: Array<[string, string]> = [];
    for (let i = 1; i <= 10; i++) spec.push(["RSP_BASIC", "chunk_001"]);
    const { samples } = extractSampleGroups(buildSteps(spec));
    const groups = groupSamplesByChunk(samples);
    expect(groups).toHaveLength(1);
    expect(groups[0].samples).toHaveLength(10); // daemon warns ( > CHUNK_SIZE ) but does NOT split
    expect(groups[0].samples.length).toBeGreaterThan(CHUNK_SIZE);
  });

  it("defaults missing chunk_id to chunk_001 and missing case_id to default", () => {
    const { samples } = extractSampleGroups([
      { type: "lab.trace", sample_id: "X-1" },
      { type: "audio.play" },
    ]);
    const groups = groupSamplesByChunk(samples);
    expect(groups).toHaveLength(1);
    expect(groups[0].caseId).toBe("default");
    expect(groups[0].chunkId).toBe("chunk_001");
  });

  it("splits same case across chunks but keeps chunks separate", () => {
    const { samples } = extractSampleGroups(buildSteps([
      ["RSP", "chunk_001"], ["RSP", "chunk_001"], ["RSP", "chunk_002"],
    ]));
    const groups = groupSamplesByChunk(samples);
    expect(groups).toHaveLength(2);
    expect(groups[0].samples).toHaveLength(2);
    expect(groups[1].samples).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// resolveCaseAnalysis — per-case preset, falling back to top-level analysis
// ---------------------------------------------------------------------------

describe("resolveCaseAnalysis", () => {
  it("returns the per-case analysis when params.lab.cases[caseId] exists", () => {
    const scenario: ParsedScenario = {
      name: "s",
      analysis: { preset: "config/analysis_presets/default.yaml" },
      params: {
        lab: {
          cases: {
            INT_FALSE: { analysis: { preset: "config/analysis_presets/lab_int_false.yaml" } },
          },
        },
      },
      steps: [],
    };
    expect(resolveCaseAnalysis(scenario, "INT_FALSE")).toEqual({ preset: "config/analysis_presets/lab_int_false.yaml" });
  });

  it("falls back to top-level analysis when no per-case entry", () => {
    const scenario: ParsedScenario = {
      name: "s",
      analysis: { preset: "config/analysis_presets/default.yaml" },
      params: { lab: { cases: { INT_FALSE: { analysis: { preset: "x" } } } } },
      steps: [],
    };
    expect(resolveCaseAnalysis(scenario, "RSP_BASIC")).toEqual({ preset: "config/analysis_presets/default.yaml" });
  });

  it("returns undefined when neither per-case nor top-level analysis exists", () => {
    const scenario: ParsedScenario = { name: "s", params: { lab: {} }, steps: [] };
    expect(resolveCaseAnalysis(scenario, "RSP_BASIC")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildChunkYaml
// ---------------------------------------------------------------------------

describe("buildChunkYaml", () => {
  const scenario: ParsedScenario = {
    name: "turn_taking_en",
    description: "all cases",
    params: {
      output_dir: "temp/output",
      lab: {
        suite: "turn_taking_en",
        cases: {
          RSP_BASIC: { analysis: { preset: "config/analysis_presets/default.yaml", report: { template: "medialab.html.jinja2" } } },
          INT_FALSE: { analysis: { preset: "config/analysis_presets/lab_int_false.yaml", report: { template: "medialab.html.jinja2" } } },
        },
      },
    },
    steps: [],
  };
  const prefix: ScenarioStep[] = [
    { type: "platform.setup", platform_id: "livekit", params: {} },
    { type: "audio.start_recording" },
    { type: "platform.enter", params: { tone_name: "" } },
    { type: "audio.wait_for_speech", timeout_ms: 30000, silence_duration_ms: 3000 },
  ];
  const suffix: ScenarioStep[] = [{ type: "audio.stop_recording" }, { type: "platform.exit" }];

  it("produces valid YAML with name, case_id, chunk_id, sample_ids from the data", () => {
    const samples: SampleGroup[] = [
      { steps: [{ type: "lab.trace" }, { type: "audio.play" }], sampleId: "RSP_BASIC-001", caseId: "RSP_BASIC", chunkId: "chunk_001" },
    ];
    const parsed = yaml.load(buildChunkYaml(scenario, prefix, samples, suffix, "RSP_BASIC", "chunk_001")) as Record<string, unknown>;
    expect(parsed.name).toBe("turn_taking_en_RSP_BASIC_chunk_001");
    const lab = (parsed.params as Record<string, unknown>).lab as Record<string, unknown>;
    expect(lab.suite).toBe("turn_taking_en");
    expect(lab.case_id).toBe("RSP_BASIC");
    expect(lab.chunk_id).toBe("chunk_001");
    expect(lab.sample_ids).toEqual(["RSP_BASIC-001"]);
  });

  it("stamps the per-case analysis preset onto each file", () => {
    const rsp = buildChunkYaml(scenario, prefix, [{ steps: [{ type: "lab.trace" }], caseId: "RSP_BASIC", chunkId: "chunk_001" }], suffix, "RSP_BASIC", "chunk_001");
    const intF = buildChunkYaml(scenario, prefix, [{ steps: [{ type: "lab.trace" }], caseId: "INT_FALSE", chunkId: "chunk_001" }], suffix, "INT_FALSE", "chunk_001");
    const rspAnalysis = (yaml.load(rsp) as Record<string, unknown>).analysis as Record<string, unknown>;
    const intAnalysis = (yaml.load(intF) as Record<string, unknown>).analysis as Record<string, unknown>;
    expect(rspAnalysis.preset).toBe("config/analysis_presets/default.yaml");
    expect(intAnalysis.preset).toBe("config/analysis_presets/lab_int_false.yaml");
  });

  it("strips the cases map from the emitted params.lab", () => {
    const out = buildChunkYaml(scenario, prefix, [{ steps: [{ type: "lab.trace" }], caseId: "RSP_BASIC", chunkId: "chunk_001" }], suffix, "RSP_BASIC", "chunk_001");
    const lab = ((yaml.load(out) as Record<string, unknown>).params as Record<string, unknown>).lab as Record<string, unknown>;
    expect(lab.cases).toBeUndefined();
  });

  it("orders steps: prefix + samples + suffix", () => {
    const samples: SampleGroup[] = [
      { steps: [{ type: "lab.trace" }, { type: "audio.play" }, { type: "audio.wait_for_speech" }], caseId: "RSP", chunkId: "chunk_001" },
      { steps: [{ type: "lab.trace" }, { type: "audio.play" }, { type: "audio.wait_for_speech" }], caseId: "RSP", chunkId: "chunk_001" },
    ];
    const steps = (yaml.load(buildChunkYaml(scenario, prefix, samples, suffix, "RSP", "chunk_001")) as Record<string, unknown>).steps as ScenarioStep[];
    expect(steps).toHaveLength(12); // 4 + 6 + 2
    expect(steps[0].type).toBe("platform.setup");
    expect(steps[4].type).toBe("lab.trace");
    expect(steps[10].type).toBe("audio.stop_recording");
    expect(steps[11].type).toBe("platform.exit");
  });

  it("preserves INT_BASIC sample fields through YAML roundtrip", () => {
    const samples: SampleGroup[] = [{
      steps: [
        { type: "lab.trace", event: "case_sample_start", case_id: "INT_BASIC", chunk_id: "chunk_001", sample_id: "INT_BASIC-001", question_id: "en_question4", material_id: "en_Short05Wordswav4" },
        { type: "audio.play", file: "corpus/turn_taking/en/audio/en_question4.wav" },
        { type: "audio.wait_for_speech_start", timeout_ms: 15000, wait_after_start_ms: 2000 },
        { type: "audio.play", file: "corpus/turn_taking/en/audio/en_Short05Wordswav4.wav" },
        { type: "audio.wait_for_speech", end_timeout_ms: 40000, silence_duration_ms: 3000 },
      ],
      sampleId: "INT_BASIC-001",
      caseId: "INT_BASIC",
      chunkId: "chunk_001",
    }];
    const steps = (yaml.load(buildChunkYaml(scenario, prefix, samples, suffix, "INT_BASIC", "chunk_001")) as Record<string, unknown>).steps as ScenarioStep[];
    const trace = steps[4];
    expect(trace.question_id).toBe("en_question4");
    expect(trace.material_id).toBe("en_Short05Wordswav4");
    const waitStart = steps[6];
    expect(waitStart.type).toBe("audio.wait_for_speech_start");
    expect(waitStart.wait_after_start_ms).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// mergeChunkMetrics
// ---------------------------------------------------------------------------

function respChunk(latencies: number[]) {
  return { response_metrics: { latency: { turn_level: latencies.map((ms, i) => ({ turn_index: i + 1, latency_ms: ms })) } } };
}
function intChunk(latencies: number[]) {
  return { interruption_metrics: { latency: { turn_level: latencies.map((ms, i) => ({ turn_index: i + 1, reaction_time_ms: ms })) } } };
}
function rTurns(m: Record<string, unknown>) {
  return ((m.response_metrics as Record<string, unknown>).latency as { turn_level: Record<string, unknown>[] }).turn_level;
}
function iTurns(m: Record<string, unknown>) {
  return ((m.interruption_metrics as Record<string, unknown>).latency as { turn_level: Record<string, unknown>[] }).turn_level;
}
/** Wrap raw metrics into a ChunkMetricsEntry with overridable meta. */
function entry(metrics: Record<string, unknown>, over: Partial<ChunkMetricsEntry> = {}): ChunkMetricsEntry {
  return { caseId: "RSP", chunkId: "chunk_001", sampleCount: 5, hasInterruptPhase: false, metrics, ...over };
}

describe("mergeChunkMetrics", () => {
  it("concatenates and re-indexes response turns", () => {
    const merged = mergeChunkMetrics([entry(respChunk([500, 600])), entry(respChunk([700, 800]), { chunkId: "chunk_002" })]);
    const turns = rTurns(merged);
    expect(turns).toHaveLength(4);
    expect(turns[0].turn_index).toBe(1);
    expect(turns[3].turn_index).toBe(4);
    expect(turns[0].latency_ms).toBe(500);
    expect(turns[3].latency_ms).toBe(800);
  });

  it("annotates every merged turn with its case_id", () => {
    const merged = mergeChunkMetrics([
      entry(respChunk([500]), { caseId: "RSP_BASIC" }),
      entry({ ...respChunk([600]), ...intChunk([200]) }, { caseId: "INT_BASIC", hasInterruptPhase: true }),
    ]);
    expect(rTurns(merged).map(t => t.case_id)).toEqual(["RSP_BASIC", "INT_BASIC"]);
    expect(iTurns(merged)[0].case_id).toBe("INT_BASIC");
  });

  it("concatenates interrupt turns", () => {
    const merged = mergeChunkMetrics([entry(intChunk([300])), entry(intChunk([400]), { chunkId: "chunk_002" })]);
    const turns = iTurns(merged);
    expect(turns).toHaveLength(2);
    expect(turns[0].reaction_time_ms).toBe(300);
    expect(turns[1].reaction_time_ms).toBe(400);
  });

  it("handles chunks with no metrics", () => {
    const merged = mergeChunkMetrics([entry({}), entry({}, { chunkId: "chunk_002" })]);
    expect(rTurns(merged)).toHaveLength(0);
    expect(iTurns(merged)).toHaveLength(0);
    expect(merged._merged_from_chunks).toBe(2);
  });

  it("handles single chunk", () => {
    const merged = mergeChunkMetrics([entry(respChunk([500]))]);
    expect(rTurns(merged)).toHaveLength(1);
    expect(merged._merged_from_chunks).toBe(1);
  });

  it("handles mixed response + interrupt across chunks", () => {
    const c1 = { ...respChunk([500]), ...intChunk([200]) };
    const c2 = respChunk([600]);
    const merged = mergeChunkMetrics([entry(c1), entry(c2, { chunkId: "chunk_002" })]);
    expect(rTurns(merged)).toHaveLength(2);
    expect(iTurns(merged)).toHaveLength(1);
  });

  it("preserves per-family summary when a family has no turn-level data", () => {
    const c1 = { response_metrics: { latency: { turn_level: [{ latency_ms: 500 }] } } };
    const c2 = { interruption_metrics: { latency: { summary: { p50_reaction_time_ms: 300, p95_reaction_time_ms: 450 } } } };
    const merged = mergeChunkMetrics([entry(c1), entry(c2, { chunkId: "chunk_002" })]);
    expect(rTurns(merged)).toHaveLength(1);
    expect(iTurns(merged)).toHaveLength(0);
    const iSummary = ((merged.interruption_metrics as Record<string, unknown>).latency as Record<string, unknown>).summary as Record<string, unknown>;
    expect(iSummary.p50_reaction_time_ms).toBe(300);
  });

  it("preserves aggregated_summary and scalar metrics", () => {
    const c1 = { response_metrics: { latency: { turn_level: [{ latency_ms: 500 }] } }, aggregated_summary: { avg_response_latency_ms: 510 }, network_resilience: 88, naturalness: 4.1, noise_reduction: 92 };
    const merged = mergeChunkMetrics([entry(c1)]);
    expect((merged.aggregated_summary as Record<string, unknown>).avg_response_latency_ms).toBe(510);
    expect(merged.network_resilience).toBe(88);
    expect(merged.naturalness).toBe(4.1);
    expect(merged.noise_reduction).toBe(92);
  });
});

// ---------------------------------------------------------------------------
// computePerCaseAndRates + case classification
// ---------------------------------------------------------------------------

describe("isFalseInterruptCase", () => {
  it("matches FALSE as a segment", () => {
    expect(isFalseInterruptCase("INT_FALSE")).toBe(true);
    expect(isFalseInterruptCase("FALSE")).toBe(true);
    expect(isFalseInterruptCase("FALSE_START")).toBe(true);
    expect(isFalseInterruptCase("int_false")).toBe(true);
  });
  it("does not match other cases", () => {
    expect(isFalseInterruptCase("RSP_BASIC")).toBe(false);
    expect(isFalseInterruptCase("INT_BASIC")).toBe(false);
    expect(isFalseInterruptCase("FALSEY")).toBe(false);
  });
});

describe("groupHasInterruptPhase", () => {
  it("true when a sample waits for speech start", () => {
    expect(groupHasInterruptPhase({ caseId: "INT", chunkId: "chunk_001", samples: [
      { steps: [{ type: "lab.trace" }, { type: "audio.play" }, { type: "audio.wait_for_speech_start" }] },
    ] })).toBe(true);
  });
  it("false for response-only samples", () => {
    expect(groupHasInterruptPhase({ caseId: "RSP", chunkId: "chunk_001", samples: [
      { steps: [{ type: "lab.trace" }, { type: "audio.play" }, { type: "audio.wait_for_speech" }] },
    ] })).toBe(false);
  });
});

describe("computePerCaseAndRates", () => {
  // Realistic turn_taking shape: 3 cases × 2 chunks × 5 samples.
  const entries: ChunkMetricsEntry[] = [
    entry({ ...respChunk([500, 520, 540, 560, 580]) }, { caseId: "RSP_BASIC", chunkId: "chunk_001" }),
    entry({ ...respChunk([510, 530, 550]) }, { caseId: "RSP_BASIC", chunkId: "chunk_002" }), // 2 samples got no response
    entry({ ...respChunk([600, 610, 620, 630, 640]), ...intChunk([200, 210, 220, 230]) }, { caseId: "INT_BASIC", chunkId: "chunk_001", hasInterruptPhase: true }),
    entry({ ...respChunk([650, 660, 670, 680, 690]), ...intChunk([240, 250, 260, 270, 280]) }, { caseId: "INT_BASIC", chunkId: "chunk_002", hasInterruptPhase: true }),
    entry({ ...respChunk([700, 710, 720, 730, 740]), ...intChunk([300]) }, { caseId: "INT_FALSE", chunkId: "chunk_001", hasInterruptPhase: true }),
    entry({ ...respChunk([750, 760, 770, 780, 790]), ...intChunk([310]) }, { caseId: "INT_FALSE", chunkId: "chunk_002", hasInterruptPhase: true }),
  ];

  it("computes true cross-chunk rates with daemon sample counts as denominators", () => {
    const { rates } = computePerCaseAndRates(entries);
    // responses: 8 + 10 + 10 = 28 of 30 samples
    expect(rates.response_rate).toBeCloseTo(28 / 30);
    // true interrupts: 9 reactions over INT_BASIC's 10 samples
    expect(rates.interrupt_rate).toBeCloseTo(9 / 10);
    // false interrupts: 2 reactions over INT_FALSE's 10 samples (lower = better)
    expect(rates.false_interrupt_rate).toBeCloseTo(2 / 10);
  });

  it("emits per-case stats keyed by case_id", () => {
    const { perCase } = computePerCaseAndRates(entries);
    expect(Object.keys(perCase).sort()).toEqual(["INT_BASIC", "INT_FALSE", "RSP_BASIC"]);
    const rsp = perCase.RSP_BASIC as Record<string, any>;
    expect(rsp.sample_count).toBe(10);
    expect(rsp.chunk_count).toBe(2);
    expect(rsp.false_interrupt_case).toBe(false);
    expect(rsp.response.turn_count).toBe(8);
    expect(rsp.response.median_ms).toBe(535); // median of 8 values 500..580
    const intF = perCase.INT_FALSE as Record<string, any>;
    expect(intF.false_interrupt_case).toBe(true);
    expect(intF.interruption.turn_count).toBe(2);
  });

  it("returns null rates when no case of that kind ran", () => {
    const { rates } = computePerCaseAndRates([
      entry(respChunk([500, 600]), { caseId: "RSP_BASIC", sampleCount: 2 }),
    ]);
    expect(rates.response_rate).toBeCloseTo(1);
    expect(rates.interrupt_rate).toBeNull();
    expect(rates.false_interrupt_rate).toBeNull();
  });

  it("returns all-null rates for empty input and clamps rates at 1", () => {
    expect(computePerCaseAndRates([]).rates.response_rate).toBeNull();
    const { rates } = computePerCaseAndRates([
      entry(respChunk([500, 510, 520]), { sampleCount: 2 }), // more turns than samples (greeting picked up)
    ]);
    expect(rates.response_rate).toBe(1);
  });

  it("ignores negative (overlapping-speech) latencies in counts", () => {
    const { rates, perCase } = computePerCaseAndRates([
      entry(respChunk([500, -100, 600]), { sampleCount: 5 }),
    ]);
    expect((perCase.RSP as Record<string, any>).response.turn_count).toBe(2);
    expect(rates.response_rate).toBeCloseTo(2 / 5);
  });

  it("reads v0.2.1 interruption turns (interrupt_action_ms, no reaction_time_ms)", () => {
    // Real v0.2.1 lab turn shape from a live run (job 20471, INT_BASIC chunk_001)
    const metrics = {
      response_metrics: { latency: { turn_level: [1364, 1428, 1348, 1428, 1460, 1380, 1524, 1556, 1636]
        .map((ms, i) => ({ turn_index: i + 1, latency_ms: ms, is_greeting: false })) } },
      interruption_metrics: { latency: { turn_level: [1084, 1100, 1100, 1084, 1068]
        .map((ms, i) => ({ turn_index: i * 2 + 1, interruption_kind: 'user_interrupt_agent', action_applicable: true, interrupt_action_ms: ms, reaction_time_ms_diagnostic: ms })) } },
    };
    const { rates, perCase } = computePerCaseAndRates([
      entry(metrics, { caseId: "INT_BASIC", sampleCount: 5, hasInterruptPhase: true }),
    ]);
    const c = perCase.INT_BASIC as Record<string, any>;
    expect(c.interruption.turn_count).toBe(5);
    expect(c.interruption.median_ms).toBe(1084);
    expect(rates.interrupt_rate).toBe(1);            // 5 reactions / 5 samples
    // 9 response turns for 5 samples (interrupted + post-material answers) —
    // capped per case, not warned: every sample was answered.
    expect(rates.response_rate).toBe(1);
    expect(c.response.turn_count).toBe(9);           // raw count stays truthful
  });

  it("threshold: stops slower than INTERRUPT_ACTION_MAX_MS are not reactions (real chunk_002 data)", () => {
    // Real job-20471 INT_FALSE chunk_002: turns 3 and 5 "stopped" 11.5s/9.3s
    // after the sound — the agent finishing its answer, not reacting.
    const metrics = {
      interruption_metrics: { latency: { turn_level: [1164, 11564, 9268, 1344, 1100]
        .map((ms, i) => ({ turn_index: i * 2 + 1, action_applicable: true, interrupt_action_ms: ms })) } },
    };
    const { rates, perCase } = computePerCaseAndRates([
      entry(metrics, { caseId: "INT_FALSE", sampleCount: 5, hasInterruptPhase: true }),
    ]);
    const c = perCase.INT_FALSE as Record<string, any>;
    expect(c.interruption.turn_count).toBe(3);       // 11564 & 9268 excluded
    expect(c.interruption.median_ms).toBe(1164);     // median of 1100, 1164, 1344
    expect(rates.false_interrupt_rate).toBeCloseTo(3 / 5);
  });

  it("interrupt_action_ms outranks the diagnostic: a slow stop is not a reaction", () => {
    // Real job-20471 chunk_002 turn 3: full stop at 11564ms but the diagnostic
    // estimator says 1916ms. The agent finished talking — not a false interrupt.
    const metrics = { interruption_metrics: { latency: { turn_level: [
      { turn_index: 3, action_applicable: true, interrupt_action_ms: 11564, reaction_time_ms_diagnostic: 1916 },
      { turn_index: 1, action_applicable: true, interrupt_action_ms: 1164, reaction_time_ms_diagnostic: 1164 },
    ] } } };
    const { rates, perCase } = computePerCaseAndRates([
      entry(metrics, { caseId: "INT_FALSE", sampleCount: 5, hasInterruptPhase: true }),
    ]);
    expect((perCase.INT_FALSE as Record<string, any>).interruption.turn_count).toBe(1);
    expect(rates.false_interrupt_rate).toBeCloseTo(1 / 5);
  });

  it("real job-20471 INT_FALSE data: agent stopping for coughs → false rate 1.0", () => {
    const metrics = {
      response_metrics: { latency: { turn_level: [1364, 1412, 1428, 1444, 1412]
        .map((ms, i) => ({ turn_index: i + 1, latency_ms: ms, response_kind: 'interrupted_response' })) } },
      interruption_metrics: { latency: { turn_level: [1084, 1068, 1404, 1308, 2156]
        .map((ms, i) => ({ turn_index: i * 2 + 1, action_applicable: true, interrupt_action_ms: ms })) } },
    };
    const { rates, perCase } = computePerCaseAndRates([
      entry(metrics, { caseId: "INT_FALSE", sampleCount: 5, hasInterruptPhase: true }),
    ]);
    expect(rates.false_interrupt_rate).toBe(1);      // reacted to every non-semantic sound
    expect((perCase.INT_FALSE as Record<string, any>).interruption.median_ms).toBe(1308);
  });

  it("excludes is_greeting turns from response counts (real aeval turn shape)", () => {
    // Field shape confirmed against a real metrics.json: turns carry
    // turn_index, user_end_time, agent_start_time, latency_ms, is_barge_in, is_greeting.
    const metrics = { response_metrics: { latency: { turn_level: [
      { turn_index: 1, latency_ms: 2500, is_barge_in: false, is_greeting: true },
      { turn_index: 2, latency_ms: 900, is_barge_in: false, is_greeting: false },
      { turn_index: 3, latency_ms: 1100, is_barge_in: true, is_greeting: false },
    ] } } };
    const { rates, perCase } = computePerCaseAndRates([entry(metrics, { sampleCount: 2 })]);
    const rsp = (perCase.RSP as Record<string, any>).response;
    expect(rsp.turn_count).toBe(2);          // greeting excluded; barge-in counts
    expect(rsp.median_ms).toBe(1000);        // median of 900, 1100 — not skewed by greeting
    expect(rates.response_rate).toBe(1);     // 2 answers / 2 samples
  });

  it("merged output carries rates + per_case", () => {
    const merged = mergeChunkMetrics(entries);
    expect((merged.rates as Record<string, number>).response_rate).toBeCloseTo(28 / 30);
    expect(Object.keys(merged.per_case as Record<string, unknown>)).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: realistic 30-sample, 3-case turn_taking body → 6 files
// ---------------------------------------------------------------------------

describe("end-to-end: full chunking pipeline", () => {
  function buildRealistic(): { scenario: ParsedScenario; stepsPrefix: ScenarioStep[]; stepsSuffix: ScenarioStep[] } {
    const stepsPrefix: ScenarioStep[] = [
      { type: "platform.setup", platform_id: "livekit", params: {} },
      { type: "audio.start_recording" },
      { type: "platform.enter", params: { tone_name: "" } },
      { type: "audio.wait_for_speech", timeout_ms: 30000, silence_duration_ms: 3000, description: "Wait for agent greeting" },
    ];
    const stepsSuffix: ScenarioStep[] = [{ type: "audio.stop_recording" }, { type: "platform.exit" }];
    const sampleSteps: ScenarioStep[] = [];
    const chunkOf = (i: number) => (i <= 5 ? "chunk_001" : "chunk_002");

    for (let i = 1; i <= 10; i++) {
      sampleSteps.push(
        { type: "lab.trace", event: "case_sample_start", suite: "turn_taking_en", case_id: "RSP_BASIC", chunk_id: chunkOf(i), sample_id: `RSP_BASIC-${pad(i)}`, sample_index: i, question_id: `en_question_short${i}` },
        { type: "audio.play", file: `corpus/turn_taking/en/audio/en_question_short${i}.wav` },
        { type: "audio.wait_for_speech", end_timeout_ms: 45000, silence_duration_ms: 3000 },
      );
    }
    for (let i = 1; i <= 10; i++) {
      sampleSteps.push(
        { type: "lab.trace", event: "case_sample_start", suite: "turn_taking_en", case_id: "INT_BASIC", chunk_id: chunkOf(i), sample_id: `INT_BASIC-${pad(i)}`, sample_index: i, question_id: `en_question${i}`, material_id: `en_Short05Wordswav${i}` },
        { type: "audio.play", file: `corpus/turn_taking/en/audio/en_question${i}.wav` },
        { type: "audio.wait_for_speech_start", timeout_ms: 15000, wait_after_start_ms: 2000 },
        { type: "audio.play", file: `corpus/turn_taking/en/audio/en_Short05Wordswav${i}.wav` },
        { type: "audio.wait_for_speech", end_timeout_ms: 40000, silence_duration_ms: 3000 },
      );
    }
    for (let i = 1; i <= 10; i++) {
      sampleSteps.push(
        { type: "lab.trace", event: "case_sample_start", suite: "turn_taking_en", case_id: "INT_FALSE", chunk_id: chunkOf(i), sample_id: `INT_FALSE-${pad(i)}`, sample_index: i, question_id: `en_question${i}`, material_id: `sound_NonsemanticCoughLaughterwav${i}` },
        { type: "audio.play", file: `corpus/turn_taking/en/audio/en_question${i}.wav` },
        { type: "audio.wait_for_speech_start", timeout_ms: 15000, wait_after_start_ms: 1000 },
        { type: "audio.play", file: `corpus/turn_taking/en/audio/NonsemanticCoughLaughterwav${i}.wav` },
        { type: "audio.wait_for_speech", end_timeout_ms: 40000, silence_duration_ms: 3000 },
      );
    }

    const scenario: ParsedScenario = {
      name: "turn_taking_en",
      description: "turn_taking_en - RSP_BASIC + INT_BASIC + INT_FALSE",
      params: {
        output_dir: "temp/output",
        lab: {
          suite: "turn_taking_en",
          cases: {
            RSP_BASIC: { analysis: { preset: "config/analysis_presets/default.yaml", report: { template: "medialab.html.jinja2" } } },
            INT_BASIC: { analysis: { preset: "config/analysis_presets/default.yaml", report: { template: "medialab.html.jinja2" } } },
            INT_FALSE: { analysis: { preset: "config/analysis_presets/lab_int_false.yaml", report: { template: "medialab.html.jinja2" } } },
          },
        },
      },
      steps: sampleSteps,
    };
    return { scenario, stepsPrefix, stepsSuffix };
  }

  it("extracts 30 samples, no inline prefix/suffix, each tagged case_id + chunk_id", () => {
    const { scenario } = buildRealistic();
    const { prefixSteps, suffixSteps, samples } = extractSampleGroups(scenario.steps);
    expect(prefixSteps).toHaveLength(0);
    expect(suffixSteps).toHaveLength(0);
    expect(samples).toHaveLength(30);
    expect(samples.every(s => s.caseId && s.chunkId)).toBe(true);
  });

  it("groups into 6 files (3 cases × 2 chunks), 5 samples each", () => {
    const { scenario } = buildRealistic();
    const { samples } = extractSampleGroups(scenario.steps);
    const groups = groupSamplesByChunk(samples);
    expect(groups).toHaveLength(6);
    expect(groups.every(g => g.samples.length === 5)).toBe(true);
  });

  it("practical: a realistic imperfect run produces correct DB-bound numbers", () => {
    // Drive the REAL pipeline: body → groups → per-chunk metrics → merge,
    // with the imperfections a live run has: one RSP sample overlapped
    // (negative latency), one timed out, one INT_BASIC sample got neither
    // reaction nor response, and INT_FALSE drew one false interrupt.
    const { scenario } = buildRealistic();
    const { samples } = extractSampleGroups(scenario.steps);
    const groups = groupSamplesByChunk(samples);

    // RSP chunk_001 also picked up the agent greeting as a flagged turn —
    // it must not count as an answered sample.
    const rspChunk1 = respChunk([980, 1020, 1150, 875, -50]);
    (rspChunk1.response_metrics.latency.turn_level as Record<string, unknown>[]).unshift(
      { turn_index: 0, latency_ms: 3200, is_greeting: true },
    );
    const perChunk: Record<string, Record<string, unknown>> = {
      "RSP_BASIC/chunk_001": rspChunk1,                                          // 4 valid of 5 + greeting
      "RSP_BASIC/chunk_002": respChunk([1100, 990, 1045, 1310]),                // 1 timed out
      "INT_BASIC/chunk_001": { ...respChunk([1500, 1600, 1480, 1550, 1700]), ...intChunk([620, 580, 710, 640, 690]) },
      "INT_BASIC/chunk_002": { ...respChunk([1450, 1520, 1610, 1390]), ...intChunk([600, 560, 720, 655]) }, // 1 sample dead
      "INT_FALSE/chunk_001": { ...respChunk([1300, 1340, 1280, 1410, 1360]), ...intChunk([450]) },          // 1 false interrupt
      "INT_FALSE/chunk_002": respChunk([1290, 1330, 1405, 1255, 1375]),         // clean: no reactions
    };

    const chunkEntries: ChunkMetricsEntry[] = groups.map(g => ({
      caseId: g.caseId,
      chunkId: g.chunkId,
      sampleCount: g.samples.length,
      hasInterruptPhase: groupHasInterruptPhase(g),
      metrics: perChunk[`${g.caseId}/${g.chunkId}`],
    }));
    // hasInterruptPhase derives from the real body steps, not hand-tagged
    expect(chunkEntries.filter(e => e.hasInterruptPhase)).toHaveLength(4);

    const merged = mergeChunkMetrics(chunkEntries);

    // Rates — denominators from sample counts, numerators from valid turns
    const rates = merged.rates as Record<string, number>;
    expect(rates.response_rate).toBeCloseTo(27 / 30);       // 8 + 9 + 10
    expect(rates.interrupt_rate).toBeCloseTo(9 / 10);       // INT_BASIC reactions
    expect(rates.false_interrupt_rate).toBeCloseTo(1 / 10); // INT_FALSE reactions

    // Merged latencies — what the daemon's parser recomputes for the columns.
    // Negative overlap turn is carried in turn_level but excluded from stats.
    const respVals = rTurns(merged)
      .filter(t => t.is_greeting !== true)
      .map(t => t.latency_ms as number).filter(v => v >= 0);
    const intVals = iTurns(merged).map(t => t.reaction_time_ms as number).filter(v => v >= 0);
    expect(rTurns(merged)).toHaveLength(29); // 27 valid + 1 negative + 1 greeting
    expect(respVals).toHaveLength(27);
    expect(Math.round(median(respVals))).toBe(1340); // middle of the 27 valid values
    expect(Math.round(median(intVals))).toBe(630);          // 10 reactions: 9 true + 1 false
    expect(Math.round(p95(intVals))).toBe(720);

    // Per-case separability — INT_FALSE distinguishable without artifacts
    const perCase = merged.per_case as Record<string, any>;
    expect(perCase.RSP_BASIC.response.turn_count).toBe(8);
    expect(perCase.RSP_BASIC.response.median_ms).toBe(Math.round(median([980, 1020, 1150, 875, 1100, 990, 1045, 1310])));
    expect(perCase.INT_BASIC.interruption.turn_count).toBe(9);
    expect(perCase.INT_BASIC.interruption.median_ms).toBe(640);
    expect(perCase.INT_FALSE.false_interrupt_case).toBe(true);
    expect(perCase.INT_FALSE.interruption.turn_count).toBe(1);
    expect(perCase.INT_FALSE.interruption.median_ms).toBe(450);

    // Every merged turn attributable to its case
    expect(rTurns(merged).filter(t => t.case_id === "RSP_BASIC")).toHaveLength(10); // 8 valid + negative + greeting
    expect(iTurns(merged).filter(t => t.case_id === "INT_FALSE")).toHaveLength(1);
  });

  it("produces 6 valid chunk YAMLs with aeval-convention names + correct presets", () => {
    const { scenario, stepsPrefix, stepsSuffix } = buildRealistic();
    const { samples } = extractSampleGroups(scenario.steps);
    const groups = groupSamplesByChunk(samples);
    const names: string[] = [];
    for (const g of groups) {
      const parsed = yaml.load(buildChunkYaml(scenario, stepsPrefix, g.samples, stepsSuffix, g.caseId, g.chunkId)) as Record<string, unknown>;
      expect(Array.isArray(parsed.steps)).toBe(true);
      const preset = ((parsed.analysis as Record<string, unknown>).preset) as string;
      // INT_FALSE files get the lab_int_false preset; others get default.
      expect(preset).toBe(g.caseId === "INT_FALSE" ? "config/analysis_presets/lab_int_false.yaml" : "config/analysis_presets/default.yaml");
      names.push(parsed.name as string);
    }
    expect(names).toHaveLength(6);
    expect(names).toContain("turn_taking_en_RSP_BASIC_chunk_001");
    expect(names).toContain("turn_taking_en_RSP_BASIC_chunk_002");
    expect(names).toContain("turn_taking_en_INT_BASIC_chunk_001");
    expect(names).toContain("turn_taking_en_INT_FALSE_chunk_002");
  });

  it("RSP file has 4 prefix + 15 sample + 2 suffix = 21 steps", () => {
    const { scenario, stepsPrefix, stepsSuffix } = buildRealistic();
    const { samples } = extractSampleGroups(scenario.steps);
    const g = groupSamplesByChunk(samples).find(x => x.caseId === "RSP_BASIC" && x.chunkId === "chunk_001")!;
    const steps = (yaml.load(buildChunkYaml(scenario, stepsPrefix, g.samples, stepsSuffix, g.caseId, g.chunkId)) as Record<string, unknown>).steps as ScenarioStep[];
    expect(steps).toHaveLength(21);
    expect(steps[19].type).toBe("audio.stop_recording");
    expect(steps[20].type).toBe("platform.exit");
  });

  it("INT file has 4 prefix + 25 sample + 2 suffix = 31 steps", () => {
    const { scenario, stepsPrefix, stepsSuffix } = buildRealistic();
    const { samples } = extractSampleGroups(scenario.steps);
    const g = groupSamplesByChunk(samples).find(x => x.caseId === "INT_BASIC" && x.chunkId === "chunk_001")!;
    const steps = (yaml.load(buildChunkYaml(scenario, stepsPrefix, g.samples, stepsSuffix, g.caseId, g.chunkId)) as Record<string, unknown>).steps as ScenarioStep[];
    expect(steps).toHaveLength(31);
  });

  it("partitions sample_ids by chunk_id from the data", () => {
    const { scenario, stepsPrefix, stepsSuffix } = buildRealistic();
    const { samples } = extractSampleGroups(scenario.steps);
    const groups = groupSamplesByChunk(samples);
    const g1 = groups.find(g => g.caseId === "RSP_BASIC" && g.chunkId === "chunk_001")!;
    const g2 = groups.find(g => g.caseId === "RSP_BASIC" && g.chunkId === "chunk_002")!;
    const ids1 = ((yaml.load(buildChunkYaml(scenario, stepsPrefix, g1.samples, stepsSuffix, g1.caseId, g1.chunkId)) as Record<string, unknown>).params as Record<string, unknown>).lab as Record<string, unknown>;
    const ids2 = ((yaml.load(buildChunkYaml(scenario, stepsPrefix, g2.samples, stepsSuffix, g2.caseId, g2.chunkId)) as Record<string, unknown>).params as Record<string, unknown>).lab as Record<string, unknown>;
    expect(ids1.sample_ids).toEqual(["RSP_BASIC-001", "RSP_BASIC-002", "RSP_BASIC-003", "RSP_BASIC-004", "RSP_BASIC-005"]);
    expect(ids2.sample_ids).toEqual(["RSP_BASIC-006", "RSP_BASIC-007", "RSP_BASIC-008", "RSP_BASIC-009", "RSP_BASIC-010"]);
  });

  it("merged metrics from 6 chunks compute sane MED/SD/P95", () => {
    const chunkEntries: ChunkMetricsEntry[] = [];
    let n = 0;
    for (const lat of [[400, 450, 500, 550, 600], [420, 470, 520, 570, 620]]) {
      chunkEntries.push(entry({ response_metrics: { latency: { turn_level: lat.map((ms, i) => ({ turn_index: i + 1, latency_ms: ms })) } } },
        { caseId: "RSP_BASIC", chunkId: `chunk_${++n}` }));
    }
    for (const lat of [[200, 250, 300, 350, 400], [220, 270, 320, 370, 420]]) {
      chunkEntries.push(entry({ interruption_metrics: { latency: { turn_level: lat.map((ms, i) => ({ turn_index: i + 1, reaction_time_ms: ms })) } } },
        { caseId: "INT_BASIC", chunkId: `chunk_${++n}`, hasInterruptPhase: true }));
    }
    for (const vals of [[500, 550], [480, 530]]) {
      chunkEntries.push(entry({
        response_metrics: { latency: { turn_level: vals.map((ms, i) => ({ turn_index: i + 1, latency_ms: ms })) } },
        interruption_metrics: { latency: { turn_level: vals.map((ms, i) => ({ turn_index: i + 1, reaction_time_ms: ms - 200 })) } },
      }, { caseId: "INT_FALSE", chunkId: `chunk_${++n}`, hasInterruptPhase: true }));
    }

    const merged = mergeChunkMetrics(chunkEntries);
    const rt = ((merged.response_metrics as Record<string, unknown>).latency as { turn_level: Record<string, unknown>[] }).turn_level;
    const it = ((merged.interruption_metrics as Record<string, unknown>).latency as { turn_level: Record<string, unknown>[] }).turn_level;
    expect(rt).toHaveLength(14);
    expect(it).toHaveLength(14);

    const rVals = rt.map(t => t.latency_ms as number);
    expect(Math.round(median(rVals))).toBeGreaterThan(0);
    expect(Math.round(sd(rVals))).toBeGreaterThan(0);
    expect(Math.round(p95(rVals))).toBeGreaterThanOrEqual(Math.round(median(rVals)));
    expect(merged._merged_from_chunks).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// composeScenarioYaml
// ---------------------------------------------------------------------------

describe("composeScenarioYaml", () => {
  it("wraps the body with prefix/suffix and preserves metadata", () => {
    const scenario: ParsedScenario = {
      name: "turn_taking_en",
      description: "desc",
      analysis: { preset: "medialab" },
      params: { lab: { suite: "turn_taking_en", case_id: "INT_BASIC" } },
      steps: [{ type: "lab.trace", sample_id: "INT_BASIC-001" }],
    };
    const prefix: ScenarioStep[] = [{ type: "platform.setup", platform_id: "agora" }];
    const suffix: ScenarioStep[] = [{ type: "platform.exit" }];

    const out = composeScenarioYaml(scenario, prefix, scenario.steps, suffix);
    const parsed = yaml.load(out) as ParsedScenario;

    expect(parsed.name).toBe("turn_taking_en");
    expect(parsed.description).toBe("desc");
    expect(parsed.analysis).toEqual({ preset: "medialab" });
    expect(parsed.params).toEqual({ lab: { suite: "turn_taking_en", case_id: "INT_BASIC" } });
    expect(parsed.steps).toHaveLength(3);
    expect(parsed.steps[0]).toEqual({ type: "platform.setup", platform_id: "agora" });
    expect(parsed.steps[1]).toEqual({ type: "lab.trace", sample_id: "INT_BASIC-001" });
    expect(parsed.steps[2]).toEqual({ type: "platform.exit" });
  });

  it("falls back to a default name when scenario has none", () => {
    const scenario = { steps: [] } as unknown as ParsedScenario;
    const out = composeScenarioYaml(scenario, [], [], []);
    const parsed = yaml.load(out) as ParsedScenario;
    expect(parsed.name).toBe("scenario");
  });
});

// ---------------------------------------------------------------------------
// chunk-vs-compose decision
// ---------------------------------------------------------------------------

describe("chunk-vs-compose decision", () => {
  // Mirrors the daemon's `canChunk` predicate in vox_eval_agentd/vox-agentd.ts
  // (executeAevalWithChunking, ~line 530) — keep in sync; it is a private method
  // and cannot be imported:
  //   samples.length > 0 && prefixSteps.length === 0 && suffixSteps.length === 0
  const canChunk = (steps: ScenarioStep[]) => {
    const { prefixSteps, suffixSteps, samples } = extractSampleGroups(steps);
    return samples.length > 0 && prefixSteps.length === 0 && suffixSteps.length === 0;
  };

  it("clean lab.trace body is chunkable", () => {
    const steps: ScenarioStep[] = [
      { type: "lab.trace", sample_id: "A-001", case_id: "INT_BASIC", chunk_id: "chunk_001" },
      { type: "audio.play", corpus_id: "q1" },
      { type: "lab.trace", sample_id: "A-002", case_id: "INT_BASIC", chunk_id: "chunk_001" },
      { type: "audio.play", corpus_id: "q2" },
    ];
    expect(canChunk(steps)).toBe(true);
  });

  it("control.for_each body is NOT chunkable (compose one file)", () => {
    const steps: ScenarioStep[] = [
      { type: "control.for_each", corpus_set: "three_questions_en", steps: [] },
    ];
    expect(canChunk(steps)).toBe(false);
  });

  it("body with trailing teardown is NOT chunkable via the fast path", () => {
    const steps: ScenarioStep[] = [
      { type: "lab.trace", sample_id: "A-001", case_id: "INT_BASIC" },
      { type: "audio.play", corpus_id: "q1" },
      { type: "platform.exit" },
    ];
    // extractSampleGroups pulls platform.exit into suffixSteps -> canChunk false.
    expect(canChunk(steps)).toBe(false);
  });
});
