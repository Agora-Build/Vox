/**
 * Phone-eval pure helpers (design 2026-09-21 §6; DialF ≥ v0.3.8 contract):
 * compile an eval-set conversation into a DialF job, size its read timeout,
 * adapt the DialF result into an aeval-analyzable session dir + callMetadata.
 * Everything here is pure or filesystem-only — no sockets, no processes —
 * so the daemon's phone path is testable without hardware.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

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
}

export type CompileResult = { ok: true; steps: DialfStep[] } | { ok: false; error: string };

/** Steps that are web-session vocabulary — never legal inside a phone conversation. */
const WEB_ONLY_PREFIXES = ['platform.', 'browser.'];

/** Allowance per audio.play for unknown clip length when sizing the read timeout. */
const PLAY_ALLOWANCE_MS = 30_000;
/** Fixed overhead: call setup + teardown + daemon slack. */
const TIMEOUT_SLACK_MS = 60_000;

const DEFAULTS = { end_timeout_ms: 45_000, timeout_ms: 15_000, answer_timeout_ms: 30_000 };

export function compilePhoneConversation(rawSteps: unknown[], opts: CompileOpts): CompileResult {
  const out: DialfStep[] = [];
  let n = 0;
  const id = () => `s${++n}`;

  const substitute = (value: unknown, item: unknown): unknown => {
    if (typeof value !== 'string') return value;
    let s = value.split('${item}').join(typeof item === 'string' ? item : '');
    if (item !== null && typeof item === 'object') {
      s = s.replace(/\$\{item\.(\w+)\}/g, (_m, k) => String((item as Record<string, unknown>)[k] ?? _m));
    }
    return s;
  };

  const emit = (steps: unknown[], item: unknown): string | null => {
    for (const raw of steps) {
      if (typeof raw !== 'object' || raw === null) return 'step must be an object';
      const step = Object.fromEntries(
        Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, substitute(v, item)]),
      );
      const type = String(step.type ?? '');
      if (WEB_ONLY_PREFIXES.some((p) => type.startsWith(p))) {
        return `'${type}' is web-session vocabulary — illegal in a phone conversation`;
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
        case 'lab.trace':
          // aeval lab bookkeeping (case/sample markers). Pure metadata — mapped
          // to DialF's log step so the marker survives into the step outcomes
          // (traceability), never dropped silently.
          out.push({
            type: 'log', id: id(),
            message: ['trace', step.event, step.case_id, step.sample_id]
              .filter((x) => typeof x === 'string' && x).join(' '),
          });
          continue;
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
            const err = emit(inner, it);
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
  if (out.length === 0) return { ok: false, error: 'conversation compiled to zero steps' };
  return { ok: true, steps: out };
}

/** Wrap a compiled conversation as an outbound job: dial → wait → conv → hangup. */
export function buildOutboundJob(targetNumber: string, conversation: DialfStep[]): DialfStep[] {
  return [
    { type: 'call.dial', id: 'dial', number: targetNumber },
    { type: 'call.wait_answered', id: 'answered', timeout_ms: DEFAULTS.answer_timeout_ms },
    ...conversation,
    { type: 'call.hangup', id: 'bye' },
  ];
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

// ---- orchestration ----------------------------------------------------------

export interface PhoneRunDeps {
  /** One-shot DialF op on a dedicated connection (DialfClient.call). */
  dialfCall: (op: string, fields: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;
  /** Run `aeval analyze <sessionDir>`; throws on non-zero exit. */
  analyze: (sessionDir: string) => Promise<void>;
  /** Parse metrics from the analyzed session dir; null = nothing usable. */
  parseMetrics: (sessionDir: string) => Record<string, unknown> | null;
  /** Working directory for the session layout (job-scoped temp). */
  workDir: string;
}

export interface PhoneRunConfig {
  jobId: number;
  scenarioSteps: unknown[];
  /** Outbound mode: we call the agent (design §4 — "We call the agent"). */
  phoneDial?: { number: string };
  /** Trigger mode flag (agent calls us) — NOT yet supported, see below. */
  hasRestfulTrigger: boolean;
  resolveCorpusFile: CompileOpts['resolveCorpusFile'];
  resolveCorpusSet?: CompileOpts['resolveCorpusSet'];
  resolveRelativeFile?: CompileOpts['resolveRelativeFile'];
  /** Docker↔host bridge dir (VOX_PHONE_EXCHANGE_DIR); null = host-run daemon. */
  exchangeDir?: string | null;
}

export interface PhoneRunOutput {
  result: Record<string, unknown>;
  callMetadata: Record<string, unknown> | null;
  sessionDir: string;
}

/**
 * Execute one phone-transport job end to end. v1 supports the OUTBOUND mode
 * fully (dial → conversation → structured result → analyze). The
 * trigger/inbound mode (agent dials us after a browser/restful trigger) is
 * deliberately unsupported until DialF exposes a machine-readable result for
 * serve-answered calls or a wait-for-ring step (requirements doc R7): serve
 * event strings are human-only by contract, and racing `call.answer` against
 * the ring is not a foundation.
 */
export async function runPhoneJob(cfg: PhoneRunConfig, deps: PhoneRunDeps): Promise<PhoneRunOutput> {
  if (!cfg.phoneDial?.number) {
    throw new Error(cfg.hasRestfulTrigger
      ? 'phone trigger mode (agent calls us) is not yet supported — pending DialF machine-readable serve results (R7); use phoneDial'
      : 'phone workflow config needs phoneDial.number');
  }
  const compiled = compilePhoneConversation(cfg.scenarioSteps, {
    resolveCorpusFile: cfg.resolveCorpusFile,
    resolveCorpusSet: cfg.resolveCorpusSet,
    resolveRelativeFile: cfg.resolveRelativeFile,
  });
  if (!compiled.ok) throw new Error(`phone conversation compile failed: ${compiled.error}`);

  const conversation = stagePlayFiles(compiled.steps, cfg.exchangeDir ?? null);
  const steps = buildOutboundJob(cfg.phoneDial.number, conversation);
  const timeoutMs = sumStepTimeouts(steps);
  const result = (await deps.dialfCall(
    'job.run',
    { name: `vox-job-${cfg.jobId}`, steps },
    timeoutMs,
  )) as DialfJobResult;

  const disposition = result.call?.end_reason ?? 'unknown';
  // far_end_hangup mid-conversation is a FAILED eval (partial results are never
  // reported — existing policy); completed is the only success disposition.
  if (disposition !== 'completed') {
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
  const legs: Array<[string, string | undefined]> = [
    ['rx.wav', result.recording?.rx],
    ['tx.wav', result.recording?.tx],
    ['mix.wav', result.recording?.mix],
  ];
  let copied = 0;
  for (const [name, src] of legs) {
    if (!src) continue;
    if (!fs.existsSync(src)) throw new Error(`recording leg missing on disk: ${src}`);
    fs.copyFileSync(src, path.join(rec, name));
    copied++;
  }
  if (copied === 0) throw new Error('DialF result carried no recordings');
  const meta = path.join(destDir, 'dialf');
  fs.mkdirSync(meta, { recursive: true });
  fs.writeFileSync(path.join(meta, 'steps.json'), JSON.stringify(result.steps ?? [], null, 2));
  fs.writeFileSync(path.join(meta, 'call.json'), JSON.stringify(result.call ?? {}, null, 2));
  if (result.recording?.t0_epoch_ms !== undefined) {
    fs.writeFileSync(path.join(meta, 't0.json'), JSON.stringify({ t0_epoch_ms: result.recording.t0_epoch_ms }));
  }
  return destDir;
}
