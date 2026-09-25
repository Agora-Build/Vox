import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  compilePhoneConversation, splitPhoneScript, ensureTrailingHangup, sumStepTimeouts,
  computePhoneRateEntries, toCallMetadata, buildSessionDir, runPhoneJob, stagePlayFiles,
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
      { resolveCorpusFile: corpus, segment: 'conversation' },
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
      const r = compilePhoneConversation(steps, { resolveCorpusFile: corpus, segment: "conversation" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain(errPart);
    };
    bad([{ type: "platform.setup" }], "web-session vocabulary");
    bad([{ type: "browser.click" }], "web-session vocabulary");
    bad([{ type: "audio.play", corpus_id: "nope" }], "unknown corpus_id");
    bad([{ type: "restful.request" }], "illegal in an eval-set conversation");
    bad([{ type: "audio.play", file: "relative.wav" }], "not resolvable");
    bad([], "zero steps");
  });
});

describe("Setup/Teardown steps travel from evalflow config into job config", () => {
  it("mergeEvalConfig carries stepsPrefix/stepsSuffix through to the job", async () => {
    const { mergeEvalConfig } = await import("../server/storage");
    const jobConfig = mergeEvalConfig(
      { framework: "aeval", stepsPrefix: '- type: call.dial\n  number: "+1 408 837 5890"\n', stepsSuffix: "- type: call.hangup\n" },
      { scenario: "steps:\n  - type: audio.play" },
    );
    // The daemon reads job.config.stepsPrefix — call establishment is evalflow
    // data fetched from Vox with the claimed job, never host/env configuration.
    expect(jobConfig.stepsPrefix).toContain("call.dial");
    expect(jobConfig.stepsSuffix).toContain("call.hangup");
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
    expect(out.steps[0]).toMatchObject({
      type: "log",
      message: "trace case_sample_start RSP_BASIC RSP_BASIC-001",
      description: "trace case_sample_start RSP_BASIC RSP_BASIC-001", // outcomes echo description — rate attribution reads it
    });
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

describe("splitPhoneScript + ensureTrailingHangup + sumStepTimeouts", () => {
  const SETUP = [
    { type: "call.dial", number: "+15551234" },
    { type: "call.wait_answered" },
  ];
  const CONV = [
    { type: "audio.play", corpus_id: "known_q1" },
    { type: "audio.wait_for_speech", end_timeout_ms: 40000 },
  ];

  const compileAll = (setupRaw: unknown[], convRaw: unknown[], teardownRaw: unknown[]) => {
    const setup = compilePhoneConversation(setupRaw, { resolveCorpusFile: corpus, segment: "setup", idPrefix: "p" });
    if (!setup.ok) throw new Error(setup.error);
    const conv = compilePhoneConversation(convRaw, { resolveCorpusFile: corpus, segment: "conversation", idPrefix: "s" });
    if (!conv.ok) throw new Error(conv.error);
    const teardown = compilePhoneConversation(teardownRaw, { resolveCorpusFile: corpus, segment: "teardown", idPrefix: "t" });
    if (!teardown.ok) throw new Error(teardown.error);
    return [...setup.steps, ...conv.steps, ...teardown.steps];
  };

  it("compiles the three segments into one session block with unique ids and a sized timeout", () => {
    const split = splitPhoneScript(SETUP, CONV, [{ type: "call.hangup" }]);
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    expect(split.value.restfulPrecall).toEqual([]);
    const job = ensureTrailingHangup(compileAll(split.value.setupRaw, split.value.conversationRaw, split.value.teardownRaw));
    expect(job[0]).toMatchObject({ type: "call.dial", number: "+15551234" });
    expect(job[1].type).toBe("call.wait_answered");
    expect(job[1].timeout_ms).toBe(30000); // answer default applied
    expect(job[job.length - 1].type).toBe("call.hangup");
    expect(new Set(job.map((st) => st.id)).size).toBe(job.length); // ids unique across segments
    // 60s slack + 30s answered + 30s play allowance + 40s wait = 160s
    expect(sumStepTimeouts(job)).toBe(60000 + 30000 + 30000 + 40000);
  });

  it("appends call.hangup only when Teardown omitted it", () => {
    const appended = ensureTrailingHangup(compileAll(SETUP, CONV, []));
    expect(appended[appended.length - 1]).toMatchObject({ type: "call.hangup", id: "bye" });
    expect(ensureTrailingHangup(appended)).toBe(appended); // idempotent
  });

  it("SECURITY: a ${item} template cannot smuggle call.dial past the segment policy", () => {
    // The raw scan sees only "${item.t}"; the compiler enforces the policy on
    // the substituted type — the actual boundary.
    const smuggle = [{
      type: "control.for_each",
      items: [{ t: "call.dial", n: "+1900PREMIUM" }],
      steps: [{ type: "${item.t}", number: "${item.n}" }],
    }];
    const split = splitPhoneScript(SETUP, smuggle, []);
    expect(split.ok).toBe(true); // raw scan can't see through the template…
    const conv = compilePhoneConversation(smuggle, { resolveCorpusFile: corpus, segment: "conversation" });
    expect(conv.ok).toBe(false); // …the compiler can.
    if (!conv.ok) expect(conv.error).toContain("illegal in an eval-set conversation");
    // Same template in Teardown: only hangup may survive substitution.
    const td = compilePhoneConversation(smuggle, { resolveCorpusFile: corpus, segment: "teardown" });
    expect(td.ok).toBe(false);
    // A templated NUMBER must substitute to a dialable shape — "*123#"-style
    // USSD payloads are rejected post-substitution.
    const ussd = compilePhoneConversation([{
      type: "control.for_each", items: [{ n: "*123#" }],
      steps: [{ type: "call.dial", number: "${item.n}" }],
    }], { resolveCorpusFile: corpus, segment: "setup" });
    expect(ussd.ok).toBe(false);
    if (!ussd.ok) expect(ussd.error).toContain("not a dialable phone number");
    const goodTemplated = compilePhoneConversation([{
      type: "control.for_each", items: [{ n: "+1 555 010 1234" }],
      steps: [{ type: "call.dial", number: "${item.n}" }],
    }], { resolveCorpusFile: corpus, segment: "setup" });
    expect(goodTemplated.ok).toBe(true);
  });

  it("SECURITY: a phone job places exactly ONE call — for_each over numbers cannot multiply dials", () => {
    const multi = compilePhoneConversation([{
      type: "control.for_each",
      items: [{ n: "+1 555 010 1234" }, { n: "+1 900 555 0100" }],
      steps: [{ type: "call.dial", number: "${item.n}" }, { type: "call.hangup" }],
    }], { resolveCorpusFile: corpus, segment: "setup" });
    expect(multi.ok).toBe(false);
    if (!multi.ok) expect(multi.error).toContain("exactly ONE call");
    const two = compilePhoneConversation([
      { type: "call.dial", number: "+15551234" },
      { type: "call.hangup" },
      { type: "call.dial", number: "+15559999" },
    ], { resolveCorpusFile: corpus, segment: "setup" });
    expect(two.ok).toBe(false);
  });

  it("normalizeDialableNumber strips carrier formatting; unusable stays null", async () => {
    const { normalizeDialableNumber } = await import("../shared/steps");
    expect(normalizeDialableNumber("+1.408.837.5890")).toBe("+14088375890");
    expect(normalizeDialableNumber("+1 408 837 5890")).toBe("+1 408 837 5890");
    expect(normalizeDialableNumber("evil.example/#")).toBeNull();
    expect(normalizeDialableNumber("x")).toBeNull();
  });

  it("DoS: nested for_each over no-output steps trips the ITERATION budget, not just the output cap", () => {
    // Each level multiplies iterations by |items| while emitting nothing —
    // 5 levels x 30 items = 24.3M iterations if unbounded.
    const items = Array.from({ length: 30 }, (_, i) => i);
    let inner: Record<string, unknown> = { type: "audio.start_recording" }; // dropped, no output
    for (let i = 0; i < 5; i++) inner = { type: "control.for_each", items, steps: [inner] };
    const start = Date.now();
    const r = compilePhoneConversation([inner], { resolveCorpusFile: corpus, segment: "conversation" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("loop iterations");
    expect(Date.now() - start).toBeLessThan(2000); // bounded work, not |items|^depth
  });

  it("splits leading restful.request steps with their ABSOLUTE stepsPrefix indices", () => {
    const split = splitPhoneScript(
      [
        { type: "restful.request", method: "POST", url: "https://x.example/call" },
        { type: "restful.request", method: "POST", url: "https://x.example/arm" },
        ...SETUP,
      ],
      CONV, [],
    );
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    expect(split.value.restfulPrecall).toEqual([{ stepIndex: 0 }, { stepIndex: 1 }]);
    expect((split.value.setupRaw[0] as { type: string }).type).toBe("call.dial");
  });

  it("rejects restful.request out of position (mid-Setup, conversation, Teardown)", () => {
    const mid = splitPhoneScript([SETUP[0], { type: "restful.request" }, SETUP[1]], CONV, []);
    expect(mid.ok).toBe(false);
    if (!mid.ok) expect(mid.error).toContain("must lead Setup Steps");
    const inConv = splitPhoneScript(SETUP, [{ type: "restful.request" }], []);
    expect(inConv.ok).toBe(false);
    const inTeardown = splitPhoneScript(SETUP, CONV, [{ type: "restful.request" }]);
    expect(inTeardown.ok).toBe(false);
  });

  it("SECURITY: the eval-set conversation cannot place/end calls — even nested in for_each", () => {
    const dialInConv = splitPhoneScript(SETUP, [{ type: "call.dial", number: "+1900PREMIUM" }], []);
    expect(dialInConv.ok).toBe(false);
    if (!dialInConv.ok) expect(dialInConv.error).toContain("illegal in an eval-set conversation");
    const hangupInConv = splitPhoneScript(SETUP, [{ type: "call.hangup" }], []);
    expect(hangupInConv.ok).toBe(false);
    const nested = splitPhoneScript(SETUP, [
      { type: "control.for_each", items: [1], steps: [{ type: "call.dial", number: "+1900PREMIUM" }] },
    ], []);
    expect(nested.ok).toBe(false);
    const sms = splitPhoneScript(SETUP, [{ type: "sms.send", to: "+1900", body: "x" }], []);
    expect(sms.ok).toBe(false);
  });

  it("Teardown allows only call.hangup among call.*; setupHasDial comes from Setup alone", () => {
    const dialInTeardown = splitPhoneScript(SETUP, CONV, [{ type: "call.dial", number: "+1900PREMIUM" }]);
    expect(dialInTeardown.ok).toBe(false);
    if (!dialInTeardown.ok) expect(dialInTeardown.error).toContain("only call.hangup");
    const hangupOk = splitPhoneScript(SETUP, CONV, [{ type: "log", message: "bye" }, { type: "call.hangup" }]);
    expect(hangupOk.ok).toBe(true);
    const noDialSetup = splitPhoneScript([{ type: "call.wait_answered" }], CONV, []);
    expect(noDialSetup.ok).toBe(true);
    if (noDialSetup.ok) expect(noDialSetup.value.setupHasDial).toBe(false);
    const withDial = splitPhoneScript(SETUP, CONV, []);
    if (withDial.ok) expect(withDial.value.setupHasDial).toBe(true);
    // Recursive: the compiler unrolls for_each, so a nested Setup dial arms the gate.
    const nestedDial = splitPhoneScript(
      [{ type: "control.for_each", items: [1], steps: [{ type: "call.dial", number: "+15551234" }] }], CONV, []);
    if (nestedDial.ok) expect(nestedDial.value.setupHasDial).toBe(true);
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
    const restfulCalls: number[] = [];
    let hangups = 0;
    const deps = {
      executeRestful: async (stepIndex: number) => { restfulCalls.push(stepIndex); },
      safetyHangup: async () => { hangups++; },
      dialfCall: async (op: string, fields: any, timeoutMs?: number) => {
        calls.push({ op, fields, timeoutMs });
        return {
          steps: [{ index: 0, id: "dial", type: "call.dial", t_start_ms: 0, t_end_ms: 100, end_reason: "completed" }],
          recording: { mix: rx, t0_epoch_ms: 1 },
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
    return { deps, calls, restfulCalls, hangups: () => hangups, tmp };
  };

  const cfg = {
    jobId: 42,
    prefixSteps: [
      { type: "call.dial", number: "+15551234" },
      { type: "call.wait_answered" },
    ],
    scenarioSteps: [
      { type: "audio.play", corpus_id: "known_q1" },
      { type: "audio.wait_for_speech", end_timeout_ms: 40000 },
    ],
    suffixSteps: [],
    resolveCorpusFile: corpus,
  };

  it("happy path: dial job dispatched with sized timeout, metrics + callMetadata returned", async () => {
    const { deps, calls, tmp } = mkDeps();
    const out = await runPhoneJob(cfg, deps as any);
    expect(calls[0].op).toBe("job.run");
    expect(calls[0].fields.name).toBe("vox-job-42");
    expect(calls[0].fields.steps[0].type).toBe("call.dial");
    // No exchange dir → no per-run record_dir (dialfd's own config governs).
    expect(calls[0].fields.record_dir).toBeUndefined();
    expect(calls[0].timeoutMs).toBe(60000 + 30000 + 30000 + 40000);
    expect(out.result).toEqual({ responseLatencyMedian: 900, turnSuccessRate: 0.9 });
    expect(out.callMetadata).toMatchObject({ disposition: "completed", fromRedacted: "…9876" });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("with an exchange dir, job.run carries per-run record_dir into the exchange (dialfd ≥ 0.3.16)", async () => {
    const { deps, calls, tmp } = mkDeps();
    const realClip = path.join(tmp, "clip.wav");
    fs.writeFileSync(realClip, "RIFF");
    const exchange = path.join(tmp, "xchg");
    await runPhoneJob(
      { ...cfg, resolveCorpusFile: () => realClip, exchangeDir: exchange },
      deps as any,
    );
    expect(calls[0].fields.record_dir).toBe(path.join(exchange, "recordings"));
    // Play file was staged into the exchange too.
    const play = calls[0].fields.steps.find((s: any) => s.type === "audio.play");
    expect(String(play.file).startsWith(path.join(exchange, "corpus"))).toBe(true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("fails on: no call.dial, trigger-only (R7), bad disposition, analyze error, no metrics", async () => {
    const { deps, tmp } = mkDeps();
    await expect(runPhoneJob({ ...cfg, prefixSteps: [] }, deps as any)).rejects.toThrow(/establish no call/);
    await expect(runPhoneJob(
      { ...cfg, prefixSteps: [{ type: "restful.request", method: "POST", url: "https://x.example/y" }] },
      deps as any,
    )).rejects.toThrow(/not yet supported.*R7/);

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

  it("executes leading restful.request steps via Core BEFORE the dial, in order", async () => {
    const { deps, calls, restfulCalls, tmp } = mkDeps();
    await runPhoneJob({
      ...cfg,
      prefixSteps: [
        { type: "restful.request", method: "POST", url: "https://x.example/trigger" },
        ...cfg.prefixSteps,
      ],
    }, deps as any);
    expect(restfulCalls).toEqual([0]); // absolute index within stepsPrefix
    expect(calls[0].op).toBe("job.run"); // dial happened after the trigger
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("a failed restful.request fails the job BEFORE any dial", async () => {
    const { deps, calls, tmp } = mkDeps({
      executeRestful: async () => { throw new Error("restful.request step 0 failed: HTTP 502"); },
    } as any);
    await expect(runPhoneJob({
      ...cfg,
      prefixSteps: [
        { type: "restful.request", method: "POST", url: "https://x.example/trigger" },
        ...cfg.prefixSteps,
      ],
    }, deps as any)).rejects.toThrow(/HTTP 502/);
    expect(calls.length).toBe(0); // no job.run dispatched — no wasted carrier call
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("safety net: job.run failure and non-completed disposition both invoke safetyHangup", async () => {
    const timeoutRun = mkDeps({
      dialfCall: async () => { throw new Error("dialf op timed out"); },
    });
    await expect(runPhoneJob(cfg, timeoutRun.deps as any)).rejects.toThrow(/timed out/);
    expect(timeoutRun.hangups()).toBe(1);
    fs.rmSync(timeoutRun.tmp, { recursive: true, force: true });

    const badDisp = mkDeps({
      dialfCall: async () => ({ steps: [], recording: {}, call: { end_reason: "no_answer" } }),
    });
    await expect(runPhoneJob(cfg, badDisp.deps as any)).rejects.toThrow(/disposition=no_answer/);
    expect(badDisp.hangups()).toBe(1);
    fs.rmSync(badDisp.tmp, { recursive: true, force: true });

    // Success path never needs the rescue.
    const good = mkDeps();
    await runPhoneJob(cfg, good.deps as any);
    expect(good.hangups()).toBe(0);
    fs.rmSync(good.tmp, { recursive: true, force: true });
  });

  it("enforced hangup: session block without a teardown hangup still ends with call.hangup", async () => {
    const { deps, calls, tmp } = mkDeps();
    await runPhoneJob(cfg, deps as any); // cfg.suffixSteps is []
    const steps = calls[0].fields.steps;
    expect(steps[steps.length - 1]).toMatchObject({ type: "call.hangup", id: "bye" });
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("computePhoneRateEntries → computePerCaseAndRates (TSR on the phone path)", () => {
  const mk = (tMs: number, type: string, description?: string) =>
    ({ type, description, t_start_ms: tMs, t_end_ms: tMs + 100, end_reason: "completed" });

  // Two RSP samples (one answered, one not) + one INT sample (interrupted OK).
  // Same semantics as the web path's computePerCaseAndRates: response_rate
  // pools ALL samples as response opportunities → 1/3; interrupt_rate 1/1.
  const outcomes = [
    mk(0, "log", "trace case_sample_start RSP_BASIC RSP_BASIC-001"),
    mk(100, "audio.play"),
    mk(1000, "audio.wait_for_speech"),
    mk(10000, "log", "trace case_sample_start RSP_BASIC RSP_BASIC-002"),
    mk(10100, "audio.play"),
    mk(11000, "audio.wait_for_speech"),
    mk(20000, "log", "trace case_sample_start INT_BASIC INT_BASIC-001"),
    mk(20100, "audio.play"),
    mk(21000, "audio.wait_for_speech_start"),
    mk(23000, "audio.play"),
    mk(24000, "audio.wait_for_speech"),
  ];
  const enriched = {
    response_metrics: { latency: { turn_level: [
      { turn_index: 0, latency_ms: 900, turn_start: 2.0 },   // in RSP-001 window
    ] } },
    interruption_metrics: { latency: { turn_level: [
      { turn_index: 2, reaction_time_ms: 400, turn_start: 23.5 }, // in INT window
    ] } },
  };

  it("attributes turns to sample windows and yields correct per-case entries + TSR", async () => {
    const entries = computePhoneRateEntries(outcomes as any, enriched as any);
    const byCase = Object.fromEntries(entries.map((e) => [e.caseId, e]));
    expect(byCase.RSP_BASIC.sampleCount).toBe(2);
    expect(byCase.RSP_BASIC.hasInterruptPhase).toBe(false);
    expect(byCase.INT_BASIC.sampleCount).toBe(1);
    expect(byCase.INT_BASIC.hasInterruptPhase).toBe(true);

    const { computePerCaseAndRates } = await import("../vox_eval_agentd/chunking");
    const { rates } = computePerCaseAndRates(entries);
    expect(rates.response_rate).toBeCloseTo(1 / 3);      // 1 response over 3 response-scored samples? see note below
    expect(rates.interrupt_rate).toBe(1);
    expect(rates.turn_success_rate).not.toBeNull();
  });

  it("returns [] without timestamped markers (old dialfd) — rates stay NA", () => {
    const noTs = outcomes.map(({ t_start_ms, ...rest }) => rest);
    expect(computePhoneRateEntries(noTs as any, enriched as any)).toEqual([]);
    expect(computePhoneRateEntries([mk(0, "audio.play")] as any, enriched as any)).toEqual([]);
  });
});

describe("buildSessionDir", () => {
  it("stages ONE deterministic recording (mix preferred, rx fallback) + dialf metadata", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "phone-eval-"));
    const rx = path.join(tmp, "src-rx.wav");
    const mix = path.join(tmp, "src-mix.wav");
    fs.writeFileSync(rx, "RXDATA");
    fs.writeFileSync(mix, "MIXDATA");

    const withMix = buildSessionDir(
      {
        steps: [{ index: 0, id: "s1", type: "audio.play", t_start_ms: 0, t_end_ms: 900, end_reason: "completed" }],
        recording: { rx, mix, t0_epoch_ms: 1758412800123 },
        call: { end_reason: "completed" },
      },
      path.join(tmp, "s1"),
    );
    expect(fs.readFileSync(path.join(withMix, "recordings", "recording.wav"), "utf-8")).toBe("MIXDATA");
    expect(fs.readdirSync(path.join(withMix, "recordings"))).toEqual(["recording.wav"]); // exactly one
    expect(JSON.parse(fs.readFileSync(path.join(withMix, "dialf", "steps.json"), "utf-8"))[0].id).toBe("s1");
    expect(JSON.parse(fs.readFileSync(path.join(withMix, "dialf", "t0.json"), "utf-8")).t0_epoch_ms).toBe(1758412800123);

    // rx-only is a REJECTION, not a fallback: one-speaker audio produces
    // plausible-looking wrong metrics, and the cause is dialfd config.
    expect(() => buildSessionDir({ recording: { rx } }, path.join(tmp, "s2"))).toThrow(/mix_recording/);

    expect(() => buildSessionDir({ steps: [] }, path.join(tmp, "empty"))).toThrow(/no mix recording/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
