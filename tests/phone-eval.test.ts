import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  compilePhoneConversation, buildOutboundJob, sumStepTimeouts,
  toCallMetadata, buildSessionDir, runPhoneJob, stagePlayFiles,
} from "../vox_eval_agentd/phone-eval";

const corpus = (id: string) => (id.startsWith("known") ? `/abs/corpus/${id}.wav` : null);

describe("compilePhoneConversation", () => {
  it("compiles play/wait/interrupt with defaults, unrolls for_each, drops start_recording", () => {
    const out = compilePhoneConversation(
      [
        { type: "audio.start_recording" },
        {
          type: "control.for_each",
          items: [{ q: "known_q1", m: "known_m1" }],
          steps: [
            { type: "audio.play", corpus_id: "${item.q}", description: "ask" },
            { type: "audio.wait_for_speech_start", wait_after_start_ms: 2000 },
            { type: "audio.play", corpus_id: "${item.m}", description: "barge-in" },
            { type: "audio.wait_for_speech", end_timeout_ms: 40000, silence_duration_ms: 1500 },
          ],
        },
        { type: "control.log", message: "done" },
      ],
      { resolveCorpusFile: corpus },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.steps.map((s) => s.type)).toEqual([
      "audio.play", "audio.wait_for_speech_start", "audio.play", "audio.wait_for_speech", "log",
    ]);
    expect(out.steps[0].file).toBe("/abs/corpus/known_q1.wav");
    expect(out.steps[1].timeout_ms).toBe(15000); // default applied
    expect(out.steps[1].wait_after_start_ms).toBe(2000);
    expect(out.steps.every((s) => typeof s.id === "string" && s.id.length > 0)).toBe(true);
  });

  it("rejects web vocabulary, unknown corpus, unknown step, relative paths, empty result", () => {
    const bad = (steps: unknown[], errPart: string) => {
      const r = compilePhoneConversation(steps, { resolveCorpusFile: corpus });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain(errPart);
    };
    bad([{ type: "platform.setup" }], "web-session vocabulary");
    bad([{ type: "browser.click" }], "web-session vocabulary");
    bad([{ type: "audio.play", corpus_id: "nope" }], "unknown corpus_id");
    bad([{ type: "restful.request" }], "unsupported step type");
    bad([{ type: "audio.play", file: "relative.wav" }], "not resolvable");
    bad([], "zero steps");
  });
});

describe("phoneDial travels from workflow config into job config", () => {
  it("mergeEvalConfig carries phoneDial (and restfulTrigger) through to the job", async () => {
    const { mergeEvalConfig } = await import("../server/storage");
    const jobConfig = mergeEvalConfig(
      { framework: "aeval", phoneDial: { number: "+1 408 837 5890" } },
      { scenario: "steps:\n  - type: audio.play" },
    );
    // The daemon reads job.config.phoneDial — the number is workflow data
    // fetched from Vox with the claimed job, never host/env configuration.
    expect(jobConfig.phoneDial).toEqual({ number: "+1 408 837 5890" });
    expect(jobConfig.scenario).toBeDefined();
  });
});

describe("compile: lab.trace mapping + relative file resolution (turn_taking shape)", () => {
  it("maps lab.trace to a log step and resolves relative file refs", () => {
    const out = compilePhoneConversation(
      [
        { type: "lab.trace", event: "case_sample_start", case_id: "RSP_BASIC", sample_id: "RSP_BASIC-001" },
        { type: "audio.play", file: "corpus/turn_taking/en/audio/q1.wav" },
        { type: "audio.wait_for_speech", end_timeout_ms: 45000, silence_duration_ms: 3000 },
      ],
      {
        resolveCorpusFile: () => null,
        resolveRelativeFile: (rel) => (rel.startsWith("corpus/") ? `/data/${rel}` : null),
      },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.steps[0]).toMatchObject({ type: "log", message: "trace case_sample_start RSP_BASIC RSP_BASIC-001" });
    expect(out.steps[1].file).toBe("/data/corpus/turn_taking/en/audio/q1.wav");
  });

  it("still rejects an unresolvable relative file", () => {
    const out = compilePhoneConversation(
      [{ type: "audio.play", file: "nowhere/x.wav" }],
      { resolveCorpusFile: () => null, resolveRelativeFile: () => null },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("not resolvable");
  });
});

describe("stagePlayFiles (Docker↔host exchange dir)", () => {
  it("copies play files into <exchange>/corpus and rewrites paths; no-op without exchange", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stage-"));
    const src = path.join(tmp, "clip.wav");
    fs.writeFileSync(src, "RIFF");
    const steps = [
      { type: "audio.play", id: "s1", file: src },
      { type: "audio.wait_for_speech", id: "s2" },
      { type: "audio.play", id: "s3", file: src }, // same source → same staged copy
    ];
    const exchange = path.join(tmp, "exchange");
    const staged = stagePlayFiles(steps as any, exchange);
    expect(staged[0].file).not.toBe(src);
    expect(String(staged[0].file).startsWith(path.join(exchange, "corpus"))).toBe(true);
    expect(fs.readFileSync(String(staged[0].file), "utf-8")).toBe("RIFF");
    expect(staged[2].file).toBe(staged[0].file); // deduped
    expect(staged[1]).toEqual(steps[1]); // non-play untouched

    expect(stagePlayFiles(steps as any, null)).toEqual(steps);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("buildOutboundJob + sumStepTimeouts", () => {
  it("wraps conversation in dial/wait/hangup and sizes the read timeout from the steps", () => {
    const conv = compilePhoneConversation(
      [
        { type: "audio.play", corpus_id: "known_q1" },
        { type: "audio.wait_for_speech", end_timeout_ms: 40000 },
      ],
      { resolveCorpusFile: corpus },
    );
    if (!conv.ok) throw new Error("compile failed");
    const job = buildOutboundJob("+15551234", conv.steps);
    expect(job[0]).toMatchObject({ type: "call.dial", number: "+15551234" });
    expect(job[1].type).toBe("call.wait_answered");
    expect(job[job.length - 1].type).toBe("call.hangup");
    // 60s slack + 30s answered + 30s play allowance + 40s wait = 160s
    expect(sumStepTimeouts(job)).toBe(60000 + 30000 + 30000 + 40000);
  });
});

describe("toCallMetadata", () => {
  it("maps and redacts", () => {
    expect(toCallMetadata({
      answer_latency_ms: 4200, duration_ms: 63500, end_reason: "completed",
      remote_number: "+1 (555) 010-9876", sim: "sim1",
    })).toEqual({
      disposition: "completed", answeredAfterMs: 4200, durationMs: 63500,
      sim: "sim1", fromRedacted: "…9876",
    });
    expect(toCallMetadata(undefined)).toBeNull();
  });
});

describe("runPhoneJob (orchestration, injected deps)", () => {
  const mkDeps = (overrides: Partial<Parameters<typeof runPhoneJob>[1]> = {}) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "phone-run-"));
    const rx = path.join(tmp, "rx.wav");
    fs.writeFileSync(rx, "RIFF");
    const calls: any[] = [];
    const deps = {
      dialfCall: async (op: string, fields: any, timeoutMs?: number) => {
        calls.push({ op, fields, timeoutMs });
        return {
          steps: [{ index: 0, id: "dial", type: "call.dial", t_start_ms: 0, t_end_ms: 100, end_reason: "completed" }],
          recording: { rx, t0_epoch_ms: 1 },
          call: { end_reason: "completed", answer_latency_ms: 4000, duration_ms: 30000, remote_number: "+15550109876" },
        };
      },
      analyze: async (dir: string) => {
        fs.mkdirSync(path.join(dir, "analysis"), { recursive: true });
      },
      parseMetrics: () => ({ responseLatencyMedian: 900, turnSuccessRate: 0.9 }),
      workDir: path.join(tmp, "session"),
      ...overrides,
    };
    return { deps, calls, tmp };
  };

  const cfg = {
    jobId: 42,
    scenarioSteps: [
      { type: "audio.play", corpus_id: "known_q1" },
      { type: "audio.wait_for_speech", end_timeout_ms: 40000 },
    ],
    phoneDial: { number: "+15551234" },
    hasRestfulTrigger: false,
    resolveCorpusFile: corpus,
  };

  it("happy path: dial job dispatched with sized timeout, metrics + callMetadata returned", async () => {
    const { deps, calls, tmp } = mkDeps();
    const out = await runPhoneJob(cfg, deps as any);
    expect(calls[0].op).toBe("job.run");
    expect(calls[0].fields.name).toBe("vox-job-42");
    expect(calls[0].fields.steps[0].type).toBe("call.dial");
    expect(calls[0].timeoutMs).toBe(60000 + 30000 + 30000 + 40000);
    expect(out.result).toEqual({ responseLatencyMedian: 900, turnSuccessRate: 0.9 });
    expect(out.callMetadata).toMatchObject({ disposition: "completed", fromRedacted: "…9876" });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("fails on: no phoneDial, trigger mode, bad disposition, analyze error, no metrics", async () => {
    const { deps, tmp } = mkDeps();
    await expect(runPhoneJob({ ...cfg, phoneDial: undefined }, deps as any)).rejects.toThrow(/needs phoneDial/);
    await expect(runPhoneJob({ ...cfg, phoneDial: undefined, hasRestfulTrigger: true }, deps as any))
      .rejects.toThrow(/not yet supported.*R7/);

    const bad = mkDeps({
      dialfCall: async () => ({ steps: [], recording: {}, call: { end_reason: "far_end_hangup" } }),
    });
    await expect(runPhoneJob(cfg, bad.deps as any)).rejects.toThrow(/disposition=far_end_hangup/);
    fs.rmSync(bad.tmp, { recursive: true, force: true });

    const anafail = mkDeps({ analyze: async () => { throw new Error("aeval analyze exited 1"); } });
    await expect(runPhoneJob(cfg, anafail.deps as any)).rejects.toThrow(/analyze exited 1/);
    fs.rmSync(anafail.tmp, { recursive: true, force: true });

    const nometrics = mkDeps({ parseMetrics: () => null });
    await expect(runPhoneJob(cfg, nometrics.deps as any)).rejects.toThrow(/no usable metrics/);
    fs.rmSync(nometrics.tmp, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("buildSessionDir", () => {
  it("copies legs and writes dialf metadata; throws without recordings", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "phone-eval-"));
    const rx = path.join(tmp, "src-rx.wav");
    fs.writeFileSync(rx, "RIFFfake");
    const dest = path.join(tmp, "session");
    const dir = buildSessionDir(
      {
        steps: [{ index: 0, id: "s1", type: "audio.play", t_start_ms: 0, t_end_ms: 900, end_reason: "completed" }],
        recording: { rx, t0_epoch_ms: 1758412800123 },
        call: { end_reason: "completed" },
      },
      dest,
    );
    expect(fs.readFileSync(path.join(dir, "recordings", "rx.wav"), "utf-8")).toBe("RIFFfake");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "dialf", "steps.json"), "utf-8"))[0].id).toBe("s1");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "dialf", "t0.json"), "utf-8")).t0_epoch_ms).toBe(1758412800123);

    expect(() => buildSessionDir({ steps: [] }, path.join(tmp, "empty"))).toThrow(/no recordings/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
