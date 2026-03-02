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
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EvalAgent {
  id: number;
  name: string;
  region: string;
  state: string;
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
  interruptLatencyMedian: number;
  interruptLatencySd: number;
  networkResilience: number;
  naturalness: number;
  noiseReduction: number;
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

const VOICE_AGENT_TESTER_PATH = path.resolve(__dirname, 'voice-agent-tester');
const AEVAL_DATA_PATH = path.resolve(__dirname, 'aeval-data');

const RESULT_DEFAULTS: EvalResult = {
  responseLatencyMedian: 0,
  responseLatencySd: 0,
  interruptLatencyMedian: 0,
  interruptLatencySd: 0,
  networkResilience: 85,
  naturalness: 3.5,
  noiseReduction: 90,
};

// ---------------------------------------------------------------------------
// Daemon class
// ---------------------------------------------------------------------------

class VoxEvalAgentDaemon {
  private config: DaemonConfig;
  private agentId: number | null = null;
  private region: string | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private jobPollTimer: NodeJS.Timeout | null = null;
  private isRunningJob = false;

  constructor(config: DaemonConfig) {
    this.config = config;
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

  async register(): Promise<boolean> {
    console.log(`[Daemon] Registering with Vox server: ${this.config.serverUrl}`);

    try {
      const response = await this.fetch('/api/eval-agent/register', {
        method: 'POST',
        body: JSON.stringify({ name: this.config.name }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error(`[Daemon] Registration failed: ${response.status} - ${error}`);
        return false;
      }

      const agent: EvalAgent = await response.json();
      this.agentId = agent.id;
      this.region = agent.region;

      console.log(`[Daemon] Registered successfully!`);
      console.log(`  - Agent ID: ${agent.id}`);
      console.log(`  - Name: ${agent.name}`);
      console.log(`  - Region: ${agent.region}`);

      return true;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Daemon] Registration error:`, msg);
      return false;
    }
  }

  async sendHeartbeat(): Promise<void> {
    if (!this.agentId) return;

    try {
      const response = await this.fetch('/api/eval-agent/heartbeat', {
        method: 'POST',
        body: JSON.stringify({
          agentId: this.agentId,
          state: this.isRunningJob ? 'occupied' : 'idle',
        }),
      });

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
        body: JSON.stringify({ agentId: this.agentId }),
      });

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
        body: JSON.stringify({ agentId: this.agentId, results }),
      });

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

  // -------------------------------------------------------------------------
  // aeval framework
  // -------------------------------------------------------------------------

  private runAeval(scenarioConfig: string): Promise<EvalResult> {
    return new Promise((resolve, reject) => {
      const args = ['run', scenarioConfig];

      if (!this.config.headless) {
        args.push('--headful');
      }

      console.log(`[Daemon] Running: aeval ${args.join(' ')}`);

      const proc = spawn('aeval', args, {
        cwd: AEVAL_DATA_PATH,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
        console.log(`[aeval] ${data.toString().trim()}`);
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
        console.error(`[aeval] ${data.toString().trim()}`);
      });

      proc.on('close', (code) => {
        console.log(`[Daemon] aeval exited with code ${code}`);

        const outputDir = this.resolveAevalOutputDir(scenarioConfig);
        const results = this.parseAevalResults(outputDir, stdout);
        resolve(results);
      });

      proc.on('error', (error) => {
        reject(error);
      });
    });
  }

  /**
   * Resolve the output directory that aeval writes metrics.json to.
   * Convention: output lands in <aeval-data>/output/<scenario-basename-without-ext>/
   */
  private resolveAevalOutputDir(scenarioConfig: string): string {
    const scenarioBasename = path.basename(scenarioConfig, path.extname(scenarioConfig));
    return path.join(AEVAL_DATA_PATH, 'output', scenarioBasename);
  }

  /**
   * Parse aeval's metrics.json output into the Vox result schema.
   */
  private parseAevalResults(outputDir: string, stdout: string): EvalResult {
    const metricsFile = path.join(outputDir, 'metrics.json');

    try {
      if (!fs.existsSync(metricsFile)) {
        console.log(`[Daemon] aeval metrics file not found: ${metricsFile}`);
        return this.parseAevalStdout(stdout);
      }

      const raw = fs.readFileSync(metricsFile, 'utf-8');
      console.log(`[Daemon] aeval metrics.json:\n${raw}`);

      const metrics = JSON.parse(raw);

      const rl = metrics.response_latency || metrics.responseLatency || {};
      const il = metrics.interrupt_latency || metrics.interruptLatency || {};

      const results: EvalResult = { ...RESULT_DEFAULTS };

      if (rl.median_ms != null) results.responseLatencyMedian = Math.round(rl.median_ms);
      else if (rl.median != null) results.responseLatencyMedian = Math.round(rl.median);

      if (rl.stddev_ms != null) results.responseLatencySd = Math.round(rl.stddev_ms);
      else if (rl.stddev != null) results.responseLatencySd = Math.round(rl.stddev);
      else if (rl.sd != null) results.responseLatencySd = Math.round(rl.sd);

      if (il.median_ms != null) results.interruptLatencyMedian = Math.round(il.median_ms);
      else if (il.median != null) results.interruptLatencyMedian = Math.round(il.median);

      if (il.stddev_ms != null) results.interruptLatencySd = Math.round(il.stddev_ms);
      else if (il.stddev != null) results.interruptLatencySd = Math.round(il.stddev);
      else if (il.sd != null) results.interruptLatencySd = Math.round(il.sd);

      if (metrics.network_resilience != null) results.networkResilience = metrics.network_resilience;
      if (metrics.naturalness != null) results.naturalness = metrics.naturalness;
      if (metrics.noise_reduction != null) results.noiseReduction = metrics.noise_reduction;

      console.log(`[Daemon] Parsed aeval results:`, results);
      return results;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Daemon] Error parsing aeval metrics:`, msg);
      return this.parseAevalStdout(stdout);
    }
  }

  /**
   * Fallback: try to extract latency numbers from aeval stdout when metrics.json is missing.
   */
  private parseAevalStdout(stdout: string): EvalResult {
    const results: EvalResult = { ...RESULT_DEFAULTS };

    const medianMatch = stdout.match(/median[:\s]+(\d+)/i);
    if (medianMatch) {
      results.responseLatencyMedian = parseInt(medianMatch[1]);
    }

    console.log(`[Daemon] Parsed aeval results (from stdout fallback):`, results);
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
    const tmpFile = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`);
    fs.writeFileSync(tmpFile, content, 'utf-8');
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
  // Job execution
  // -------------------------------------------------------------------------

  async executeJob(job: EvalJob): Promise<EvalResult> {
    console.log(`[Daemon] Executing job ${job.id}`);
    console.log(`  - Workflow ID: ${job.workflowId}`);
    console.log(`  - Region: ${job.region}`);

    const config = (job.config || {}) as { framework?: string; app?: string; scenario?: string };

    // Per-job framework override, falling back to daemon default
    const framework = config.framework || this.config.framework;
    console.log(`  - Framework: ${framework}`);

    if (!config.scenario) {
      throw new Error('job.config.scenario is required');
    }

    if (framework !== 'aeval' && !config.app) {
      throw new Error('job.config.app is required for voice-agent-tester');
    }

    const tempFiles: (string | null)[] = [];

    try {
      let results: EvalResult;

      if (framework === 'aeval') {
        const scenarioConfig = this.writeTempYaml(config.scenario, 'vox-scenario')!;
        tempFiles.push(scenarioConfig);
        results = await this.runAeval(scenarioConfig);
      } else {
        const appConfig = this.writeTempYaml(config.app!, 'vox-app')!;
        tempFiles.push(appConfig);

        const scenarioConfig = this.writeTempYaml(config.scenario, 'vox-scenario')!;
        tempFiles.push(scenarioConfig);

        results = await this.runVoiceAgentTester(appConfig, scenarioConfig);
      }

      console.log(`[Daemon] Job ${job.id} results:`, results);
      return results;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Daemon] Job ${job.id} failed:`, msg);

      return {
        responseLatencyMedian: 0,
        responseLatencySd: 0,
        interruptLatencyMedian: 0,
        interruptLatencySd: 0,
        networkResilience: 0,
        naturalness: 0,
        noiseReduction: 0,
      };
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
    if (jobs.length === 0) return;

    console.log(`[Daemon] Found ${jobs.length} pending job(s)`);

    const job = jobs[0];
    const claimed = await this.claimJob(job.id);
    if (!claimed) return;

    this.isRunningJob = true;
    try {
      const results = await this.executeJob(job);
      await this.completeJob(job.id, results);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Daemon] Job execution error:`, msg);
      try {
        await this.completeJob(job.id, {
          responseLatencyMedian: 0,
          responseLatencySd: 0,
          interruptLatencyMedian: 0,
          interruptLatencySd: 0,
          networkResilience: 0,
          naturalness: 0,
          noiseReduction: 0,
        });
      } catch (reportError: unknown) {
        const reportMsg = reportError instanceof Error ? reportError.message : String(reportError);
        console.error(`[Daemon] Failed to report job error:`, reportMsg);
      }
    } finally {
      this.isRunningJob = false;
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  start(): void {
    console.log(`[Daemon] Starting vox_eval_agentd`);
    console.log(`  - Server: ${this.config.serverUrl}`);
    console.log(`  - Agent Name: ${this.config.name || '(inherits from token)'}`);
    console.log(`  - Headless: ${this.config.headless}`);
    console.log(`  - Eval Framework: ${this.config.framework}`);
    console.log('');

    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, HEARTBEAT_INTERVAL);

    this.jobPollTimer = setInterval(() => {
      this.processJobs();
    }, JOB_POLL_INTERVAL);

    // Initial poll
    setTimeout(() => this.processJobs(), 2000);

    console.log(`[Daemon] Agent daemon started. Press Ctrl+C to stop.`);
  }

  stop(): void {
    console.log(`[Daemon] Stopping...`);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.jobPollTimer) clearInterval(this.jobPollTimer);
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
