/**
 * Tests for eval set chunk splitting and metrics merging.
 *
 * These import the SAME pure functions the daemon uses (from
 * vox_eval_agentd/chunking.ts), so a regression in production code is caught
 * here instead of passing against a divergent re-implementation.
 */

import { describe, it, expect } from "vitest";
import yaml from "js-yaml";
import {
  CHUNK_SIZE,
  type ScenarioStep,
  type SampleGroup,
  type ParsedScenario,
  sanitizeForFilename,
  extractSampleGroups,
  groupByCaseId,
  buildChunkYaml,
  mergeChunkMetrics,
  composeScenarioYaml,
} from "../vox_eval_agentd/chunking";

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

  it("a sanitized case_id cannot escape a tmp prefix", () => {
    const prefix = `vox-${sanitizeForFilename("../../../etc/cron.d/evil")}-chunk-1`;
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

  it("captures caseId from top-level lab.trace fields", () => {
    const steps: ScenarioStep[] = [
      { type: "lab.trace", case_id: "RSP_BASIC", sample_id: "RSP_BASIC-001" },
      { type: "audio.play" },
      { type: "lab.trace", case_id: "INT_BASIC", sample_id: "INT_BASIC-001" },
      { type: "audio.play" },
    ];
    const { samples } = extractSampleGroups(steps);
    expect(samples[0].caseId).toBe("RSP_BASIC");
    expect(samples[1].caseId).toBe("INT_BASIC");
  });

  it("captures caseId nested in params", () => {
    const { samples } = extractSampleGroups([
      { type: "lab.trace", params: { case_id: "RSP_BASIC", sample_id: "RSP-001" } },
      { type: "audio.play" },
    ]);
    expect(samples[0].caseId).toBe("RSP_BASIC");
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

  it("full backward-compat scenario: every chunk gets teardown", () => {
    const steps: ScenarioStep[] = [
      { type: "platform.setup", platform_id: "livekit" },
      { type: "audio.start_recording" },
      { type: "platform.enter" },
      { type: "audio.wait_for_speech" },
    ];
    for (let i = 1; i <= 6; i++) {
      steps.push(
        { type: "lab.trace", case_id: "RSP", sample_id: `RSP-${i}` },
        { type: "audio.play" },
        { type: "audio.wait_for_speech" },
      );
    }
    steps.push({ type: "audio.stop_recording" }, { type: "platform.exit" });

    const { prefixSteps, suffixSteps, samples } = extractSampleGroups(steps);
    expect(prefixSteps).toHaveLength(4);
    expect(suffixSteps.map(s => s.type)).toEqual(["audio.stop_recording", "platform.exit"]);
    expect(samples).toHaveLength(6);

    const scenario: ParsedScenario = { name: "s", steps: [] };
    const caseSamples = groupByCaseId(samples).get("RSP")!;
    const totalChunks = Math.ceil(caseSamples.length / CHUNK_SIZE);
    expect(totalChunks).toBe(2);

    for (let i = 0; i < totalChunks; i++) {
      const chunk = caseSamples.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      const y = buildChunkYaml(scenario, prefixSteps, chunk, suffixSteps, "RSP", i + 1, totalChunks);
      const parsedSteps = (yaml.load(y) as Record<string, unknown>).steps as ScenarioStep[];
      expect(parsedSteps[0].type).toBe("platform.setup");
      expect(parsedSteps[parsedSteps.length - 2].type).toBe("audio.stop_recording");
      expect(parsedSteps[parsedSteps.length - 1].type).toBe("platform.exit");
    }
  });
});

// ---------------------------------------------------------------------------
// groupByCaseId
// ---------------------------------------------------------------------------

describe("groupByCaseId", () => {
  function buildSteps(suites: Record<string, number>): ScenarioStep[] {
    const steps: ScenarioStep[] = [];
    for (const [caseId, count] of Object.entries(suites)) {
      for (let i = 1; i <= count; i++) {
        steps.push(
          { type: "lab.trace", case_id: caseId, sample_id: `${caseId}-${i}` },
          { type: "audio.play" },
          { type: "audio.wait_for_speech" },
        );
      }
    }
    return steps;
  }

  it("groups 3 suites × 10 → 3 groups of 10", () => {
    const { samples } = extractSampleGroups(buildSteps({ RSP_BASIC: 10, INT_BASIC: 10, INT_FALSE: 10 }));
    expect(samples).toHaveLength(30);
    const groups = groupByCaseId(samples);
    expect(groups.size).toBe(3);
    expect(groups.get("RSP_BASIC")!).toHaveLength(10);
    expect(groups.get("INT_BASIC")!).toHaveLength(10);
    expect(groups.get("INT_FALSE")!).toHaveLength(10);
  });

  it("produces 6 chunks from 3 suites × 10 (5 per chunk)", () => {
    const { samples } = extractSampleGroups(buildSteps({ RSP_BASIC: 10, INT_BASIC: 10, INT_FALSE: 10 }));
    const groups = groupByCaseId(samples);
    let total = 0;
    const breakdown: Record<string, number> = {};
    for (const [caseId, s] of groups) {
      const c = Math.ceil(s.length / CHUNK_SIZE);
      breakdown[caseId] = c;
      total += c;
    }
    expect(total).toBe(6);
    expect(breakdown).toEqual({ RSP_BASIC: 2, INT_BASIC: 2, INT_FALSE: 2 });
  });

  it("handles uneven suite sizes (7+3+8 → 2+1+2 = 5 chunks)", () => {
    const { samples } = extractSampleGroups(buildSteps({ RSP: 7, INT: 3, FALSE: 8 }));
    const groups = groupByCaseId(samples);
    let total = 0;
    for (const [, s] of groups) total += Math.ceil(s.length / CHUNK_SIZE);
    expect(total).toBe(5);
  });

  it("falls back to 'default' when caseId missing", () => {
    const { samples } = extractSampleGroups([
      { type: "lab.trace", sample_id: "X-1" },
      { type: "audio.play" },
    ]);
    expect(groupByCaseId(samples).has("default")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildChunkYaml
// ---------------------------------------------------------------------------

describe("buildChunkYaml", () => {
  const scenario: ParsedScenario = {
    name: "turn_taking_en",
    description: "all suites",
    analysis: { preset: "config/analysis_presets/default.yaml", report: { template: "medialab.html.jinja2" } },
    params: { lab: { suite: "turn_taking_en" } },
    steps: [],
  };
  const prefix: ScenarioStep[] = [
    { type: "platform.setup", platform_id: "livekit", params: {} },
    { type: "audio.start_recording" },
    { type: "platform.enter", params: { tone_name: "" } },
    { type: "audio.wait_for_speech", timeout_ms: 30000, silence_duration_ms: 3000 },
  ];
  const suffix: ScenarioStep[] = [{ type: "audio.stop_recording" }, { type: "platform.exit" }];

  it("produces valid YAML with correct name, chunk_id, case_id, sample_ids", () => {
    const samples: SampleGroup[] = [
      { steps: [{ type: "lab.trace" }, { type: "audio.play" }], sampleId: "RSP_BASIC-001", caseId: "RSP_BASIC" },
    ];
    const parsed = yaml.load(buildChunkYaml(scenario, prefix, samples, suffix, "RSP_BASIC", 1, 2)) as Record<string, unknown>;
    expect(parsed.name).toBe("turn_taking_en_RSP_BASIC_chunk_001");
    expect(parsed.analysis).toBeDefined();
    const lab = (parsed.params as Record<string, unknown>).lab as Record<string, unknown>;
    expect(lab.suite).toBe("turn_taking_en");
    expect(lab.case_id).toBe("RSP_BASIC");
    expect(lab.chunk_id).toBe("chunk_001");
    expect(lab.sample_ids).toEqual(["RSP_BASIC-001"]);
  });

  it("orders steps: prefix + samples + suffix", () => {
    const samples: SampleGroup[] = [
      { steps: [{ type: "lab.trace" }, { type: "audio.play" }, { type: "audio.wait_for_speech" }], caseId: "RSP" },
      { steps: [{ type: "lab.trace" }, { type: "audio.play" }, { type: "audio.wait_for_speech" }], caseId: "RSP" },
    ];
    const steps = (yaml.load(buildChunkYaml(scenario, prefix, samples, suffix, "RSP", 1, 1)) as Record<string, unknown>).steps as ScenarioStep[];
    expect(steps).toHaveLength(12); // 4 + 6 + 2
    expect(steps[0].type).toBe("platform.setup");
    expect(steps[4].type).toBe("lab.trace");
    expect(steps[10].type).toBe("audio.stop_recording");
    expect(steps[11].type).toBe("platform.exit");
  });

  it("preserves INT_BASIC sample fields through YAML roundtrip", () => {
    const samples: SampleGroup[] = [{
      steps: [
        { type: "lab.trace", event: "case_sample_start", case_id: "INT_BASIC", sample_id: "INT_BASIC-001", question_id: "en_question4", material_id: "en_Short05Wordswav4" },
        { type: "audio.play", file: "corpus/turn_taking/en/audio/en_question4.wav" },
        { type: "audio.wait_for_speech_start", timeout_ms: 15000, wait_after_start_ms: 2000 },
        { type: "audio.play", file: "corpus/turn_taking/en/audio/en_Short05Wordswav4.wav" },
        { type: "audio.wait_for_speech", end_timeout_ms: 40000, silence_duration_ms: 3000 },
      ],
      sampleId: "INT_BASIC-001",
      caseId: "INT_BASIC",
    }];
    const steps = (yaml.load(buildChunkYaml(scenario, prefix, samples, suffix, "INT_BASIC", 1, 1)) as Record<string, unknown>).steps as ScenarioStep[];
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

describe("mergeChunkMetrics", () => {
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

  it("concatenates and re-indexes response turns", () => {
    const merged = mergeChunkMetrics([respChunk([500, 600]), respChunk([700, 800])]);
    const turns = rTurns(merged);
    expect(turns).toHaveLength(4);
    expect(turns[0].turn_index).toBe(1);
    expect(turns[3].turn_index).toBe(4);
    expect(turns[0].latency_ms).toBe(500);
    expect(turns[3].latency_ms).toBe(800);
  });

  it("concatenates interrupt turns", () => {
    const merged = mergeChunkMetrics([intChunk([300]), intChunk([400])]);
    const turns = iTurns(merged);
    expect(turns).toHaveLength(2);
    expect(turns[0].reaction_time_ms).toBe(300);
    expect(turns[1].reaction_time_ms).toBe(400);
  });

  it("handles chunks with no metrics", () => {
    const merged = mergeChunkMetrics([{}, {}]);
    expect(rTurns(merged)).toHaveLength(0);
    expect(iTurns(merged)).toHaveLength(0);
    expect(merged._merged_from_chunks).toBe(2);
  });

  it("handles single chunk", () => {
    const merged = mergeChunkMetrics([respChunk([500])]);
    expect(rTurns(merged)).toHaveLength(1);
    expect(merged._merged_from_chunks).toBe(1);
  });

  it("handles mixed response + interrupt across chunks", () => {
    const c1 = { ...respChunk([500]), ...intChunk([200]) };
    const c2 = respChunk([600]);
    const merged = mergeChunkMetrics([c1, c2]);
    expect(rTurns(merged)).toHaveLength(2);
    expect(iTurns(merged)).toHaveLength(1);
  });

  it("preserves per-family summary when a family has no turn-level data", () => {
    // response has turn-level; interruption only has summary (no turn_level)
    const c1 = { response_metrics: { latency: { turn_level: [{ latency_ms: 500 }] } } };
    const c2 = { interruption_metrics: { latency: { summary: { p50_reaction_time_ms: 300, p95_reaction_time_ms: 450 } } } };
    const merged = mergeChunkMetrics([c1, c2]);
    expect(rTurns(merged)).toHaveLength(1);
    expect(iTurns(merged)).toHaveLength(0);
    // interruption summary carried through so the daemon parser can fall back
    const iSummary = ((merged.interruption_metrics as Record<string, unknown>).latency as Record<string, unknown>).summary as Record<string, unknown>;
    expect(iSummary.p50_reaction_time_ms).toBe(300);
  });

  it("preserves aggregated_summary and scalar metrics", () => {
    const c1 = { response_metrics: { latency: { turn_level: [{ latency_ms: 500 }] } }, aggregated_summary: { avg_response_latency_ms: 510 }, network_resilience: 88, naturalness: 4.1, noise_reduction: 92 };
    const merged = mergeChunkMetrics([c1]);
    expect((merged.aggregated_summary as Record<string, unknown>).avg_response_latency_ms).toBe(510);
    expect(merged.network_resilience).toBe(88);
    expect(merged.naturalness).toBe(4.1);
    expect(merged.noise_reduction).toBe(92);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: realistic 30-sample, 3-suite scenario → 6 chunks
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

    for (let i = 1; i <= 10; i++) {
      const id = `RSP_BASIC-${String(i).padStart(3, "0")}`;
      sampleSteps.push(
        { type: "lab.trace", event: "case_sample_start", suite: "turn_taking_en", case_id: "RSP_BASIC", sample_id: id, sample_index: i },
        { type: "audio.play", file: `corpus/turn_taking/en/audio/en_question_short${i}.wav` },
        { type: "audio.wait_for_speech", end_timeout_ms: 45000, silence_duration_ms: 3000 },
      );
    }
    for (let i = 1; i <= 10; i++) {
      const id = `INT_BASIC-${String(i).padStart(3, "0")}`;
      sampleSteps.push(
        { type: "lab.trace", event: "case_sample_start", suite: "turn_taking_en", case_id: "INT_BASIC", sample_id: id, sample_index: i, material_id: `en_Short05Wordswav${i}` },
        { type: "audio.play", file: `corpus/turn_taking/en/audio/en_question${i}.wav` },
        { type: "audio.wait_for_speech_start", timeout_ms: 15000, wait_after_start_ms: 2000 },
        { type: "audio.play", file: `corpus/turn_taking/en/audio/en_Short05Wordswav${i}.wav` },
        { type: "audio.wait_for_speech", end_timeout_ms: 40000, silence_duration_ms: 3000 },
      );
    }
    for (let i = 1; i <= 10; i++) {
      const id = `INT_FALSE-${String(i).padStart(3, "0")}`;
      sampleSteps.push(
        { type: "lab.trace", event: "case_sample_start", suite: "turn_taking_en", case_id: "INT_FALSE", sample_id: id, sample_index: i, material_id: `sound_NonsemanticCoughLaughterwav${i}` },
        { type: "audio.play", file: `corpus/turn_taking/en/audio/en_question${i}.wav` },
        { type: "audio.wait_for_speech_start", timeout_ms: 15000, wait_after_start_ms: 1000 },
        { type: "audio.play", file: `corpus/turn_taking/en/audio/NonsemanticCoughLaughterwav${i}.wav` },
        { type: "audio.wait_for_speech", end_timeout_ms: 40000, silence_duration_ms: 3000 },
      );
    }

    const scenario: ParsedScenario = {
      name: "turn_taking_en",
      description: "turn_taking_en - RSP_BASIC + INT_BASIC + INT_FALSE",
      analysis: { preset: "config/analysis_presets/default.yaml", report: { template: "medialab.html.jinja2" } },
      params: { lab: { suite: "turn_taking_en" } },
      steps: sampleSteps,
    };
    return { scenario, stepsPrefix, stepsSuffix };
  }

  it("extracts 30 samples, no inline prefix/suffix", () => {
    const { scenario } = buildRealistic();
    const { prefixSteps, suffixSteps, samples } = extractSampleGroups(scenario.steps);
    expect(prefixSteps).toHaveLength(0);
    expect(suffixSteps).toHaveLength(0);
    expect(samples).toHaveLength(30);
  });

  it("groups into 3 suites of 10", () => {
    const { scenario } = buildRealistic();
    const { samples } = extractSampleGroups(scenario.steps);
    const groups = groupByCaseId(samples);
    expect(groups.size).toBe(3);
    expect([...groups.values()].map(g => g.length)).toEqual([10, 10, 10]);
  });

  it("produces 6 valid chunk YAMLs with aeval-convention names", () => {
    const { scenario, stepsPrefix, stepsSuffix } = buildRealistic();
    const { samples } = extractSampleGroups(scenario.steps);
    const groups = groupByCaseId(samples);
    const names: string[] = [];
    for (const [caseId, caseSamples] of groups) {
      const totalChunks = Math.ceil(caseSamples.length / CHUNK_SIZE);
      for (let i = 0; i < totalChunks; i++) {
        const chunk = caseSamples.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        const y = buildChunkYaml(scenario, stepsPrefix, chunk, stepsSuffix, caseId, i + 1, totalChunks);
        const parsed = yaml.load(y) as Record<string, unknown>;
        expect(Array.isArray(parsed.steps)).toBe(true);
        names.push(parsed.name as string);
      }
    }
    expect(names).toHaveLength(6);
    expect(names).toContain("turn_taking_en_RSP_BASIC_chunk_001");
    expect(names).toContain("turn_taking_en_RSP_BASIC_chunk_002");
    expect(names).toContain("turn_taking_en_INT_BASIC_chunk_001");
    expect(names).toContain("turn_taking_en_INT_FALSE_chunk_002");
  });

  it("RSP chunk has 4 prefix + 15 sample + 2 suffix = 21 steps", () => {
    const { scenario, stepsPrefix, stepsSuffix } = buildRealistic();
    const { samples } = extractSampleGroups(scenario.steps);
    const rsp = samples.filter(s => s.caseId === "RSP_BASIC").slice(0, 5);
    const steps = (yaml.load(buildChunkYaml(scenario, stepsPrefix, rsp, stepsSuffix, "RSP_BASIC", 1, 2)) as Record<string, unknown>).steps as ScenarioStep[];
    expect(steps).toHaveLength(21);
    expect(steps[19].type).toBe("audio.stop_recording");
    expect(steps[20].type).toBe("platform.exit");
  });

  it("INT chunk has 4 prefix + 25 sample + 2 suffix = 31 steps", () => {
    const { scenario, stepsPrefix, stepsSuffix } = buildRealistic();
    const { samples } = extractSampleGroups(scenario.steps);
    const intB = samples.filter(s => s.caseId === "INT_BASIC").slice(0, 5);
    const steps = (yaml.load(buildChunkYaml(scenario, stepsPrefix, intB, stepsSuffix, "INT_BASIC", 1, 2)) as Record<string, unknown>).steps as ScenarioStep[];
    expect(steps).toHaveLength(31);
  });

  it("partitions sample_ids correctly across chunks", () => {
    const { scenario, stepsPrefix, stepsSuffix } = buildRealistic();
    const { samples } = extractSampleGroups(scenario.steps);
    const rsp = samples.filter(s => s.caseId === "RSP_BASIC");
    const p1 = yaml.load(buildChunkYaml(scenario, stepsPrefix, rsp.slice(0, 5), stepsSuffix, "RSP_BASIC", 1, 2)) as Record<string, unknown>;
    const p2 = yaml.load(buildChunkYaml(scenario, stepsPrefix, rsp.slice(5, 10), stepsSuffix, "RSP_BASIC", 2, 2)) as Record<string, unknown>;
    const ids1 = ((p1.params as Record<string, unknown>).lab as Record<string, unknown>).sample_ids;
    const ids2 = ((p2.params as Record<string, unknown>).lab as Record<string, unknown>).sample_ids;
    expect(ids1).toEqual(["RSP_BASIC-001", "RSP_BASIC-002", "RSP_BASIC-003", "RSP_BASIC-004", "RSP_BASIC-005"]);
    expect(ids2).toEqual(["RSP_BASIC-006", "RSP_BASIC-007", "RSP_BASIC-008", "RSP_BASIC-009", "RSP_BASIC-010"]);
  });

  it("merged metrics from 6 chunks compute sane MED/SD/P95", () => {
    const chunkMetrics: Record<string, unknown>[] = [];
    for (const lat of [[400, 450, 500, 550, 600], [420, 470, 520, 570, 620]]) {
      chunkMetrics.push({ response_metrics: { latency: { turn_level: lat.map((ms, i) => ({ turn_index: i + 1, latency_ms: ms })) } } });
    }
    for (const lat of [[200, 250, 300, 350, 400], [220, 270, 320, 370, 420]]) {
      chunkMetrics.push({ interruption_metrics: { latency: { turn_level: lat.map((ms, i) => ({ turn_index: i + 1, reaction_time_ms: ms })) } } });
    }
    for (const vals of [[500, 550], [480, 530]]) {
      chunkMetrics.push({
        response_metrics: { latency: { turn_level: vals.map((ms, i) => ({ turn_index: i + 1, latency_ms: ms })) } },
        interruption_metrics: { latency: { turn_level: vals.map((ms, i) => ({ turn_index: i + 1, reaction_time_ms: ms - 200 })) } },
      });
    }

    const merged = mergeChunkMetrics(chunkMetrics);
    const rt = ((merged.response_metrics as Record<string, unknown>).latency as { turn_level: Record<string, unknown>[] }).turn_level;
    const it = ((merged.interruption_metrics as Record<string, unknown>).latency as { turn_level: Record<string, unknown>[] }).turn_level;
    expect(rt).toHaveLength(14); // 5+5+2+2
    expect(it).toHaveLength(14); // 5+5+2+2

    const rVals = rt.map(t => t.latency_ms as number);
    expect(Math.round(median(rVals))).toBeGreaterThan(0);
    expect(Math.round(sd(rVals))).toBeGreaterThan(0);
    expect(Math.round(p95(rVals))).toBeGreaterThanOrEqual(Math.round(median(rVals)));
    expect(merged._merged_from_chunks).toBe(6);
  });

  it("boundary: 3 samples → 1 chunk", () => {
    const { samples } = extractSampleGroups([
      { type: "lab.trace", case_id: "RSP", sample_id: "RSP-1" }, { type: "audio.play" },
      { type: "lab.trace", case_id: "RSP", sample_id: "RSP-2" }, { type: "audio.play" },
      { type: "lab.trace", case_id: "RSP", sample_id: "RSP-3" }, { type: "audio.play" },
    ]);
    expect(Math.ceil(groupByCaseId(samples).get("RSP")!.length / CHUNK_SIZE)).toBe(1);
  });

  it("boundary: exactly 5 → 1 chunk; 6 → 2 chunks", () => {
    const make = (n: number) => {
      const steps: ScenarioStep[] = [];
      for (let i = 1; i <= n; i++) steps.push({ type: "lab.trace", case_id: "RSP", sample_id: `RSP-${i}` }, { type: "audio.play" });
      return extractSampleGroups(steps).samples;
    };
    expect(Math.ceil(make(5).length / CHUNK_SIZE)).toBe(1);
    expect(Math.ceil(make(6).length / CHUNK_SIZE)).toBe(2);
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
  // (executeAevalWithChunking, ~line 529) — keep in sync; it is a private method
  // and cannot be imported:
  //   samples.length > 0 && prefixSteps.length === 0 && suffixSteps.length === 0
  const canChunk = (steps: ScenarioStep[]) => {
    const { prefixSteps, suffixSteps, samples } = extractSampleGroups(steps);
    return samples.length > 0 && prefixSteps.length === 0 && suffixSteps.length === 0;
  };

  it("clean lab.trace body is chunkable", () => {
    const steps: ScenarioStep[] = [
      { type: "lab.trace", sample_id: "A-001", case_id: "INT_BASIC" },
      { type: "audio.play", corpus_id: "q1" },
      { type: "lab.trace", sample_id: "A-002", case_id: "INT_BASIC" },
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
