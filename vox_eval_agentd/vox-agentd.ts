#!/usr/bin/env npx tsx
/**
 * vox-agentd - Vox Evaluation Agent Daemon
 *
 * A standalone process that:
 * 1. Registers with Vox server using a token
 * 2. Sends periodic heartbeats
 * 3. Fetches and claims pending jobs
 * 4. Executes evaluation tests using aeval or voice-agent-tester
 * 5. Reports results back to the server
 *
 * Supports two eval frameworks:
 *   "aeval"                (default) - single-binary eval with JSON metrics
 *   "voice-agent-tester"   - Node/Puppeteer eval with CSV report
 *
 * Config resolution (CLI args take precedence over env vars):
 *   token     = --token  || AGENT_TOKEN
 *   server    = --server || VOX_SERVER || 'http://localhost:5000'
 *   name      = --name   || VOX_AGENT_NAME || ''
 *   framework = EVAL_FRAMEWORK || 'aeval'
 *   headless  = HEADLESS !== 'false'  (default true)
 *
 * Usage:
 *   npx tsx vox_eval_agentd/vox-agentd.ts --token <TOKEN> [--server <URL>] [--name <NAME>]
 *
 * Docker:
 *   node vox-agentd.js  (compiled by esbuild, configured via env vars)
 */

import { spawn } from 'child_process';
import { createServer, type Server as HttpServer } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { SECRET_PLACEHOLDER_REGEX } from '../shared/secrets';
import yaml from 'js-yaml';
import {
  CHUNK_SIZE,
  type ParsedScenario,
  type ScenarioStep,
  type SampleGroup,
  type ChunkGroup,
  type ChunkMetricsEntry,
  INTERRUPT_ACTION_MAX_MS,
  sanitizeForFilename,
  extractSampleGroups,
  groupSamplesByChunk,
  groupHasInterruptPhase,
  buildChunkYaml,
  composeScenarioYaml,
  mergeChunkMetrics,
  computePerCaseAndRates,
  enrichMetricsWithTurns,
  parseTurnsJson,
  headlineLatencyVals,
} from './chunking';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EvalAgent {
  id: number;
  name: string;
  region: string;
  state: string;
  leaseId?: string;
}

interface EvalJob {
  id: number;
  workflowId: number;
  evalSetId: number | null;
  region: string;
  status: string;
  config: Record<string, unknown> | null;
}

interface EvalResult {
  responseLatencyMedian: number;
  responseLatencySd: number;
  responseLatencyP95: number;
  interruptLatencyMedian: number;
  interruptLatencySd: number;
  interruptLatencyP95: number;
  // Cross-chunk rates (0..1); null when sample counts are unknown (e.g.
  // control.for_each bodies) or no case of that kind ran.
  responseRate: number | null;
  interruptRate: number | null;
  falseInterruptRate: number | null;
  networkResilience: number;
  naturalness: number;
  noiseReduction: number;
  rawData?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface DaemonConfig {
  token: string;
  serverUrl: string;
  name: string;
  framework: string;
  headless: boolean;
}

const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const JOB_POLL_INTERVAL = 10000;  // 10 seconds
// Hard ceiling on a single `aeval` invocation (per chunk — a chunked job runs
// one invocation per chunk, each bounded separately). Without it, a hung run
// (e.g. a login/select_agent step that never resolves) pins the daemon
// "occupied" forever — never completing, never claiming new work. On timeout we
// SIGTERM then SIGKILL the process group so the run fails, the job is released,
// and the agent frees up.
const AEVAL_RUN_TIMEOUT_MS = (() => {
  const v = Number(process.env.AEVAL_RUN_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 20 * 60 * 1000; // default 20 min; ignore junk/negative
})();

const VOICE_AGENT_TESTER_PATH = path.resolve(__dirname, 'voice-agent-tester');
const AEVAL_DATA_PATH = path.resolve(__dirname, 'aeval-data');

// Shorten BUILD_TAG: "main/abc123def456..." → "main/abc123d"
function shortBuildTag(): string {
  const raw = process.env.BUILD_TAG || 'dev';
  const slash = raw.indexOf('/');
  if (slash > 0 && raw.length - slash > 8) {
    return raw.slice(0, slash) + '/' + raw.slice(slash + 1, slash + 8);
  }
  return raw;
}

const RESULT_DEFAULTS: EvalResult = {
  responseLatencyMedian: 0,
  responseLatencySd: 0,
  responseLatencyP95: 0,
  interruptLatencyMedian: 0,
  interruptLatencySd: 0,
  interruptLatencyP95: 0,
  responseRate: null,
  interruptRate: null,
  falseInterruptRate: null,
  networkResilience: 85,
  naturalness: 3.5,
  noiseReduction: 90,
};

// ---------------------------------------------------------------------------
// Daemon class
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// S3 Upload Types
// ---------------------------------------------------------------------------

interface UploadTask {
  jobId: number;
  // All aeval output dirs produced for this job — one per chunk for chunked
  // runs, a single entry otherwise.
  outputDirs: string[];
  scenarioName: string;
  retries: number;
}

const MAX_UPLOAD_RETRIES = 2;
const MAX_UPLOAD_QUEUE_SIZE = 50;

interface S3Config {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

// System-default S3 config from env vars
function getSystemS3Config(): S3Config | null {
  const endpoint = process.env.S3_ENDPOINT;
  const bucket = process.env.S3_BUCKET;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;

  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;

  return {
    endpoint,
    bucket,
    region: process.env.S3_REGION || 'auto',
    accessKeyId,
    secretAccessKey,
  };
}

class VoxEvalAgentDaemon {
  private config: DaemonConfig;
  private agentId: number | null = null;
  private leaseId: string | null = null;
  private region: string | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private jobPollTimer: NodeJS.Timeout | null = null;
  private isRunningJob = false;
  private aevalVersion: string = "unknown";
  private uploadQueue: UploadTask[] = [];
  private isUploading = false;
  private s3Warned = false;
  private lastOutputDir: string | null = null;
  // Every output dir produced during the current job (one per chunk run), so
  // artifact upload covers ALL chunks — not just the last one.
  private jobOutputDirs: string[] = [];
  private healthServer: HttpServer | null = null;
  private startTime = Date.now();
  private currentJobId: number | null = null;

  constructor(config: DaemonConfig) {
    this.config = config;
  }

  // -------------------------------------------------------------------------
  // Version detection
  // -------------------------------------------------------------------------

  /**
   * Detect the installed aeval version by running `aeval --version`.
   * Falls back to "unknown" if the command fails.
   */
  async detectAevalVersion(): Promise<string> {
    try {
      const proc = spawn('aeval', ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
        timeout: 30000,
      });

      let output = '';
      proc.stdout.on('data', (data) => { output += data.toString(); });
      proc.stderr.on('data', (data) => { output += data.toString(); });

      const code = await new Promise<number | null>((resolve) => {
        proc.on('close', resolve);
        proc.on('error', () => resolve(null));
      });

      if (code === 0 && output.trim()) {
        // Expected: last line is "aeval 0.1.4" or "aeval v0.1.4"
        const match = output.match(/aeval\s+v?(\d+\.\d+\.\d+)/);
        if (match) {
          this.aevalVersion = `v${match[1]}`;
          return this.aevalVersion;
        }
      }
    } catch {
      // ignore — fall through to "unknown"
    }

    this.aevalVersion = "unknown";
    return this.aevalVersion;
  }

  // -------------------------------------------------------------------------
  // HTTP helpers
  // -------------------------------------------------------------------------

  private async fetch(urlPath: string, options: RequestInit = {}): Promise<Response> {
    const url = `${this.config.serverUrl}${urlPath}`;
    return fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.token}`,
        ...options.headers,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Registration & heartbeat
  // -------------------------------------------------------------------------

  private buildMetadata(): Record<string, string> {
    const metadata: Record<string, string> = {
      framework: this.config.framework,
      buildTag: shortBuildTag(),
      buildDate: process.env.BUILD_DATE || 'unknown',
    };
    if (this.aevalVersion !== "unknown") {
      metadata.frameworkVersion = this.aevalVersion;
    }
    if (process.env.AEVAL_DATA_COMMIT && process.env.AEVAL_DATA_COMMIT !== 'unknown') {
      metadata.aevalDataCommit = process.env.AEVAL_DATA_COMMIT;
      if (process.env.AEVAL_DATA_DATE && process.env.AEVAL_DATA_DATE !== 'unknown') {
        metadata.aevalDataDate = process.env.AEVAL_DATA_DATE;
      }
    }
    return metadata;
  }

  async register(): Promise<boolean> {
    console.log(`[Daemon] Registering with Vox server: ${this.config.serverUrl}`);

    try {
      const metadata = this.buildMetadata();

      const response = await this.fetch('/api/eval-agent/register', {
        method: 'POST',
        body: JSON.stringify({ name: this.config.name, metadata }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error(`[Daemon] Registration failed: ${response.status} - ${error}`);
        return false;
      }

      const agent: EvalAgent = await response.json();
      this.agentId = agent.id;
      this.region = agent.region;
      this.leaseId = agent.leaseId ?? null;

      console.log(`[Daemon] Registered successfully!`);
      console.log(`  - Agent ID: ${agent.id}`);
      console.log(`  - Name: ${agent.name}`);
      console.log(`  - Region: ${agent.region}`);

      // Reset any artifact uploads stuck in 'uploading' from a previous run
      try {
        const resetRes = await this.fetch('/api/eval-agent/artifacts/reset-stuck', { method: 'POST' });
        if (resetRes.ok) {
          const { reset } = await resetRes.json();
          if (reset > 0) console.log(`[Daemon] Reset ${reset} stuck artifact upload(s) to failed`);
        }
      } catch { /* non-fatal */ }

      return true;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Daemon] Registration error:`, msg);
      return false;
    }
  }

  // A 403 with { superseded: true } means another instance (same token) took
  // over the lease — this process is fenced and must stop. Uses response.clone()
  // so the caller can still read the body.
  private async exitIfSuperseded(response: Response): Promise<void> {
    if (response.status !== 403) return;
    try {
      const body = await response.clone().json() as { superseded?: boolean };
      if (body?.superseded) {
        console.error('[Daemon] Superseded by a newer instance on the same token — exiting.');
        this.stop();
        process.exit(1);
      }
    } catch { /* not a superseded response */ }
  }

  async sendHeartbeat(): Promise<void> {
    if (!this.agentId) return;

    try {
      const response = await this.fetch('/api/eval-agent/heartbeat', {
        method: 'POST',
        body: JSON.stringify({
          agentId: this.agentId,
          leaseId: this.leaseId,
          state: this.isRunningJob ? 'occupied' : 'idle',
          metadata: this.buildMetadata(),
        }),
      });

      await this.exitIfSuperseded(response);
      if (response.ok) {
        console.log(`[Daemon] Heartbeat sent (state: ${this.isRunningJob ? 'occupied' : 'idle'})`);
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Daemon] Heartbeat error:`, msg);
    }
  }

  // -------------------------------------------------------------------------
  // Job queue
  // -------------------------------------------------------------------------

  async fetchJobs(): Promise<EvalJob[]> {
    if (!this.region) return [];

    try {
      const response = await this.fetch(`/api/eval-agent/jobs?region=${this.region}`);
      if (!response.ok) return [];
      return await response.json();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Daemon] Error fetching jobs:`, msg);
      return [];
    }
  }

  async claimJob(jobId: number): Promise<boolean> {
    try {
      const response = await this.fetch(`/api/eval-agent/jobs/${jobId}/claim`, {
        method: 'POST',
        body: JSON.stringify({ agentId: this.agentId, leaseId: this.leaseId }),
      });

      await this.exitIfSuperseded(response);
      if (!response.ok) {
        console.error(`[Daemon] Failed to claim job ${jobId}`);
        return false;
      }

      console.log(`[Daemon] Claimed job ${jobId}`);
      return true;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Daemon] Error claiming job:`, msg);
      return false;
    }
  }

  async completeJob(jobId: number, results: EvalResult): Promise<boolean> {
    try {
      console.log(`[Daemon] Completing job ${jobId}...`);
      const response = await this.fetch(`/api/eval-agent/jobs/${jobId}/complete`, {
        method: 'POST',
        body: JSON.stringify({ agentId: this.agentId, leaseId: this.leaseId, results }),
      });

      await this.exitIfSuperseded(response);
      if (response.ok) {
        console.log(`[Daemon] Job ${jobId} completed successfully`);
        return true;
      } else {
        const error = await response.text();
        console.error(`[Daemon] Failed to complete job ${jobId}: ${response.status} - ${error}`);
        return false;
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Daemon] Error completing job:`, msg);
      return false;
    }
  }

  async completeJobWithPartialResults(jobId: number, results: EvalResult, reason: string): Promise<boolean> {
    try {
      console.log(`[Daemon] Failing job ${jobId} with partial metrics...`);
      const response = await this.fetch(`/api/eval-agent/jobs/${jobId}/complete`, {
        method: 'POST',
        body: JSON.stringify({ agentId: this.agentId, leaseId: this.leaseId, results, error: reason }),
      });

      await this.exitIfSuperseded(response);
      if (response.ok) {
        console.log(`[Daemon] Job ${jobId} failed with partial metrics saved`);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async failJob(jobId: number, reason: string): Promise<boolean> {
    try {
      console.log(`[Daemon] Failing job ${jobId}: ${reason}`);
      const response = await this.fetch(`/api/eval-agent/jobs/${jobId}/complete`, {
        method: 'POST',
        body: JSON.stringify({ agentId: this.agentId, leaseId: this.leaseId, error: reason }),
      });

      await this.exitIfSuperseded(response);
      if (response.ok) {
        console.log(`[Daemon] Job ${jobId} marked as failed`);
        return true;
      } else {
        const error = await response.text();
        console.error(`[Daemon] Failed to report job failure ${jobId}: ${response.status} - ${error}`);
        return false;
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Daemon] Error reporting job failure:`, msg);
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Secrets
  // -------------------------------------------------------------------------

  async fetchSecrets(jobId: number): Promise<Record<string, string>> {
    try {
      const response = await this.fetch(`/api/eval-agent/jobs/${jobId}/secrets`);
      if (!response.ok) {
        if (response.status === 500) {
          console.warn(`[Daemon] Server encryption not configured — skipping secrets`);
          return {};
        }
        console.warn(`[Daemon] Failed to fetch secrets for job ${jobId}: ${response.status}`);
        return {};
      }
      const secrets: Record<string, string> = await response.json();
      const count = Object.keys(secrets).length;
      if (count > 0) {
        console.log(`[Daemon] Fetched ${count} secret(s) for job ${jobId}`);
      }
      return secrets;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[Daemon] Error fetching secrets:`, msg);
      return {};
    }
  }

  private resolveSecrets(content: string, secrets: Record<string, string>): string {
    return content.replace(SECRET_PLACEHOLDER_REGEX, (_match, key) => {
      if (key in secrets) {
        // Always double-quote and escape for valid YAML
        const escaped = secrets[key]
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/\n/g, '\\n')
          .replace(/\r/g, '\\r')
          .replace(/\t/g, '\\t')
          .replace(/\0/g, '\\0');
        return `"${escaped}"`;
      }
      console.warn(`[Daemon] Secret placeholder \${secrets.${key}} not found — leaving as-is`);
      return _match;
    });
  }

  // -------------------------------------------------------------------------
  // aeval framework
  // -------------------------------------------------------------------------

  /**
   * Execute aeval, splitting a lab.trace body into one file per (case_id,
   * chunk_id) — the file boundaries come from the data — then running each
   * sequentially and merging results. Bodies that aren't clean lab.trace
   * samples (e.g. control.for_each) run as a single composed file.
   */
  private async executeAevalWithChunking(
    scenario: string,
    config: { stepsPrefix?: string; stepsSuffix?: string },
    tempFiles: (string | null)[],
  ): Promise<EvalResult> {
    const parsed = yaml.load(scenario) as ParsedScenario;
    if (!parsed?.steps || !Array.isArray(parsed.steps)) {
      // No steps to split — run as-is
      const scenarioConfig = this.writeTempYaml(scenario, 'vox-scenario')!;
      tempFiles.push(scenarioConfig);
      return this.runAeval(scenarioConfig);
    }

    const hasWorkflowComposition = !!(config.stepsPrefix || config.stepsSuffix);

    // Parse workflow setup/teardown (from the workflow config), if provided.
    let workflowPrefix: ScenarioStep[] = [];
    let workflowSuffix: ScenarioStep[] = [];
    if (config.stepsPrefix) {
      const p = yaml.load(config.stepsPrefix);
      if (Array.isArray(p)) workflowPrefix = p as ScenarioStep[];
    }
    if (config.stepsSuffix) {
      const s = yaml.load(config.stepsSuffix);
      if (Array.isArray(s)) workflowSuffix = s as ScenarioStep[];
    }

    const { prefixSteps, suffixSteps, samples } = extractSampleGroups(parsed.steps);

    if (hasWorkflowComposition) {
      // The eval set provides ONLY the body; the workflow provides setup/teardown.
      if (parsed.steps.length === 0) {
        throw new Error('Eval set scenario has no steps — nothing to run');
      }
      // Chunk only when the body is a clean set of lab.trace samples with no
      // leading/trailing non-sample steps. Otherwise (control.for_each, mixed,
      // or no lab.trace) compose the whole body into ONE file so nothing is lost.
      const canChunk = samples.length > 0 && prefixSteps.length === 0 && suffixSteps.length === 0;
      if (canChunk) {
        return this.runChunked(parsed, workflowPrefix, samples, workflowSuffix, tempFiles);
      }
      const composed = composeScenarioYaml(parsed, workflowPrefix, parsed.steps, workflowSuffix);
      const f = this.writeTempYaml(composed, 'vox-scenario')!;
      tempFiles.push(f);
      return this.runAeval(f);
    }

    // No workflow composition → eval set is self-contained (backward compat).
    // Files are defined by the data's (case_id, chunk_id); no size-based split.
    const groups = groupSamplesByChunk(samples);
    const hasPerCaseAnalysis = !!(parsed.params?.lab as Record<string, unknown> | undefined)?.cases;

    // Fast path: a single group AND no per-case analysis remap → run the
    // ORIGINAL scenario verbatim (avoids buildChunkYaml renaming/dropping
    // top-level fields). With per-case analysis we must rebuild so each file
    // gets its case's preset.
    if (groups.length <= 1 && !hasPerCaseAnalysis) {
      const scenarioConfig = this.writeTempYaml(scenario, 'vox-scenario')!;
      tempFiles.push(scenarioConfig);
      const result = await this.runAeval(scenarioConfig);
      // Rates need sample counts, which only exist for lab.trace bodies.
      if (groups.length === 1 && result.rawData && typeof result.rawData === 'object') {
        this.attachRates(result, [{
          caseId: groups[0].caseId,
          chunkId: groups[0].chunkId,
          sampleCount: groups[0].samples.length,
          hasInterruptPhase: groupHasInterruptPhase(groups[0]),
          metrics: result.rawData as Record<string, unknown>,
        }]);
      }
      return result;
    }

    return this.runChunked(parsed, prefixSteps, samples, suffixSteps, tempFiles);
  }

  /**
   * Split samples into one aeval file per (case_id, chunk_id) — the file
   * boundaries come from the data — run each sequentially, and merge the
   * per-chunk metrics into one result. Each chunk is wrapped with the given
   * setup/teardown steps and gets its case's analysis preset. A group larger
   * than CHUNK_SIZE is run as-is with a warning (no forced split).
   */
  private async runChunked(
    parsed: ParsedScenario,
    setupSteps: ScenarioStep[],
    samples: SampleGroup[],
    teardownSteps: ScenarioStep[],
    tempFiles: (string | null)[],
  ): Promise<EvalResult> {
    const groups = groupSamplesByChunk(samples);
    const chunkFiles: { group: ChunkGroup; file: string }[] = [];
    for (const g of groups) {
      if (g.samples.length > CHUNK_SIZE) {
        console.warn(`[Daemon] Chunk ${g.caseId}/${g.chunkId} has ${g.samples.length} samples (recommended max ${CHUNK_SIZE}) — running as one file`);
      }
      const chunkYaml = buildChunkYaml(parsed, setupSteps, g.samples, teardownSteps, g.caseId, g.chunkId);
      // Sanitize case_id/chunk_id before using them in the temp filename —
      // untrusted input from job YAML must not enable path traversal.
      const safePrefix = `vox-${sanitizeForFilename(g.caseId)}-${sanitizeForFilename(g.chunkId)}`;
      const chunkFile = this.writeTempYaml(chunkYaml, safePrefix)!;
      tempFiles.push(chunkFile);
      chunkFiles.push({ group: g, file: chunkFile });
    }

    if (chunkFiles.length === 0) {
      throw new Error('No samples to run after grouping by case_id/chunk_id');
    }

    const caseCount = new Set(groups.map(g => g.caseId)).size;
    console.log(`[Daemon] Split ${samples.length} samples (${caseCount} case(s)) into ${chunkFiles.length} file(s)`);

    const entries: ChunkMetricsEntry[] = [];
    const chunkResults: EvalResult[] = [];

    for (let i = 0; i < chunkFiles.length; i++) {
      const { group: g, file } = chunkFiles[i];
      console.log(`[Daemon] Running ${g.caseId}/${g.chunkId} (${i + 1}/${chunkFiles.length})`);
      const result = await this.runAeval(file);
      chunkResults.push(result);
      entries.push({
        caseId: g.caseId,
        chunkId: g.chunkId,
        sampleCount: g.samples.length,
        hasInterruptPhase: groupHasInterruptPhase(g),
        metrics: (result.rawData && typeof result.rawData === 'object')
          ? result.rawData as Record<string, unknown> : {},
      });
    }

    console.log(`[Daemon] All ${chunkFiles.length} chunks complete — merging results`);
    const mergedRawData = mergeChunkMetrics(entries);

    // Recompute MED/SD/P95 from merged turn-level data using the existing parser.
    // Random name + 0600 (metrics may contain transcript data).
    const mergedJson = JSON.stringify(mergedRawData);
    const mergedFile = path.join(os.tmpdir(), `vox-merged-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(mergedFile, mergedJson, { encoding: 'utf-8', mode: 0o600 });
    tempFiles.push(mergedFile);

    const mergedResult = this.tryParseMetricsJson(mergedFile);
    const mergedHasData = !!mergedResult &&
      (mergedResult.responseLatencyMedian > 0 || mergedResult.interruptLatencyMedian > 0);
    if (mergedHasData) {
      return mergedResult!;
    }

    // Merge produced no usable turn-level metrics (e.g. aeval emitted only
    // summary data). Fall back to a chunk result that actually has metrics.
    const usableChunk = chunkResults.find(
      r => r.responseLatencyMedian > 0 || r.interruptLatencyMedian > 0,
    );
    if (usableChunk) {
      console.warn('[Daemon] Merged turn-level metrics empty — using a chunk result with data');
      return usableChunk;
    }

    console.warn('[Daemon] No usable metrics from any chunk — returning merged defaults');
    return mergedResult ?? chunkResults[chunkResults.length - 1];
  }

  /**
   * Compute cross-chunk rates + per-case stats from chunk entries and attach
   * them to the result (fields and rawData), without replacing rawData.
   */
  private attachRates(result: EvalResult, entries: ChunkMetricsEntry[]): void {
    const { perCase, rates } = computePerCaseAndRates(entries);
    result.responseRate = rates.response_rate;
    result.interruptRate = rates.interrupt_rate;
    result.falseInterruptRate = rates.false_interrupt_rate;
    if (result.rawData && typeof result.rawData === 'object') {
      (result.rawData as Record<string, unknown>).per_case = perCase;
      (result.rawData as Record<string, unknown>).rates = rates;
    }
  }

  private runAeval(scenarioConfig: string): Promise<EvalResult> {
    return new Promise((resolve, reject) => {
      const args = ['run', scenarioConfig];

      if (!this.config.headless) {
        args.push('--headful');
      }

      console.log(`[Daemon] Running: aeval ${args.join(' ')}`);

      // detached: run aeval as its own process-group leader so a timeout can
      // kill the whole tree (aeval + the browser/driver children it spawns).
      // Killing only the parent would orphan those children, and because they
      // inherit the stdio pipes, 'close' would never fire → the promise (and the
      // agent) would stay hung despite the timeout.
      const proc = spawn('aeval', args, {
        cwd: AEVAL_DATA_PATH,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });

      let stdout = '';
      let stderr = '';

      // Signal the whole process group (negative pid); if the group send fails
      // (unsupported / already gone), fall back to signalling the direct child.
      const killTree = (signal: NodeJS.Signals) => {
        try {
          if (proc.pid) { process.kill(-proc.pid, signal); return; }
        } catch { /* group send failed — fall through to a direct kill */ }
        try { proc.kill(signal); } catch { /* already gone */ }
      };

      // Settle exactly once. The forced-deadline timer below can reject even if
      // 'close' never fires (a surviving descendant holding the stdio pipes),
      // so the agent is guaranteed to free up.
      let settled = false;
      let sigkillTimer: NodeJS.Timeout | null = null;
      let forceTimer: NodeJS.Timeout | null = null;
      const clearTimers = () => {
        clearTimeout(killTimer);
        if (sigkillTimer) clearTimeout(sigkillTimer);
        if (forceTimer) clearTimeout(forceTimer);
      };
      const finish = (fn: (v: EvalResult) => void, v: EvalResult) => {
        if (settled) return; settled = true; clearTimers(); fn(v);
      };
      const fail = (err: Error) => {
        if (settled) return; settled = true; clearTimers(); reject(err);
      };

      // Kill a run that overruns the ceiling so it can't pin the agent forever.
      let timedOut = false;
      const killTimer = setTimeout(() => {
        timedOut = true;
        console.error(`[Daemon] aeval run exceeded ${AEVAL_RUN_TIMEOUT_MS}ms — terminating`);
        killTree('SIGTERM');
        sigkillTimer = setTimeout(() => {
          killTree('SIGKILL');
          // Last resort: if 'close' still hasn't fired (a descendant is holding
          // the pipes open), destroy the streams and settle anyway.
          forceTimer = setTimeout(() => {
            try { proc.stdout?.destroy(); proc.stderr?.destroy(); } catch { /* ignore */ }
            console.error(`[Daemon] aeval did not exit after SIGKILL — forcing job failure`);
            const err = new Error(`aeval timed out after ${AEVAL_RUN_TIMEOUT_MS}ms (forced)`) as Error & { partialResults?: EvalResult };
            fail(err);
          }, 15000);
        }, 10000);
      }, AEVAL_RUN_TIMEOUT_MS);

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
        console.log(`[aeval] ${data.toString().trim()}`);
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
        console.error(`[aeval] ${data.toString().trim()}`);
      });

      proc.on('close', (code) => {
        if (settled) return; // already force-failed by the deadline
        console.log(`[Daemon] aeval exited with code ${code}${timedOut ? ' (timed out)' : ''}`);

        // Always resolve output dir (artifacts exist even on failure)
        const allOutput = stdout + stderr;
        try {
          this.lastOutputDir = this.resolveAevalOutputDir(scenarioConfig, allOutput);
          if (this.lastOutputDir && !this.jobOutputDirs.includes(this.lastOutputDir)) {
            this.jobOutputDirs.push(this.lastOutputDir);
          }
        } catch { /* best effort */ }

        if (timedOut || code !== 0) {
          // Try to salvage partial results (metrics.json may exist even on failure)
          let partialResults: EvalResult | null = null;
          if (this.lastOutputDir) {
            try {
              const partial = this.parseAevalResults(this.lastOutputDir, allOutput);
              if (partial.responseLatencyMedian > 0 || partial.interruptLatencyMedian > 0) {
                partialResults = partial;
                console.log(`[Daemon] Salvaged partial metrics from failed run:`, partial);
              }
            } catch { /* no usable data */ }
          }
          const reason = timedOut
            ? `aeval timed out after ${AEVAL_RUN_TIMEOUT_MS}ms`
            : `aeval exited with code ${code}: ${stderr.trim().split('\n').pop() || 'unknown error'}`;
          const error = new Error(reason) as Error & { partialResults?: EvalResult };
          error.partialResults = partialResults;
          fail(error);
          return;
        }

        const outputDir = this.lastOutputDir!;
        const results = this.parseAevalResults(outputDir, allOutput);
        finish(resolve, results);
      });

      proc.on('error', (error) => {
        fail(error);
      });
    });
  }

  /**
   * Resolve the aeval session output directory.
   * aeval writes to: output/<scenario-basename>/<session-id>/
   * We find the most recent session directory, or parse it from stdout.
   */
  private resolveAevalOutputDir(scenarioConfig: string, stdout: string): string {
    const scenarioBasename = path.basename(scenarioConfig, path.extname(scenarioConfig));
    const scenarioDir = path.join(AEVAL_DATA_PATH, 'output', scenarioBasename);

    // Try to extract session directory from stdout: "Session directory: output/.../<session-id>"
    const sessionMatch = stdout.match(/Session directory:\s*(.+)/);
    if (sessionMatch) {
      const sessionPath = sessionMatch[1].trim();
      // Could be relative (output/...) or absolute
      const resolved = path.isAbsolute(sessionPath)
        ? sessionPath
        : path.join(AEVAL_DATA_PATH, sessionPath);
      if (fs.existsSync(resolved)) {
        console.log(`[Daemon] Resolved aeval session dir from stdout: ${resolved}`);
        return resolved;
      }
    }

    // Fallback: find the most recent session directory (sorted by name = timestamp)
    if (fs.existsSync(scenarioDir)) {
      const entries = fs.readdirSync(scenarioDir)
        .filter((e) => fs.statSync(path.join(scenarioDir, e)).isDirectory())
        .sort()
        .reverse();
      if (entries.length > 0) {
        const sessionDir = path.join(scenarioDir, entries[0]);
        console.log(`[Daemon] Resolved aeval session dir (latest): ${sessionDir}`);
        return sessionDir;
      }
    }

    // Last resort: return the scenario-level directory
    return scenarioDir;
  }

  /**
   * Parse aeval's output into Vox result schema.
   *
   * Search order:
   *   1. metrics.json  — json_exporter analysis output (has computed latencies)
   *   2. report.json   — session report (may contain step execution timing)
   *   3. stdout        — extract timing from step execution logs
   */
  private parseAevalResults(outputDir: string, stdout: string): EvalResult {
    // List session dir contents for debugging
    if (fs.existsSync(outputDir)) {
      try {
        const files = fs.readdirSync(outputDir);
        console.log(`[Daemon] Session dir contents: ${files.join(', ')}`);
      } catch { /* ignore */ }
    }

    // Priority 1: metrics.json — the analysis pipeline's computed output
    for (const candidate of [
      path.join(outputDir, 'metrics.json'),
      path.join(outputDir, 'analysis', 'metrics.json'),
    ]) {
      if (fs.existsSync(candidate)) {
        const results = this.tryParseMetricsJson(candidate);
        if (results && (results.responseLatencyMedian > 0 || results.interruptLatencyMedian > 0)) {
          // Best-effort: join turn boundaries + STT transcripts from the
          // sibling turns.json onto the turn-level data.
          try {
            const turnsPath = path.join(path.dirname(candidate), 'turns.json');
            if (results.rawData && fs.existsSync(turnsPath)) {
              const turns = parseTurnsJson(fs.readFileSync(turnsPath, 'utf-8'));
              if (turns) enrichMetricsWithTurns(results.rawData as Record<string, unknown>, turns);
            }
          } catch { /* transcripts are optional */ }
          console.log(`[Daemon] Parsed aeval results (${path.basename(candidate)}):`, results);
          return results;
        }
      }
    }

    // Priority 2: report.json — session report with step execution data
    const reportJson = path.join(outputDir, 'report.json');
    if (fs.existsSync(reportJson)) {
      const results = this.tryParseReportJson(reportJson);
      if (results && (results.responseLatencyMedian > 0 || results.interruptLatencyMedian > 0)) {
        console.log(`[Daemon] Parsed aeval results (report.json step timing):`, results);
        return results;
      }
    }

    // Priority 3: stdout — extract timing from step execution logs
    console.warn(`[Daemon] No metrics in output files — falling back to stdout parsing`);
    console.warn(`[Daemon] (This likely means aeval's analysis pipeline failed)`);
    return this.parseAevalStdout(stdout);
  }

  /**
   * Parse metrics.json (json_exporter output) — has computed latency metrics.
   *
   * Structure (v0.2.1 names; pre-v0.2.1 legacy names in parentheses):
   *   response_metrics.latency:
   *     summary:    { p50_latency_ms, p95_latency_ms, avg_latency_ms, ... }
   *     turn_level: [{ latency_ms, is_greeting, is_barge_in, ... }]
   *   interruption_metrics.latency:
   *     summary:    { p50_interrupt_action_ms (p50_reaction_time_ms), ... }
   *     turn_level: [{ interrupt_action_ms (reaction_time_ms),
   *                    reaction_time_ms_diagnostic — never consulted, ... }]
   *   aggregated_summary:
   *     { avg_response_latency_ms,
   *       avg_interruption_action_ms (avg_interruption_reaction_ms) }
   */
  private tryParseMetricsJson(filePath: string): EvalResult | null {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      console.log(`[Daemon] Reading ${path.basename(filePath)} (${raw.length} bytes)`);
      const metrics = JSON.parse(raw);
      console.log(`[Daemon] ${path.basename(filePath)} top-level keys: ${Object.keys(metrics).join(', ')}`);

      // --- Log raw aeval values ---
      const rlSummary = metrics.response_metrics?.latency?.summary;
      const rlTurns = metrics.response_metrics?.latency?.turn_level;
      const ilSummary = metrics.interruption_metrics?.latency?.summary;
      const ilTurns = metrics.interruption_metrics?.latency?.turn_level;
      const agg = metrics.aggregated_summary;

      console.log(`[Daemon] Raw aeval values:`);
      if (rlSummary) console.log(`[Daemon]   response_metrics.latency.summary: ${JSON.stringify(rlSummary)}`);
      if (rlTurns) console.log(`[Daemon]   response_metrics.latency.turn_level: ${JSON.stringify(rlTurns)}`);
      if (ilSummary) console.log(`[Daemon]   interruption_metrics.latency.summary: ${JSON.stringify(ilSummary)}`);
      if (ilTurns) console.log(`[Daemon]   interruption_metrics.latency.turn_level: ${JSON.stringify(ilTurns)}`);
      if (agg) console.log(`[Daemon]   aggregated_summary: ${JSON.stringify(agg)}`);

      const results: EvalResult = { ...RESULT_DEFAULTS, rawData: metrics };

      // Cross-chunk rates computed at merge time (mergeChunkMetrics) ride
      // through the merged metrics file — pick them up if present.
      const rates = metrics.rates as { response_rate?: number | null; interrupt_rate?: number | null; false_interrupt_rate?: number | null } | undefined;
      if (rates && typeof rates === 'object') {
        results.responseRate = rates.response_rate ?? null;
        results.interruptRate = rates.interrupt_rate ?? null;
        results.falseInterruptRate = rates.false_interrupt_rate ?? null;
      }

      // Helper: compute median from array of numbers
      const median = (arr: number[]) => {
        if (arr.length === 0) return 0;
        const sorted = [...arr].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      };

      // Helper: compute population SD from array of numbers
      const sd = (arr: number[]) => {
        if (arr.length < 2) return 0;
        const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
        return Math.sqrt(arr.reduce((sum, v) => sum + (v - mean) ** 2, 0) / arr.length);
      };

      // Helper: compute 95th percentile from array of numbers
      const p95 = (arr: number[]) => {
        if (arr.length === 0) return 0;
        const sorted = [...arr].sort((a, b) => a - b);
        const idx = Math.ceil(sorted.length * 0.95) - 1;
        return sorted[Math.max(0, idx)];
      };

      // --- Primary: compute median & SD from turn-level data (ground truth).
      // Case-scoped (headlineLatencyVals): response latency from response-type
      // cases only; interrupt latency from true-interrupt cases only, using
      // interrupt_action_ms with the INTERRUPT_ACTION_MAX_MS threshold and
      // greeting turns excluded. Single-file runs (no case data) use all turns.
      const { respVals, intVals } = headlineLatencyVals(metrics);
      if (respVals.length > 0) {
        results.responseLatencyMedian = Math.round(median(respVals));
        results.responseLatencySd = Math.round(sd(respVals));
        results.responseLatencyP95 = Math.round(p95(respVals));
      }
      if (intVals.length > 0) {
        results.interruptLatencyMedian = Math.round(median(intVals));
        results.interruptLatencySd = Math.round(sd(intVals));
        results.interruptLatencyP95 = Math.round(p95(intVals));
      }

      // --- Fallback: p50/p95 from summary (if turn_level missing) ---
      if (results.responseLatencyMedian === 0 && rlSummary && typeof rlSummary === 'object') {
        if (rlSummary.p50_latency_ms != null) {
          results.responseLatencyMedian = Math.round(rlSummary.p50_latency_ms);
        }
      }
      if (results.responseLatencyP95 === 0 && rlSummary && typeof rlSummary === 'object') {
        if (rlSummary.p95_latency_ms != null) {
          results.responseLatencyP95 = Math.round(rlSummary.p95_latency_ms);
        }
      }
      if (results.interruptLatencyMedian === 0 && ilSummary && typeof ilSummary === 'object') {
        // v0.2.1 name first; legacy name for pre-v0.2.1 output.
        const p50 = ilSummary.p50_interrupt_action_ms ?? ilSummary.p50_reaction_time_ms;
        if (p50 != null) {
          results.interruptLatencyMedian = Math.round(p50);
        }
      }
      if (results.interruptLatencyP95 === 0 && ilSummary && typeof ilSummary === 'object') {
        const p95v = ilSummary.p95_interrupt_action_ms ?? ilSummary.p95_reaction_time_ms;
        if (p95v != null) {
          results.interruptLatencyP95 = Math.round(p95v);
        }
      }

      // --- Last resort: aggregated_summary avg (better than 0) ---
      if (results.responseLatencyMedian === 0 && agg && typeof agg === 'object') {
        if (agg.avg_response_latency_ms != null) {
          results.responseLatencyMedian = Math.round(agg.avg_response_latency_ms);
        }
      }
      if (results.interruptLatencyMedian === 0 && agg && typeof agg === 'object') {
        const avgAct = agg.avg_interruption_action_ms ?? agg.avg_interruption_reaction_ms;
        if (avgAct != null) {
          results.interruptLatencyMedian = Math.round(avgAct);
        }
      }

      // --- Fallback: flat keys directly on metrics (future-proofing) ---
      if (results.responseLatencyMedian === 0) {
        const rl = metrics.response_latency || metrics.responseLatency || {};
        if (rl.median_ms != null) results.responseLatencyMedian = Math.round(rl.median_ms);
        else if (rl.avg_latency_ms != null) results.responseLatencyMedian = Math.round(rl.avg_latency_ms);
      }
      if (results.interruptLatencyMedian === 0) {
        const il = metrics.interrupt_latency || metrics.interruptLatency || {};
        if (il.median_ms != null) results.interruptLatencyMedian = Math.round(il.median_ms);
        else if (il.avg_latency_ms != null) results.interruptLatencyMedian = Math.round(il.avg_latency_ms);
      }

      if (metrics.network_resilience != null) results.networkResilience = metrics.network_resilience;
      if (metrics.naturalness != null) results.naturalness = metrics.naturalness;
      if (metrics.noise_reduction != null) results.noiseReduction = metrics.noise_reduction;

      return results;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Daemon] Error parsing ${path.basename(filePath)}:`, msg);
      return null;
    }
  }

  /**
   * Parse report.json (session report) — may contain step execution results with timing.
   * Searches for latency data in nested structures: metrics, analysis, results, steps.
   */
  private tryParseReportJson(filePath: string): EvalResult | null {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      console.log(`[Daemon] Reading report.json (${raw.length} bytes)`);
      const data = JSON.parse(raw);
      const topKeys = Object.keys(data);
      console.log(`[Daemon] report.json top-level keys: ${topKeys.join(', ')}`);

      // Try direct metrics (if report.json IS the metrics output)
      const direct = this.tryParseMetricsJson(filePath);
      if (direct && (direct.responseLatencyMedian > 0 || direct.interruptLatencyMedian > 0)) {
        return direct;
      }

      // Try nested paths where metrics might live
      for (const key of ['metrics', 'analysis', 'results', 'summary']) {
        if (data[key] && typeof data[key] === 'object') {
          console.log(`[Daemon] Checking report.json.${key} keys: ${Object.keys(data[key]).join(', ')}`);
          const nested = data[key];
          const rl = nested.response_latency || nested.responseLatency || {};
          const il = nested.interrupt_latency || nested.interruptLatency || {};
          if (rl.median_ms != null || rl.median != null || il.median_ms != null || il.median != null) {
            const results: EvalResult = { ...RESULT_DEFAULTS };
            if (rl.median_ms != null) results.responseLatencyMedian = Math.round(rl.median_ms);
            else if (rl.median != null) results.responseLatencyMedian = Math.round(rl.median);
            if (il.median_ms != null) results.interruptLatencyMedian = Math.round(il.median_ms);
            else if (il.median != null) results.interruptLatencyMedian = Math.round(il.median);
            return results;
          }
        }
      }

      // Try to extract latencies from step execution results
      // aeval may record step results with timing (wait_for_speech duration = latency)
      const stepResults = data.step_results || data.steps_results || data.execution?.steps;
      if (Array.isArray(stepResults)) {
        return this.extractLatenciesFromStepResults(stepResults);
      }

      // Deep-scan: look for any array of objects with duration/latency/elapsed fields
      for (const key of topKeys) {
        const val = data[key];
        if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object') {
          const sample = val[0];
          if (sample.duration_ms != null || sample.latency_ms != null || sample.elapsed_ms != null) {
            console.log(`[Daemon] Found timing array at report.json.${key} (${val.length} items)`);
            return this.extractLatenciesFromStepResults(val);
          }
        }
      }

      return null;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Daemon] Error parsing report.json:`, msg);
      return null;
    }
  }

  /**
   * Extract latencies from an array of step execution results.
   * Each step result may have duration_ms, latency_ms, or elapsed_ms fields.
   */
  private extractLatenciesFromStepResults(steps: Record<string, unknown>[]): EvalResult | null {
    const responseTimes: number[] = [];
    const interruptTimes: number[] = [];

    for (const step of steps) {
      const type = (step.type || step.step_type || '') as string;
      const duration = (step.duration_ms ?? step.latency_ms ?? step.elapsed_ms) as number | undefined;

      if (duration == null || typeof duration !== 'number') continue;

      if (type.includes('wait_for_speech')) {
        // Heuristic: steps in interrupt phases have "interrupt" context
        const desc = ((step.description || '') as string).toLowerCase();
        if (desc.includes('interrupt') || desc.includes('recover')) {
          interruptTimes.push(duration);
        } else {
          responseTimes.push(duration);
        }
      }
    }

    if (responseTimes.length === 0 && interruptTimes.length === 0) return null;

    console.log(`[Daemon] Step timing — response samples: ${responseTimes.length}, interrupt samples: ${interruptTimes.length}`);
    return this.computeLatencyStats(responseTimes, interruptTimes);
  }

  /**
   * Compute median, stddev, and p95 from latency samples.
   */
  private computeLatencyStats(responseTimes: number[], interruptTimes: number[]): EvalResult {
    const results: EvalResult = { ...RESULT_DEFAULTS };

    const median = (arr: number[]) => {
      if (arr.length === 0) return 0;
      const sorted = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };
    const stddev = (arr: number[]) => {
      if (arr.length < 2) return 0;
      const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
      return Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length);
    };
    const p95 = (arr: number[]) => {
      if (arr.length === 0) return 0;
      const sorted = [...arr].sort((a, b) => a - b);
      const idx = Math.ceil(sorted.length * 0.95) - 1;
      return sorted[Math.max(0, idx)];
    };

    if (responseTimes.length > 0) {
      results.responseLatencyMedian = Math.round(median(responseTimes));
      results.responseLatencySd = Math.round(stddev(responseTimes));
      results.responseLatencyP95 = Math.round(p95(responseTimes));
    }
    if (interruptTimes.length > 0) {
      results.interruptLatencyMedian = Math.round(median(interruptTimes));
      results.interruptLatencySd = Math.round(stddev(interruptTimes));
      results.interruptLatencyP95 = Math.round(p95(interruptTimes));
    }

    return results;
  }

  /**
   * Fallback: extract latencies from aeval stdout by parsing timestamped log lines.
   *
   * aeval logs structured lines like:
   *   2026-03-03 12:13:44.362 | INFO     | Audio playback completed
   *   2026-03-03 12:14:01.910 | INFO     | Complete speech detected successfully
   *   2026-03-03 12:15:01.110 | INFO     | Speech start detected
   *   2026-03-03 12:14:51.126 | INFO     | Phase 1 (response latency) completed.
   *   2026-03-03 12:15:42.271 | INFO     | Phase 2 (interrupt handling) completed.
   *
   * Response latency = time from "Audio playback completed" to next speech detection.
   * We track phases via "Phase N (...) completed." markers.
   */
  private parseAevalStdout(stdout: string): EvalResult {
    const results: EvalResult = { ...RESULT_DEFAULTS };

    // Parse timestamped events from log lines
    // Format: "YYYY-MM-DD HH:MM:SS.mmm | LEVEL | message"
    const tsRegex = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s*\|\s*\w+\s*\|\s*(.+)/g;

    interface LogEvent { ts: number; msg: string }
    const events: LogEvent[] = [];

    let match;
    while ((match = tsRegex.exec(stdout)) !== null) {
      const ts = new Date(match[1].replace(' ', 'T') + 'Z').getTime();
      if (!isNaN(ts)) {
        events.push({ ts, msg: match[2].trim() });
      }
    }

    if (events.length === 0) {
      console.warn(`[Daemon] No timestamped log events found in stdout — results will be zeroed`);
      return results;
    }

    console.log(`[Daemon] Parsed ${events.length} timestamped events from stdout`);

    // Walk events: pair "Audio playback completed" → next speech detection
    // Track current phase via phase markers
    const responseTimes: number[] = [];
    const interruptTimes: number[] = [];
    let currentPhase = 'response'; // default phase until we see a phase marker
    let lastPlaybackTs: number | null = null;
    let pendingInterrupt = false; // set when we detect interrupt-phase audio plays

    for (const evt of events) {
      const msg = evt.msg;

      // Phase completion markers — "Phase N (...) completed." means that phase JUST ENDED.
      // Switch to the NEXT phase's category.
      if (/Phase \d+.*response.*completed|Phase \d+.*latency.*completed/i.test(msg)) {
        currentPhase = 'interrupt'; // after response phase → interrupt comes next
      } else if (/Phase \d+.*interrupt.*completed/i.test(msg)) {
        currentPhase = 'response'; // after interrupt phase → context recall / response
      }

      // Track audio playback completion
      if (msg === 'Audio playback completed') {
        lastPlaybackTs = evt.ts;
        pendingInterrupt = currentPhase === 'interrupt';
        continue;
      }

      // Speech detection events (pair with last playback)
      if (lastPlaybackTs != null) {
        const isSpeechEvent =
          msg.includes('Complete speech detected') ||
          msg.includes('Speech start detected');

        if (isSpeechEvent) {
          const delta = evt.ts - lastPlaybackTs;
          // Sanity: 100ms < latency < 120s
          if (delta > 100 && delta < 120000) {
            if (pendingInterrupt) {
              interruptTimes.push(delta);
            } else {
              responseTimes.push(delta);
            }
          }
          lastPlaybackTs = null;
        }
      }
    }

    if (responseTimes.length > 0 || interruptTimes.length > 0) {
      const computed = this.computeLatencyStats(responseTimes, interruptTimes);
      Object.assign(results, computed);
      console.log(`[Daemon] Parsed from stdout timestamps — response: [${responseTimes.map(t => t + 'ms').join(', ')}], interrupt: [${interruptTimes.map(t => t + 'ms').join(', ')}]`);
    } else {
      console.warn(`[Daemon] No playback→speech pairs found in stdout — results will be zeroed`);
    }

    console.log(`[Daemon] Final aeval results (stdout fallback):`, results);
    return results;
  }

  // -------------------------------------------------------------------------
  // voice-agent-tester framework
  // -------------------------------------------------------------------------

  private runVoiceAgentTester(appConfig: string, scenarioConfig: string): Promise<EvalResult> {
    return new Promise((resolve, reject) => {
      const reportFile = `/tmp/vox-report-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`;

      const args = [
        'start',
        '--',
        '-a', appConfig,
        '-s', scenarioConfig,
        '--report', reportFile,
        '--headless', this.config.headless.toString(),
      ];

      console.log(`[Daemon] Running: npm ${args.join(' ')}`);

      const proc = spawn('npm', args, {
        cwd: VOICE_AGENT_TESTER_PATH,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
        console.log(`[VAT] ${data.toString().trim()}`);
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
        console.error(`[VAT] ${data.toString().trim()}`);
      });

      proc.on('close', (code) => {
        console.log(`[Daemon] voice-agent-tester exited with code ${code}`);
        const results = this.parseVATResults(reportFile, stdout);
        resolve(results);
      });

      proc.on('error', (error) => {
        reject(error);
      });
    });
  }

  private parseVATResults(reportFile: string, stdout: string): EvalResult {
    const results: EvalResult = { ...RESULT_DEFAULTS };

    try {
      if (fs.existsSync(reportFile)) {
        const csv = fs.readFileSync(reportFile, 'utf-8');
        console.log(`[Daemon] CSV Report content:\n${csv}`);

        const lines = csv.trim().split('\n');

        if (lines.length >= 2) {
          const headers = lines[0].split(', ').map(h => h.trim());
          const allLatencies: number[][] = [];

          for (let i = 1; i < lines.length; i++) {
            const values = lines[i].split(', ').map(v => v.trim());
            const runLatencies: number[] = [];

            headers.forEach((header, idx) => {
              if (header.includes('elapsed_time')) {
                const value = parseFloat(values[idx]);
                if (!isNaN(value)) {
                  runLatencies.push(value);
                }
              }
            });

            if (runLatencies.length > 0) {
              allLatencies.push(runLatencies);
            }
          }

          console.log(`[Daemon] Parsed latencies:`, allLatencies);

          if (allLatencies.length > 0) {
            // Response latency (first elapsed_time from each run)
            const responseLatencies = allLatencies.map(run => run[0]).filter(v => !isNaN(v));

            if (responseLatencies.length > 0) {
              const sorted = [...responseLatencies].sort((a, b) => a - b);
              const mid = Math.floor(sorted.length / 2);
              results.responseLatencyMedian = sorted.length % 2 !== 0
                ? Math.round(sorted[mid])
                : Math.round((sorted[mid - 1] + sorted[mid]) / 2);

              if (responseLatencies.length > 1) {
                const mean = responseLatencies.reduce((a, b) => a + b, 0) / responseLatencies.length;
                const variance = responseLatencies.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / responseLatencies.length;
                results.responseLatencySd = Math.round(Math.sqrt(variance));
              }
            }

            // Interrupt latency (second elapsed_time from each run)
            const interruptLatencies = allLatencies.map(run => run[1]).filter(v => !isNaN(v) && v !== undefined);

            if (interruptLatencies.length > 0) {
              const sorted = [...interruptLatencies].sort((a, b) => a - b);
              const mid = Math.floor(sorted.length / 2);
              results.interruptLatencyMedian = sorted.length % 2 !== 0
                ? Math.round(sorted[mid])
                : Math.round((sorted[mid - 1] + sorted[mid]) / 2);

              if (interruptLatencies.length > 1) {
                const mean = interruptLatencies.reduce((a, b) => a + b, 0) / interruptLatencies.length;
                const variance = interruptLatencies.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / interruptLatencies.length;
                results.interruptLatencySd = Math.round(Math.sqrt(variance));
              }
            }
          }
        }

        console.log(`[Daemon] Report file kept at: ${reportFile}`);
      } else {
        console.log(`[Daemon] Report file not found: ${reportFile}`);
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Daemon] Error parsing results:`, msg);
    }

    // Fallback: parse stdout if CSV parsing failed
    if (results.responseLatencyMedian === 0) {
      const elapsedMatch = stdout.match(/elapsed[_\s]?time[:\s]+(\d+)/i);
      if (elapsedMatch) {
        results.responseLatencyMedian = parseInt(elapsedMatch[1]);
      }

      const avgMatch = stdout.match(/Average:\s*(\d+)/);
      if (avgMatch) {
        results.responseLatencyMedian = parseInt(avgMatch[1]);
      }
    }

    console.log(`[Daemon] Final parsed results:`, results);
    return results;
  }

  // -------------------------------------------------------------------------
  // Temp file helpers
  // -------------------------------------------------------------------------

  private writeTempYaml(content: string, prefix = 'vox-config'): string | null {
    if (!content) return null;
    // Defense-in-depth: strip any path separators from the prefix so it can
    // never escape os.tmpdir(), even if a caller forgets to sanitize.
    const safePrefix = path.basename(prefix);
    const tmpFile = path.join(os.tmpdir(), `${safePrefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`);
    fs.writeFileSync(tmpFile, content, { encoding: 'utf-8', mode: 0o600 });
    console.log(`[Daemon] Wrote temp YAML: ${tmpFile}`);
    return tmpFile;
  }

  private cleanupTempFiles(...files: (string | null)[]): void {
    for (const f of files) {
      if (!f) continue;
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }

  // -------------------------------------------------------------------------
  // S3 Artifact Upload (runs when daemon is idle)
  // -------------------------------------------------------------------------

  private async updateArtifactStatus(jobId: number, status: string): Promise<void> {
    try {
      await fetch(`${this.config.serverUrl}/api/eval-agent/jobs/${jobId}/artifact-status`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${this.config.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
        signal: AbortSignal.timeout(10000),
      });
    } catch { /* non-fatal */ }
  }

  private queueUpload(task: UploadTask): void {
    if (this.uploadQueue.length >= MAX_UPLOAD_QUEUE_SIZE) {
      console.warn(`[Daemon] Upload queue full (${MAX_UPLOAD_QUEUE_SIZE}), dropping oldest task`);
      const dropped = this.uploadQueue.shift()!;
      this.updateArtifactStatus(dropped.jobId, 'failed');
    }
    this.uploadQueue.push(task);
    console.log(`[Daemon] Queued artifact upload for job ${task.jobId} (queue: ${this.uploadQueue.length})`);
  }

  private async getS3ConfigForJob(jobId: number): Promise<S3Config | null> {
    // Try per-user config from Vox server
    try {
      const response = await fetch(`${this.config.serverUrl}/api/eval-agent/jobs/${jobId}/storage-config`, {
        headers: { 'Authorization': `Bearer ${this.config.token}` },
        signal: AbortSignal.timeout(10000),
      });
      if (response.ok) {
        const data = await response.json();
        if (data.source === 'user') {
          return {
            endpoint: data.s3Endpoint,
            bucket: data.s3Bucket,
            region: data.s3Region,
            accessKeyId: data.s3AccessKeyId,
            secretAccessKey: data.s3SecretAccessKey,
          };
        }
      }
    } catch (e) {
      console.warn(`[Daemon] Failed to fetch per-user storage config for job ${jobId}`);
    }

    // Fall back to system defaults
    return getSystemS3Config();
  }

  private async processUploadQueue(): Promise<void> {
    if (this.uploadQueue.length === 0 || this.isUploading) return;

    this.isUploading = true;
    const task = this.uploadQueue.shift()!;

    try {
      await this._processUploadTask(task);
    } finally {
      this.isUploading = false;
    }
  }

  private async _processUploadTask(task: UploadTask): Promise<void> {
    const s3Config = await this.getS3ConfigForJob(task.jobId);

    if (!s3Config) {
      if (!this.s3Warned) {
        console.warn('[Daemon] S3 not configured — artifact upload disabled. Configure S3 on the Vox server to enable.');
        this.s3Warned = true;
      }
      // Re-queue if this was a transient server failure (not permanent "not configured")
      if (task.retries < MAX_UPLOAD_RETRIES) {
        this.uploadQueue.push({ ...task, retries: task.retries + 1 });
      }
      return;
    }

    const dirs = task.outputDirs.filter(d => fs.existsSync(d));
    for (const missing of task.outputDirs.filter(d => !dirs.includes(d))) {
      console.warn(`[Daemon] Output dir not found for job ${task.jobId}: ${missing} — files may have been lost after restart`);
    }
    if (dirs.length === 0) {
      await this.updateArtifactStatus(task.jobId, 'failed');
      return;
    }
    // Single-dir jobs keep the historical flat layout; multi-chunk jobs
    // namespace each chunk by its scenario dir name (vox-<case>-<chunk>-...).
    const labelFor = (d: string) => dirs.length === 1 ? '' : path.basename(path.dirname(d));

    try {
      console.log(`[Daemon] Uploading artifacts for job ${task.jobId}...`);

      // Mark status as uploading
      await this.updateArtifactStatus(task.jobId, 'uploading');

      // Dynamic import to avoid crash if SDK not installed
      const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');

      const client = new S3Client({
        endpoint: s3Config.endpoint,
        region: s3Config.region,
        credentials: {
          accessKeyId: s3Config.accessKeyId,
          secretAccessKey: s3Config.secretAccessKey,
        },
        forcePathStyle: true,
      });

      const prefix = `jobs/${task.jobId}`;
      const uploadedFiles: Array<{ name: string; url: string; size: number; contentType: string }> = [];

      // Upload all files recursively from the output directory
      const scanDir = (dir: string, relPrefix: string = '') => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const files: Array<{ filePath: string; relPath: string }> = [];
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            files.push(...scanDir(fullPath, rel));
          } else if (entry.isFile() && entry.name !== '.DS_Store') {
            files.push({ filePath: fullPath, relPath: rel });
          }
        }
        return files;
      };

      const allFiles: Array<{ filePath: string; relPath: string }> = [];
      for (const dir of dirs) {
        allFiles.push(...scanDir(dir, labelFor(dir)));
      }
      for (const { filePath: fp, relPath } of allFiles) {
        try {
          const body = fs.readFileSync(fp);
          if (body.length === 0) continue; // skip empty files
          const key = `${prefix}/${relPath}`;
          const ext = path.extname(relPath).toLowerCase();
          const contentType = ext === '.json' ? 'application/json'
            : ext === '.webm' ? 'audio/webm'
            : ext === '.wav' ? 'audio/wav'
            : ext === '.png' ? 'image/png'
            : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
            : ext === '.html' ? 'text/html'
            : ext === '.log' || ext === '.txt' ? 'text/plain'
            : ext === '.yaml' || ext === '.yml' ? 'text/yaml'
            : 'application/octet-stream';

          await client.send(new PutObjectCommand({
            Bucket: s3Config.bucket,
            Key: key,
            Body: body,
            ContentType: contentType,
          }));

          uploadedFiles.push({ name: relPath, url: key, size: body.length, contentType });
          console.log(`[Daemon] Uploaded ${relPath} (${body.length} bytes)`);
        } catch (e) {
          console.warn(`[Daemon] Failed to upload ${relPath}: ${e instanceof Error ? e.message : e}`);
        }
      }

      // Create one zip covering every chunk's output dir. Single-dir jobs zip
      // flat (historical layout); multi-chunk entries are prefixed with the
      // chunk's scenario dir name so cases stay separable.
      const zipPath = path.join(os.tmpdir(), `vox-artifacts-${task.jobId}.zip`);
      try { fs.unlinkSync(zipPath); } catch { /* stale zip from a retry */ }
      if (dirs.length === 1) {
        await this.createZip(dirs[0], zipPath);
      } else {
        for (const dir of dirs) {
          // cwd two levels up so entries are <scenarioBase>/<session>/...
          await this.zipAppend(path.dirname(path.dirname(dir)),
            path.join(path.basename(path.dirname(dir)), path.basename(dir)), zipPath);
        }
      }

      if (fs.existsSync(zipPath)) {
        const zipBody = fs.readFileSync(zipPath);
        const zipKey = `${prefix}/artifacts.zip`;
        await client.send(new PutObjectCommand({
          Bucket: s3Config.bucket,
          Key: zipKey,
          Body: zipBody,
          ContentType: 'application/zip',
        }));

        const zipUrl = zipKey;
        console.log(`[Daemon] Uploaded artifacts.zip (${zipBody.length} bytes)`);

        // Report to Vox
        try {
          await fetch(`${this.config.serverUrl}/api/eval-agent/jobs/${task.jobId}/artifacts`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${this.config.token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ zipUrl, files: uploadedFiles }),
            signal: AbortSignal.timeout(15000),
          });
          console.log(`[Daemon] Artifact URLs stored for job ${task.jobId}`);
        } catch (e) {
          console.error(`[Daemon] Failed to report artifacts for job ${task.jobId}`);
        }

        // Clean up zip
        try { fs.unlinkSync(zipPath); } catch { /* ignore */ }
      }

      // Mark as uploaded (even if the POST to Vox failed — files are in S3)
      await this.updateArtifactStatus(task.jobId, 'uploaded');
      console.log(`[Daemon] Artifact upload complete for job ${task.jobId} (${uploadedFiles.length} files)`);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Daemon] Artifact upload failed for job ${task.jobId} (attempt ${task.retries + 1}):`, msg);
      if (task.retries < MAX_UPLOAD_RETRIES) {
        this.uploadQueue.push({ ...task, retries: task.retries + 1 });
        console.log(`[Daemon] Re-queued job ${task.jobId} for retry (${task.retries + 1}/${MAX_UPLOAD_RETRIES})`);
      } else {
        console.warn(`[Daemon] Giving up on artifact upload for job ${task.jobId} after ${MAX_UPLOAD_RETRIES + 1} attempts`);
        await this.updateArtifactStatus(task.jobId, 'failed');
      }
    }
  }

  /** Add `relPath` (relative to `cwd`) to the archive, creating it if absent. */
  private zipAppend(cwd: string, relPath: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn('zip', ['-r', '-q', outputPath, relPath], { cwd });
      const timeout = setTimeout(() => {
        proc.kill();
        reject(new Error('zip timed out after 120s'));
      }, 120000);
      proc.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) resolve();
        else reject(new Error(`zip exited with code ${code}`));
      });
      proc.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  private createZip(sourceDir: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn('zip', ['-r', '-q', outputPath, '.'], { cwd: sourceDir });
      const timeout = setTimeout(() => {
        proc.kill();
        reject(new Error('zip timed out after 120s'));
      }, 120000);
      proc.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) resolve();
        else reject(new Error(`zip exited with code ${code}`));
      });
      proc.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  // -------------------------------------------------------------------------
  // Job execution
  // -------------------------------------------------------------------------

  async executeJob(job: EvalJob): Promise<EvalResult> {
    console.log(`[Daemon] Executing job ${job.id}`);
    console.log(`  - Workflow ID: ${job.workflowId}`);
    console.log(`  - Region: ${job.region}`);

    const config = (job.config || {}) as { framework?: string; app?: string; scenario?: string; stepsPrefix?: string; stepsSuffix?: string };

    // Per-job framework override, falling back to daemon default
    const framework = config.framework || this.config.framework;
    console.log(`  - Framework: ${framework}`);

    if (!config.scenario) {
      throw new Error('job.config.scenario is required');
    }

    // Resolve ${config.*} placeholders (e.g., ${config.url} from workflow config)
    let scenario = config.scenario;
    let app = config.app;
    // stepsPrefix/stepsSuffix come from the workflow and typically hold
    // platform.setup with credentials — they MUST go through the same
    // ${config.*} / ${secrets.*} resolution as the scenario.
    let stepsPrefix = config.stepsPrefix;
    let stepsSuffix = config.stepsSuffix;
    const configPlaceholders: Record<string, string> = {};
    for (const [k, v] of Object.entries(config)) {
      if (typeof v === 'string' && k !== 'scenario' && k !== 'app' && k !== 'framework') {
        configPlaceholders[k] = v;
      }
    }
    const resolveConfigVars = (s: string) =>
      s.replace(/\$\{config\.(\w+)\}/g, (_m, key) => configPlaceholders[key] ?? _m);
    if (Object.keys(configPlaceholders).length > 0) {
      scenario = resolveConfigVars(scenario);
      if (app) app = resolveConfigVars(app);
      if (stepsPrefix) stepsPrefix = resolveConfigVars(stepsPrefix);
      if (stepsSuffix) stepsSuffix = resolveConfigVars(stepsSuffix);
    }

    // Fetch secrets for this job and resolve ${secrets.*} placeholders
    const jobSecrets = await this.fetchSecrets(job.id);
    if (Object.keys(jobSecrets).length > 0) {
      scenario = this.resolveSecrets(scenario, jobSecrets);
      if (app) app = this.resolveSecrets(app, jobSecrets);
      if (stepsPrefix) stepsPrefix = this.resolveSecrets(stepsPrefix, jobSecrets);
      if (stepsSuffix) stepsSuffix = this.resolveSecrets(stepsSuffix, jobSecrets);
    }

    const tempFiles: (string | null)[] = [];

    try {
      let results: EvalResult;

      switch (framework) {
        case 'aeval': {
          results = await this.executeAevalWithChunking(scenario, { stepsPrefix, stepsSuffix }, tempFiles);
          break;
        }
        case 'voice-agent-tester': {
          if (!app) {
            throw new Error('job.config.app is required for voice-agent-tester');
          }
          const appConfig = this.writeTempYaml(app, 'vox-app')!;
          tempFiles.push(appConfig);

          const scenarioConfig = this.writeTempYaml(scenario, 'vox-scenario')!;
          tempFiles.push(scenarioConfig);

          results = await this.runVoiceAgentTester(appConfig, scenarioConfig);
          break;
        }
        default:
          throw new Error(`Unsupported eval framework: '${framework}'. Supported: aeval, voice-agent-tester`);
      }

      console.log(`[Daemon] Job ${job.id} results:`, results);
      return results;
    } catch (error: unknown) {
      // Re-throw so processJobs can report the job as failed (not completed)
      throw error;
    } finally {
      this.cleanupTempFiles(...tempFiles);
    }
  }

  // -------------------------------------------------------------------------
  // Job processing loop
  // -------------------------------------------------------------------------

  async processJobs(): Promise<void> {
    if (this.isRunningJob) return;

    const jobs = await this.fetchJobs();

    // When idle, process upload queue (never crashes — errors are caught)
    if (jobs.length === 0) {
      if (this.uploadQueue.length > 0) {
        try {
          await this.processUploadQueue();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`[Daemon] Upload queue error (non-fatal):`, msg);
        }
      }
      return;
    }

    console.log(`[Daemon] Found ${jobs.length} pending job(s)`);

    const job = jobs[0];
    const claimed = await this.claimJob(job.id);
    if (!claimed) return;

    this.isRunningJob = true;
    this.currentJobId = job.id;
    this.lastOutputDir = null;
    this.jobOutputDirs = [];
    try {
      const results = await this.executeJob(job);
      await this.completeJob(job.id, results);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Daemon] Job execution error:`, msg);

      // Save partial metrics if available (job still marked as failed)
      const partial = (error as Error & { partialResults?: EvalResult })?.partialResults;
      if (partial) {
        try {
          await this.completeJobWithPartialResults(job.id, partial, msg);
        } catch {
          // Fall back to plain fail
          try { await this.failJob(job.id, msg); } catch { /* ignore */ }
        }
      } else {
        try {
          await this.failJob(job.id, msg);
        } catch (reportError: unknown) {
          const reportMsg = reportError instanceof Error ? reportError.message : String(reportError);
          console.error(`[Daemon] Failed to report job failure:`, reportMsg);
        }
      }
    } finally {
      // Queue artifact upload (whether job succeeded or failed) — covers every
      // chunk's output dir, not just the last run's.
      if (this.jobOutputDirs.length > 0) {
        this.queueUpload({
          jobId: job.id,
          outputDirs: [...this.jobOutputDirs],
          scenarioName: (job.config as Record<string, string>)?.scenario?.slice(0, 50) || 'unknown',
          retries: 0,
        });
      }
      this.isRunningJob = false;
      this.currentJobId = null;
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  start(): void {
    const buildDate = process.env.BUILD_DATE || 'unknown';
    console.log(`[Daemon] Starting vox_eval_agentd`);
    console.log(`  - Build: ${shortBuildTag()} (${buildDate})`);
    console.log(`  - Server: ${this.config.serverUrl}`);
    console.log(`  - Agent Name: ${this.config.name || '(inherits from token)'}`);
    console.log(`  - Headless: ${this.config.headless}`);
    console.log(`  - Eval Framework: ${this.config.framework}`);
    console.log(`  - S3 Artifacts: resolved per-job from Vox server`);
    console.log('');

    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, HEARTBEAT_INTERVAL);

    this.jobPollTimer = setInterval(() => {
      this.processJobs();
    }, JOB_POLL_INTERVAL);

    // Initial poll
    setTimeout(() => this.processJobs(), 2000);

    // Health endpoint
    const healthPort = parseInt(process.env.HEALTH_PORT || '8099');
    this.healthServer = createServer((req, res) => {
      if (req.url === '/health' && req.method === 'GET') {
        const status = this.isRunningJob ? 'occupied' : this.isUploading ? 'uploading' : 'idle';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status,
          uptime: Math.round((Date.now() - this.startTime) / 1000),
          buildTag: shortBuildTag(),
          buildDate: process.env.BUILD_DATE || 'unknown',
          currentJobId: this.currentJobId,
        }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    this.healthServer.listen(healthPort, () => {
      console.log(`[Daemon] Health endpoint: http://0.0.0.0:${healthPort}/health`);
    });

    console.log(`[Daemon] Agent daemon started. Press Ctrl+C to stop.`);
  }

  stop(): void {
    console.log(`[Daemon] Stopping...`);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.jobPollTimer) clearInterval(this.jobPollTimer);
    if (this.healthServer) this.healthServer.close();
  }
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(): DaemonConfig {
  const args = process.argv.slice(2);

  let token = process.env.AGENT_TOKEN || '';
  let serverUrl = process.env.VOX_SERVER || 'http://localhost:5000';
  let name = process.env.VOX_AGENT_NAME || '';
  const framework = process.env.EVAL_FRAMEWORK || 'aeval';
  const headless = process.env.HEADLESS !== 'false';

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--token':
      case '-t':
        token = args[++i];
        break;
      case '--server':
      case '-s':
        serverUrl = args[++i];
        break;
      case '--name':
      case '-n':
        name = args[++i];
        break;
      case '--help':
      case '-h':
        console.log(`
Vox Evaluation Agent Daemon

Usage:
  npx tsx vox_eval_agentd/vox-agentd.ts --token <TOKEN> [options]

Options:
  -t, --token <TOKEN>   Agent registration token (required, or set AGENT_TOKEN)
  -s, --server <URL>    Vox server URL (default: \${VOX_SERVER || 'http://localhost:5000'})
  -n, --name <NAME>     Agent name (default: inherits from token)
  -h, --help            Show this help message

Environment Variables:
  AGENT_TOKEN           Agent registration token (fallback if --token not given)
  VOX_SERVER            Vox server URL (fallback if --server not given)
  VOX_AGENT_NAME        Agent name (fallback if --name not given)
  EVAL_FRAMEWORK        Default framework: 'aeval' or 'voice-agent-tester' (default: aeval)
  HEADLESS              Run browser in headless mode (default: true)

Example:
  npx tsx vox_eval_agentd/vox-agentd.ts --token vox_agent_xxx --name "NA-Agent-1"
`);
        process.exit(0);
    }
  }

  if (!token) {
    console.error('[Daemon] Error: --token or AGENT_TOKEN is required');
    console.error('Run with --help for usage information');
    process.exit(1);
  }

  return { token, serverUrl, name, framework, headless };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const config = parseArgs();

  console.log(`[Daemon] Eval framework: ${config.framework}`);

  const daemon = new VoxEvalAgentDaemon(config);

  // Detect aeval version before registration so it can be sent as metadata
  if (config.framework === 'aeval') {
    const ver = await daemon.detectAevalVersion();
    const aevalDataCommit = process.env.AEVAL_DATA_COMMIT || 'unknown';
    const aevalDataDate = process.env.AEVAL_DATA_DATE || 'unknown';
    console.log(`[Daemon] Detected aeval version: ${ver}, data: ${aevalDataCommit} (${aevalDataDate})`);
  }

  const registered = await daemon.register();
  if (!registered) {
    console.error('[Daemon] Failed to register, exiting');
    process.exit(1);
  }

  process.on('SIGINT', () => {
    daemon.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    daemon.stop();
    process.exit(0);
  });

  daemon.start();
}

main().catch((error) => {
  console.error('[Daemon] Fatal error:', error);
  process.exit(1);
});
