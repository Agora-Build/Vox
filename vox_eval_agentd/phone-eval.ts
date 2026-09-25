/**
 * Phone-eval pure helpers (unified-steps design 2026-09-25 §2; DialF ≥ v0.3.8
 * contract): split the unified script (Setup + eval-set conversation +
 * Teardown) by Libretto execution class, compile each segment into DialF
 * steps under its own vocabulary policy, size the read timeout, and adapt
 * the DialF result into an aeval-analyzable session dir + callMetadata.
 * Everything here is pure or filesystem-only — no sockets, no processes —
 * so the daemon's phone path is testable without hardware.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { PHONE_NUMBER_RE, illegalPhoneStepType, illegalWebVocabInPhone, walkStepList, stepsContainCallDial } from '../shared/steps';

// ---- compiler ---------------------------------------------------------------

export interface DialfStep {
  type: string;
  id: string;
  [key: string]: unknown;
}

export interface CompileOpts {
  /** corpus_id → absolute wav path (null = unknown id). */
  resolveCorpusFile: (corpusId: string) => string | null;
  /** corpus_set name → item list (null = unknown set). */
  resolveCorpusSet?: (setName: string) => string[] | null;
  /** Relative `file:` reference (aeval convention: relative to the aeval-data
   * root, e.g. `corpus/turn_taking/en/audio/x.wav`) → absolute path
   * (null = not found). Absent ⇒ relative paths are rejected. */
  resolveRelativeFile?: (relPath: string) => string | null;
  /** SECURITY — segment policy, enforced AFTER ${item} substitution (a
   * for_each item can smuggle a step type past any raw-text scan):
   *   'setup'    — evalflow Setup: full call.* allowed
   *   'conversation' — eval-set body: call / restful / sms steps forbidden
   *   'teardown' — evalflow Teardown: only call.hangup among call.* */
  segment: 'setup' | 'conversation' | 'teardown';
  /** Step-id prefix so separately compiled segments never collide. */
  idPrefix?: string;
}

export type CompileResult = { ok: true; steps: DialfStep[] } | { ok: false; error: string };

/** Allowance per audio.play for unknown clip length when sizing the read timeout. */
const PLAY_ALLOWANCE_MS = 30_000;
/** Fixed overhead: call setup + teardown + daemon slack. */
const TIMEOUT_SLACK_MS = 60_000;

const DEFAULTS = { end_timeout_ms: 45_000, timeout_ms: 15_000, answer_timeout_ms: 30_000 };

export function compilePhoneConversation(rawSteps: unknown[], opts: CompileOpts): CompileResult {
  const out: DialfStep[] = [];
  let n = 0;
  const id = () => `${opts.idPrefix ?? 's'}${++n}`;

  const substitute = (value: unknown, item: unknown): unknown => {
    if (typeof value !== 'string') return value;
    let s = value.split('${item}').join(typeof item === 'string' ? item : '');
    if (item !== null && typeof item === 'object') {
      s = s.replace(/\$\{item\.(\w+)\}/g, (_m, k) => String((item as Record<string, unknown>)[k] ?? _m));
    }
    return s;
  };

  const MAX_EMIT_DEPTH = 16;
  const MAX_EMITTED_STEPS = 2000;
  // Work budget counts every RAW step processed, not just emitted output —
  // nested for_each over no-output steps (e.g. dropped audio.start_recording)
  // with aliased big item lists would otherwise burn |items|^depth iterations
  // while out.length stays 0.
  const MAX_EMIT_ITERATIONS = 20_000;
  let iterations = 0;
  const emit = (steps: unknown[], item: unknown, depth = 0): string | null => {
    if (depth > MAX_EMIT_DEPTH) return 'step script too deeply nested';
    for (const raw of steps) {
      if (++iterations > MAX_EMIT_ITERATIONS) return `script expands past ${MAX_EMIT_ITERATIONS} loop iterations`;
      if (out.length > MAX_EMITTED_STEPS) return `script expands past ${MAX_EMITTED_STEPS} steps`;
      if (typeof raw !== 'object' || raw === null) return 'step must be an object';
      const step = Object.fromEntries(
        Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, substitute(v, item)]),
      );
      const type = String(step.type ?? '');
      {
        const webVocab = illegalWebVocabInPhone(type);
        if (webVocab) return webVocab;
      }
      // Segment policy on the POST-substitution type — the only place the
      // real type is known (a for_each item like {t: call.dial} + type:
      // "${item.t}" evades every raw-text scan upstream). Shared with Core's
      // save-time validation (shared/steps.ts) so the rules cannot drift.
      {
        const segErr = illegalPhoneStepType(type, opts.segment);
        if (segErr) return segErr;
      }
      switch (type) {
        case 'audio.start_recording':
          // Recording is a DialF engine obligation (Libretto §6) — drop silently.
          continue;
        case 'audio.play': {
          let file = typeof step.file === 'string' ? step.file : null;
          if (!file && typeof step.corpus_id === 'string') {
            file = opts.resolveCorpusFile(step.corpus_id);
            if (!file) return `unknown corpus_id: ${step.corpus_id}`;
          }
          if (!file) return 'audio.play needs file or corpus_id';
          if (!path.isAbsolute(file)) {
            // aeval scenarios reference corpus files relative to the data root.
            const resolved = opts.resolveRelativeFile?.(file) ?? null;
            if (!resolved) return `audio.play file not resolvable: ${file}`;
            file = resolved;
          }
          out.push({ type: 'audio.play', id: id(), file, description: step.description });
          continue;
        }
        case 'lab.trace': {
          // aeval lab bookkeeping (case/sample markers). Mapped to DialF's log
          // step; the marker text ALSO rides `description` because outcomes
          // echo it — computePhoneRateEntries parses case ids from there.
          const marker = ['trace', step.event, step.case_id, step.sample_id]
            .filter((x) => typeof x === 'string' && x).join(' ');
          out.push({ type: 'log', id: id(), message: marker, description: marker });
          continue;
        }
        case 'audio.wait_for_speech':
          out.push({
            type: 'audio.wait_for_speech', id: id(),
            end_timeout_ms: step.end_timeout_ms ?? DEFAULTS.end_timeout_ms,
            silence_duration_ms: step.silence_duration_ms,
            onset_duration_ms: step.onset_duration_ms,
            description: step.description,
          });
          continue;
        case 'audio.wait_for_speech_start':
          out.push({
            type: 'audio.wait_for_speech_start', id: id(),
            timeout_ms: step.timeout_ms ?? DEFAULTS.timeout_ms,
            wait_after_start_ms: step.wait_after_start_ms,
            description: step.description,
          });
          continue;
        case 'call.dial': {
          // POST-substitution shape check: a templated number passed save-time
          // validation on faith; here the real value must be dialable (blocks
          // USSD codes and anything else outside the number shape).
          if (typeof step.number !== 'string' || !PHONE_NUMBER_RE.test(step.number)) {
            return `call.dial number is not a dialable phone number: '${String(step.number ?? '')}'`;
          }
          // ONE call per job (post-substitution — a for_each over numbers
          // multiplies dials past any raw-text count): a phone eval measures
          // one conversation with one agent, and on marketplace agents each
          // extra dial is toll-fraud surface on someone else's SIM.
          if (out.some((s) => s.type === 'call.dial')) {
            return 'a phone job places exactly ONE call — remove the extra call.dial';
          }
          out.push({ type: 'call.dial', id: id(), number: step.number, description: step.description });
          continue;
        }
        case 'call.wait_answered':
          out.push({
            type: 'call.wait_answered', id: id(),
            timeout_ms: step.timeout_ms ?? DEFAULTS.answer_timeout_ms,
            description: step.description,
          });
          continue;
        case 'call.answer':
          out.push({ type: 'call.answer', id: id(), timeout_ms: step.timeout_ms, description: step.description });
          continue;
        case 'call.hangup':
          out.push({ type: 'call.hangup', id: id(), description: step.description });
          continue;
        case 'restful.request':
          // Orchestrated class — split off BEFORE compilation (session-block
          // rule, Libretto §3). Reaching the compiler means it sat inside the
          // session block, which is illegal.
          return 'restful.request must lead Setup Steps (before the call) — illegal inside the session block';
        case 'control.wait': case 'wait':
          out.push({ type: 'wait', id: id(), ms: step.ms ?? 1000 });
          continue;
        case 'control.log': case 'log':
          out.push({ type: 'log', id: id(), message: String(step.message ?? '') });
          continue;
        case 'control.for_each': {
          let items: unknown[] | null = Array.isArray(step.items) ? step.items : null;
          if (!items && typeof step.corpus_set === 'string') {
            items = opts.resolveCorpusSet?.(step.corpus_set) ?? null;
            if (!items) return `unknown corpus_set: ${step.corpus_set}`;
          }
          if (!items) return 'control.for_each needs items or corpus_set';
          const inner = (raw as Record<string, unknown>).steps;
          if (!Array.isArray(inner)) return 'control.for_each needs steps';
          for (const it of items) {
            const err = emit(inner, it, depth + 1);
            if (err) return err;
          }
          continue;
        }
        default:
          return `unsupported step type for phone transport: '${type}'`;
      }
    }
    return null;
  };

  const err = emit(rawSteps, null);
  if (err) return { ok: false, error: err };
  if (out.length === 0 && opts.segment === 'conversation') {
    return { ok: false, error: 'conversation compiled to zero steps' };
  }
  return { ok: true, steps: out };
}

// ---- script splitter (unified-steps design 2026-09-25 §2) -------------------
// Setup + conversation + teardown form ONE Libretto script. Partition by
// execution class: leading restful.request steps in Setup are orchestrated
// (executed daemon-side via Core, pre-call); everything else is one contiguous
// session block handed to DialF whole (the session-block rule).

export interface SplitScript {
  /** Orchestrated pre-call REST steps, each with its ABSOLUTE index within
   * stepsPrefix — the Core endpoint resolves the template from the frozen
   * snapshot by that index (TOCTOU: the daemon never sends the template). */
  restfulPrecall: Array<{ stepIndex: number }>;
  /** Whether the evalflow's OWN Setup establishes a call (recursive — the
   * compiler unrolls for_each, so the gate must see nested dials too). The
   * gate input: deliberately not derived from the conversation, which is
   * banned from call.* (segment policy in the compiler). */
  setupHasDial: boolean;
  /** The three raw segments, compiled SEPARATELY with per-segment policies
   * (the policy must apply post-substitution — see CompileOpts.segment). */
  setupRaw: unknown[];
  conversationRaw: unknown[];
  teardownRaw: unknown[];
}

export type SplitResult = { ok: true; value: SplitScript } | { ok: false; error: string };

export function splitPhoneScript(
  prefixSteps: unknown[],
  conversationSteps: unknown[],
  suffixSteps: unknown[],
): SplitResult {
  const restfulPrecall: Array<{ stepIndex: number }> = [];
  let firstNonRestful = 0;
  while (
    firstNonRestful < prefixSteps.length &&
    typeof prefixSteps[firstNonRestful] === 'object' && prefixSteps[firstNonRestful] !== null &&
    (prefixSteps[firstNonRestful] as Record<string, unknown>).type === 'restful.request'
  ) {
    restfulPrecall.push({ stepIndex: firstNonRestful });
    firstNonRestful++;
  }
  // Recursive scan (control.for_each nests steps) for step types that are
  // illegal in a given segment — the EARLY, raw-text check with precise
  // errors. SECURITY NOTE: the raw type can be a "${item.x}" placeholder, so
  // this scan alone is evadable; the compiler re-enforces the same policy on
  // the POST-substitution type (CompileOpts.segment) — that one is the
  // boundary. The threat: the conversation comes from the EVAL SET — a
  // different, possibly public-third-party author than the evalflow — and
  // must never place, answer, or end calls on the runner's SIM (a
  // conversation-injected call.dial is toll fraud). Teardown belongs to the
  // evalflow author but runs post-conversation: only call.hangup is
  // meaningful there — a Teardown call.dial would start a SECOND call.
  const findIllegal = (steps: unknown[], offset: number, banned: (type: string) => boolean): string | null => {
    // Bounded + cycle-safe (shared/steps.ts): YAML aliases expand a naive
    // recursive walk exponentially. Budget exceeded fails closed below.
    const result = walkStepList(steps.slice(offset), (step) => {
      const type = typeof step.type === 'string' ? step.type : '';
      return banned(type) ? type : null;
    });
    return result; // illegal type, 'too-complex', or null
  };
  // Strict ordering: restful.request only as a LEADING run of Setup. One found
  // later would execute out of order (pre-call, but written mid-session).
  const tooComplex = (r: string | null) => r === 'too-complex';
  const prefixIllegal = findIllegal(prefixSteps, firstNonRestful, (t) => t === 'restful.request');
  if (tooComplex(prefixIllegal)) return { ok: false, error: 'Setup Steps too complex (aliases/nesting)' };
  if (prefixIllegal) {
    return { ok: false, error: 'restful.request steps must lead Setup Steps — they execute before the call' };
  }
  // Segment bans come from the SHARED policy (shared/steps.ts) — the same
  // rule the compiler re-applies post-substitution, so the raw scan can
  // never drift from the boundary check.
  const convIllegal = findIllegal(conversationSteps, 0, (t) => illegalPhoneStepType(t, 'conversation') !== null);
  if (tooComplex(convIllegal)) return { ok: false, error: 'conversation steps too complex (aliases/nesting)' };
  if (convIllegal) {
    return { ok: false, error: illegalPhoneStepType(convIllegal, 'conversation')! };
  }
  const suffixIllegal = findIllegal(suffixSteps, 0, (t) => illegalPhoneStepType(t, 'teardown') !== null || t === 'restful.request');
  if (tooComplex(suffixIllegal)) return { ok: false, error: 'Teardown Steps too complex (aliases/nesting)' };
  if (suffixIllegal) {
    return { ok: false, error: illegalPhoneStepType(suffixIllegal, 'teardown') ?? `'${suffixIllegal}' is illegal in Teardown Steps` };
  }
  return {
    ok: true,
    value: {
      restfulPrecall,
      // Recursive + bounded (shared/steps.ts): the compiler unrolls for_each,
      // so a nested call.dial in Setup arms the gate; a "${item}" type cannot
      // (only a literal dial counts — templated types fail compile later).
      setupHasDial: stepsContainCallDial(prefixSteps),
      setupRaw: prefixSteps.slice(firstNonRestful),
      conversationRaw: conversationSteps,
      teardownRaw: suffixSteps,
    },
  };
}

/** Safety guarantee (§2, approved Q2 scope): the session block always ENDS the
 * call — append a hangup when the script's own teardown omitted it. */
export function ensureTrailingHangup(steps: DialfStep[]): DialfStep[] {
  if (steps.length > 0 && steps[steps.length - 1].type === 'call.hangup') return steps;
  return [...steps, { type: 'call.hangup', id: 'bye' }];
}

/** Read-timeout for a blocking job.run: the job's own worst case + slack (contract §4). */
export function sumStepTimeouts(steps: DialfStep[]): number {
  let total = TIMEOUT_SLACK_MS;
  for (const s of steps) {
    if (typeof s.end_timeout_ms === 'number') total += s.end_timeout_ms;
    if (typeof s.timeout_ms === 'number') total += s.timeout_ms;
    if (typeof s.wait_after_start_ms === 'number') total += s.wait_after_start_ms;
    if (typeof s.ms === 'number') total += s.ms;
    if (s.type === 'audio.play') total += PLAY_ALLOWANCE_MS;
  }
  return total;
}

// ---- result adapters --------------------------------------------------------

export interface DialfJobResult {
  steps?: Array<Record<string, unknown>>;
  recording?: { rx?: string; tx?: string; mix?: string; t0_epoch_ms?: number };
  call?: {
    answer_latency_ms?: number; duration_ms?: number; end_reason?: string;
    remote_number?: string; sim?: string;
  };
}

/** eval_results.call_metadata shape (design §7; server caps at 4 KB). */
export function toCallMetadata(call: DialfJobResult['call']): Record<string, unknown> | null {
  if (!call) return null;
  const num = call.remote_number ?? '';
  return {
    disposition: call.end_reason ?? 'unknown',
    answeredAfterMs: call.answer_latency_ms ?? null,
    durationMs: call.duration_ms ?? null,
    sim: call.sim ?? null,
    // Redacted per credential-hygiene posture: last 4 digits only.
    fromRedacted: num ? `…${num.replace(/\D/g, '').slice(-4)}` : null,
  };
}

/**
 * Docker↔host bridge (design §6 deployment note): when the daemon runs in a
 * container and dialfd on the host, `audio.play` paths must be readable on the
 * HOST. The exchange dir is bind-mounted at the IDENTICAL absolute path on
 * both sides; this stages every play file into `<exchange>/corpus/` and
 * rewrites the step to the staged path (valid on both sides by construction).
 * Filename collisions across different sources are disambiguated by a short
 * content-path hash. No-op when exchangeDir is null (host-run daemon).
 */
export function stagePlayFiles(steps: DialfStep[], exchangeDir: string | null): DialfStep[] {
  if (!exchangeDir) return steps;
  const corpusDir = path.join(exchangeDir, 'corpus');
  fs.mkdirSync(corpusDir, { recursive: true });
  const stagedBySource = new Map<string, string>();
  return steps.map((s) => {
    if (s.type !== 'audio.play' || typeof s.file !== 'string') return s;
    let staged = stagedBySource.get(s.file);
    if (!staged) {
      const hash = createHash('sha256').update(s.file).digest('hex').slice(0, 8);
      staged = path.join(corpusDir, `${hash}-${path.basename(s.file)}`);
      fs.copyFileSync(s.file, staged);
      stagedBySource.set(s.file, staged);
    }
    return { ...s, file: staged };
  });
}

// ---- rate attribution (TSR on the phone path) -------------------------------

import type { ChunkMetricsEntry } from './chunking';

const MARKER_PREFIX = 'trace case_sample_start';

function turnLevelOf(metrics: Record<string, unknown>, family: string): Record<string, unknown>[] {
  const lat = (metrics[family] as Record<string, unknown> | undefined)?.latency as Record<string, unknown> | undefined;
  return Array.isArray(lat?.turn_level) ? (lat!.turn_level as Record<string, unknown>[]) : [];
}

/**
 * Build the per-case entries `computePerCaseAndRates` consumes — the web path
 * gets them from per-case chunk runs; the phone path derives them by joining
 * two records that share the recording clock (t=0 = recording start):
 *   - DialF step outcomes: the sample markers (log steps carrying the
 *     `lab.trace` text in `description`) give each sample's time window and
 *     case id; a `wait_for_speech_start` inside a window marks an interrupt
 *     sample;
 *   - the enriched metrics (enrichMetricsWithTurns): each response/interrupt
 *     turn carries `turn_start` seconds, assigning it to a sample window.
 * Returns [] when attribution is impossible (no markers, or outcomes without
 * timestamps — dialfd < 0.3.16): latencies still report, rates stay NA.
 */
export function computePhoneRateEntries(
  outcomes: Array<Record<string, unknown>>,
  enrichedMetrics: Record<string, unknown>,
): ChunkMetricsEntry[] {
  const markers = outcomes
    .filter((o) => o.type === 'log' && typeof o.description === 'string'
      && (o.description as string).startsWith(MARKER_PREFIX) && typeof o.t_start_ms === 'number')
    .map((o) => ({
      tMs: o.t_start_ms as number,
      caseId: (o.description as string).split(/\s+/)[2] ?? 'unknown',
    }))
    .sort((a, b) => a.tMs - b.tMs);
  if (markers.length === 0) return [];

  interface Sample { caseId: string; startMs: number; endMs: number; hasInterrupt: boolean }
  const samples: Sample[] = markers.map((m, i) => ({
    caseId: m.caseId,
    startMs: m.tMs,
    endMs: markers[i + 1]?.tMs ?? Number.POSITIVE_INFINITY,
    hasInterrupt: false,
  }));
  for (const o of outcomes) {
    if (o.type !== 'audio.wait_for_speech_start' || typeof o.t_start_ms !== 'number') continue;
    const s = samples.find((w) => (o.t_start_ms as number) >= w.startMs && (o.t_start_ms as number) < w.endMs);
    if (s) s.hasInterrupt = true;
  }

  interface CaseAcc { sampleCount: number; hasInterruptPhase: boolean; resp: Record<string, unknown>[]; int: Record<string, unknown>[] }
  const byCase = new Map<string, CaseAcc>();
  for (const s of samples) {
    const acc = byCase.get(s.caseId) ?? { sampleCount: 0, hasInterruptPhase: false, resp: [], int: [] };
    acc.sampleCount += 1;
    acc.hasInterruptPhase = acc.hasInterruptPhase || s.hasInterrupt;
    byCase.set(s.caseId, acc);
  }
  const assign = (family: 'response_metrics' | 'interruption_metrics', bucket: 'resp' | 'int') => {
    for (const turn of turnLevelOf(enrichedMetrics, family)) {
      if (typeof turn.turn_start !== 'number') continue;
      const tMs = (turn.turn_start as number) * 1000;
      const s = samples.find((w) => tMs >= w.startMs && tMs < w.endMs);
      if (s) byCase.get(s.caseId)![bucket].push(turn);
    }
  };
  assign('response_metrics', 'resp');
  assign('interruption_metrics', 'int');

  return Array.from(byCase.entries()).map(([caseId, acc]) => ({
    caseId,
    chunkId: 'call',
    sampleCount: acc.sampleCount,
    hasInterruptPhase: acc.hasInterruptPhase,
    metrics: {
      response_metrics: { latency: { turn_level: acc.resp } },
      interruption_metrics: { latency: { turn_level: acc.int } },
    },
  }));
}

// ---- orchestration ----------------------------------------------------------

export interface PhoneRunDeps {
  /** One-shot DialF op on a dedicated connection (DialfClient.call). */
  dialfCall: (op: string, fields: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;
  /** Execute the Setup restful.request step at stepIndex via Core's trusted
   * endpoint (the template resolves from the FROZEN snapshot there, never
   * here); throws on failure — a failed trigger fails the job pre-call. */
  executeRestful: (stepIndex: number) => Promise<void>;
  /** Best-effort end-the-call rescue on a FRESH DialF connection (job.cancel +
   * call.hangup, errors swallowed) — invoked whenever job.run fails so a
   * script/daemon failure never leaves a carrier call off-hook (§2, Q2). */
  safetyHangup: () => Promise<void>;
  /** Run `aeval analyze <sessionDir>`; throws on non-zero exit. */
  analyze: (sessionDir: string) => Promise<void>;
  /** Parse metrics from the analyzed session dir; null = nothing usable. */
  parseMetrics: (sessionDir: string) => Record<string, unknown> | null;
  /** Working directory for the session layout (job-scoped temp). */
  workDir: string;
}

export interface PhoneRunConfig {
  jobId: number;
  /** Parsed Setup Steps (config.stepsPrefix YAML; [] when absent). */
  prefixSteps: unknown[];
  /** Parsed eval-set conversation steps. */
  scenarioSteps: unknown[];
  /** Parsed Teardown Steps (config.stepsSuffix YAML; [] when absent). */
  suffixSteps: unknown[];
  resolveCorpusFile: CompileOpts['resolveCorpusFile'];
  resolveCorpusSet?: CompileOpts['resolveCorpusSet'];
  resolveRelativeFile?: CompileOpts['resolveRelativeFile'];
  /** Docker↔host bridge dir (VOX_DIALF_EXCHANGE_DIR); null = host-run daemon. */
  exchangeDir?: string | null;
}

export interface PhoneRunOutput {
  result: Record<string, unknown>;
  callMetadata: Record<string, unknown> | null;
  sessionDir: string;
}

/**
 * Execute one phone-transport job end to end: split the unified script
 * (Setup + conversation + Teardown), run orchestrated restful.request steps
 * via Core, hand the session block to DialF whole, analyze the session dir.
 *
 * Direction is the AGENT's perspective: v1 supports the INBOUND mode fully
 * (Setup dials the agent via call.dial). The trigger/OUTBOUND mode (agent
 * dials us after a restful/web trigger) is authorable but deliberately
 * unsupported until DialF exposes a machine-readable result for
 * serve-answered calls or a wait-for-ring step (requirements doc R7): serve
 * event strings are human-only by contract, and racing `call.answer` against
 * the ring is not a foundation.
 */
export async function runPhoneJob(cfg: PhoneRunConfig, deps: PhoneRunDeps): Promise<PhoneRunOutput> {
  const split = splitPhoneScript(cfg.prefixSteps, cfg.scenarioSteps, cfg.suffixSteps);
  if (!split.ok) throw new Error(`phone script split failed: ${split.error}`);

  // Call-establishment gate (mirrors the server's run-route gate — orphaned
  // jobs reach the daemon with only the frozen snapshot config). Setup only:
  // the eval-set conversation is banned from call.* by the splitter.
  if (!split.value.setupHasDial) {
    throw new Error(split.value.restfulPrecall.length > 0
      ? 'agent-outbound trigger mode is not yet supported — pending DialF machine-readable serve results (R7); add a call.dial step'
      : 'phone evalflow Setup Steps establish no call — add a call.dial step');
  }

  // Compile each segment under its own policy (enforced post-substitution —
  // the security boundary for eval-set call.* smuggling via ${item} types).
  const baseOpts = {
    resolveCorpusFile: cfg.resolveCorpusFile,
    resolveCorpusSet: cfg.resolveCorpusSet,
    resolveRelativeFile: cfg.resolveRelativeFile,
  };
  const setup = compilePhoneConversation(split.value.setupRaw, { ...baseOpts, segment: 'setup', idPrefix: 'p' });
  if (!setup.ok) throw new Error(`phone Setup compile failed: ${setup.error}`);
  const conv = compilePhoneConversation(split.value.conversationRaw, { ...baseOpts, segment: 'conversation', idPrefix: 's' });
  if (!conv.ok) throw new Error(`phone conversation compile failed: ${conv.error}`);
  const teardown = compilePhoneConversation(split.value.teardownRaw, { ...baseOpts, segment: 'teardown', idPrefix: 't' });
  if (!teardown.ok) throw new Error(`phone Teardown compile failed: ${teardown.error}`);

  const steps = ensureTrailingHangup(
    stagePlayFiles([...setup.steps, ...conv.steps, ...teardown.steps], cfg.exchangeDir ?? null),
  );
  const timeoutMs = sumStepTimeouts(steps);

  // Orchestrated pre-call actions: any failure fails the job before a dial —
  // no wasted carrier call, no partial results.
  for (const { stepIndex } of split.value.restfulPrecall) {
    await deps.executeRestful(stepIndex);
  }

  // Per-run record_dir (dialfd ≥ 0.3.16) routes this run's recordings into the
  // exchange dir so the container can read them. An older dialfd ignores the
  // field and buildSessionDir then fails on the missing legs — upgrade dialfd.
  const recordDir = cfg.exchangeDir ? path.join(cfg.exchangeDir, 'recordings') : undefined;
  let result: DialfJobResult;
  try {
    result = (await deps.dialfCall(
      'job.run',
      { name: `vox-job-${cfg.jobId}`, steps, ...(recordDir ? { record_dir: recordDir } : {}) },
      timeoutMs,
    )) as DialfJobResult;
  } catch (e) {
    // A read-timeout or transport error can strand a live carrier call —
    // rescue on a fresh connection, then fail the job with the real cause.
    await deps.safetyHangup();
    throw e;
  }

  const disposition = result.call?.end_reason ?? 'unknown';
  // far_end_hangup mid-conversation is a FAILED eval (partial results are never
  // reported — existing policy); completed is the only success disposition.
  if (disposition !== 'completed') {
    // Non-completed dispositions normally mean the call already ended, but a
    // step-level failure can report before the hangup ran — rescue is a cheap
    // idempotent no-op when the line is already down.
    await deps.safetyHangup();
    throw new Error(`call did not complete: disposition=${disposition}`);
  }

  const sessionDir = buildSessionDir(result, deps.workDir);
  await deps.analyze(sessionDir); // throws → job fails (policy)
  const metrics = deps.parseMetrics(sessionDir);
  if (!metrics) throw new Error('analysis produced no usable metrics');

  return { result: metrics, callMetadata: toCallMetadata(result.call), sessionDir };
}

/**
 * Lay the DialF outputs out as a session directory for `aeval analyze`:
 *   <dest>/recordings/  — rx/tx/mix wavs (copied; analyze owns the dir)
 *   <dest>/dialf/steps.json, call.json — step outcomes + call metadata
 * Returns the session dir path, or throws when a referenced wav is missing.
 */
export function buildSessionDir(result: DialfJobResult, destDir: string): string {
  const rec = path.join(destDir, 'recordings');
  fs.mkdirSync(rec, { recursive: true });
  // Exactly ONE recording, and it must be the MIX (stereo: L=user, R=agent —
  // both speakers on one timeline, aeval's single-recording model). No rx
  // fallback: a one-speaker recording yields plausible-looking but WRONG
  // metrics (no user turns to measure latency from), and wrong beats nothing
  // never (failure policy). Mix absence is operator-fixable dialfd config.
  const src = result.recording?.mix;
  if (!src) throw new Error('DialF result has no mix recording — set mix_recording: true in dialfd config');
  if (!fs.existsSync(src)) throw new Error(`recording leg missing on disk: ${src}`);
  fs.copyFileSync(src, path.join(rec, 'recording.wav'));
  const meta = path.join(destDir, 'dialf');
  fs.mkdirSync(meta, { recursive: true });
  fs.writeFileSync(path.join(meta, 'steps.json'), JSON.stringify(result.steps ?? [], null, 2));
  fs.writeFileSync(path.join(meta, 'call.json'), JSON.stringify(result.call ?? {}, null, 2));
  if (result.recording?.t0_epoch_ms !== undefined) {
    fs.writeFileSync(path.join(meta, 't0.json'), JSON.stringify({ t0_epoch_ms: result.recording.t0_epoch_ms }));
  }
  return destDir;
}
