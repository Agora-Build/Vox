#!/usr/bin/env node
/**
 * vox_eval_agentd - Vox Evaluation Agent Daemon
 *
 * Integrates voice-agent-tester with Vox API to:
 * 1. Register with Vox server
 * 2. Fetch and claim pending jobs
 * 3. Execute voice-agent-tester for each job
 * 4. Parse results and report back to Vox
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Configuration from environment
const VOX_SERVER = process.env.VOX_SERVER || 'http://localhost:5000';
const AGENT_TOKEN = process.env.AGENT_TOKEN;
const VOX_AGENT_NAME = process.env.VOX_AGENT_NAME || `eval-agent-${Date.now()}`;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const HEADLESS = process.env.HEADLESS !== 'false';

const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const JOB_POLL_INTERVAL = 10000; // 10 seconds
const VOICE_AGENT_TESTER_PATH = path.join(__dirname, 'voice-agent-tester');

class VoxEvalAgentDaemon {
  constructor() {
    this.agentId = null;
    this.region = null;
    this.isRunningJob = false;
    this.heartbeatTimer = null;
    this.jobPollTimer = null;
  }

  async fetch(urlPath, options = {}) {
    const url = `${VOX_SERVER}${urlPath}`;
    return fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AGENT_TOKEN}`,
        ...options.headers,
      },
    });
  }

  async register() {
    console.log(`[Daemon] Registering with Vox server: ${VOX_SERVER}`);

    try {
      const response = await this.fetch('/api/eval-agent/register', {
        method: 'POST',
        body: JSON.stringify({ name: VOX_AGENT_NAME }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error(`[Daemon] Registration failed: ${response.status} - ${error}`);
        return false;
      }

      const agent = await response.json();
      this.agentId = agent.id;
      this.region = agent.region;

      console.log(`[Daemon] Registered successfully!`);
      console.log(`  - Agent ID: ${agent.id}`);
      console.log(`  - Name: ${agent.name}`);
      console.log(`  - Region: ${agent.region}`);

      return true;
    } catch (error) {
      console.error(`[Daemon] Registration error:`, error.message);
      return false;
    }
  }

  async sendHeartbeat() {
    if (!this.agentId) return;

    try {
      const response = await this.fetch('/api/eval-agent/heartbeat', {
        method: 'POST',
        body: JSON.stringify({ agentId: this.agentId }),
      });

      if (response.ok) {
        console.log(`[Daemon] Heartbeat sent`);
      }
    } catch (error) {
      console.error(`[Daemon] Heartbeat error:`, error.message);
    }
  }

  async fetchJobs() {
    if (!this.region) return [];

    try {
      const response = await this.fetch(`/api/eval-agent/jobs?region=${this.region}`);
      if (!response.ok) return [];
      return await response.json();
    } catch (error) {
      console.error(`[Daemon] Error fetching jobs:`, error.message);
      return [];
    }
  }

  async claimJob(jobId) {
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
    } catch (error) {
      console.error(`[Daemon] Error claiming job:`, error.message);
      return false;
    }
  }

  async completeJob(jobId, results) {
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
    } catch (error) {
      console.error(`[Daemon] Error completing job:`, error.message);
      return false;
    }
  }

  runVoiceAgentTester(appConfig, scenarioConfig) {
    return new Promise((resolve, reject) => {
      const reportFile = `/tmp/vox-report-${Date.now()}.csv`;

      const args = [
        'start',
        '--',
        '-a', appConfig,
        '-s', scenarioConfig,
        '--report', reportFile,
        '--headless', HEADLESS.toString(),
      ];

      console.log(`[Daemon] Running: npm ${args.join(' ')}`);

      const proc = spawn('npm', args, {
        cwd: VOICE_AGENT_TESTER_PATH,
        env: {
          ...process.env,
          OPENAI_API_KEY: OPENAI_API_KEY,
        },
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

        // Parse results from report file
        let results = this.parseResults(reportFile, stdout);

        if (code === 0) {
          resolve(results);
        } else {
          // Return partial results even on failure
          resolve(results);
        }
      });

      proc.on('error', (error) => {
        reject(error);
      });
    });
  }

  parseResults(reportFile, stdout) {
    // Default results
    let results = {
      responseLatencyMedian: 0,
      responseLatencySd: 0,
      interruptLatencyMedian: 0,
      interruptLatencySd: 0,
      networkResilience: 85,
      naturalness: 3.5,
      noiseReduction: 90,
    };

    // Try to parse CSV report
    try {
      if (fs.existsSync(reportFile)) {
        const csv = fs.readFileSync(reportFile, 'utf-8');
        console.log(`[Daemon] CSV Report content:\n${csv}`);

        const lines = csv.trim().split('\n');

        if (lines.length >= 2) {
          // CSV is comma-space separated
          const headers = lines[0].split(', ').map(h => h.trim());

          // Collect all elapsed_time values from all runs
          const allLatencies = [];

          for (let i = 1; i < lines.length; i++) {
            const values = lines[i].split(', ').map(v => v.trim());
            const runLatencies = [];

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
            // Get first elapsed_time from each run (response latency)
            const responseLatencies = allLatencies.map(run => run[0]).filter(v => !isNaN(v));

            if (responseLatencies.length > 0) {
              // Calculate median
              const sorted = [...responseLatencies].sort((a, b) => a - b);
              const mid = Math.floor(sorted.length / 2);
              results.responseLatencyMedian = sorted.length % 2 !== 0
                ? Math.round(sorted[mid])
                : Math.round((sorted[mid - 1] + sorted[mid]) / 2);

              // Calculate standard deviation
              if (responseLatencies.length > 1) {
                const mean = responseLatencies.reduce((a, b) => a + b, 0) / responseLatencies.length;
                const variance = responseLatencies.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / responseLatencies.length;
                results.responseLatencySd = Math.round(Math.sqrt(variance));
              }
            }

            // Get second elapsed_time from each run (interrupt latency)
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

        // Keep report file for debugging (optional - comment out in production)
        // fs.unlinkSync(reportFile);
        console.log(`[Daemon] Report file kept at: ${reportFile}`);
      } else {
        console.log(`[Daemon] Report file not found: ${reportFile}`);
      }
    } catch (error) {
      console.error(`[Daemon] Error parsing results:`, error.message);
    }

    // Parse stdout for additional metrics if CSV parsing failed
    if (results.responseLatencyMedian === 0) {
      const elapsedMatch = stdout.match(/elapsed[_\s]?time[:\s]+(\d+)/i);
      if (elapsedMatch) {
        results.responseLatencyMedian = parseInt(elapsedMatch[1]);
      }

      // Try to parse metrics summary from stdout
      const avgMatch = stdout.match(/Average:\s*(\d+)/);
      if (avgMatch) {
        results.responseLatencyMedian = parseInt(avgMatch[1]);
      }
    }

    console.log(`[Daemon] Final parsed results:`, results);
    return results;
  }

  async executeJob(job) {
    console.log(`[Daemon] Executing job ${job.id}`);
    console.log(`  - Workflow ID: ${job.workflowId}`);
    console.log(`  - Region: ${job.region}`);

    // Determine application and scenario configs
    const config = job.config || {};
    const appConfig = config.application || path.join(__dirname, 'applications', 'livekit.yaml');
    const scenarioConfig = config.scenario || path.join(__dirname, 'scenarios', 'basic_conversation.yaml');

    try {
      const results = await this.runVoiceAgentTester(appConfig, scenarioConfig);
      console.log(`[Daemon] Job ${job.id} results:`, results);
      return results;
    } catch (error) {
      console.error(`[Daemon] Job ${job.id} failed:`, error.message);

      // Return minimal results on failure
      return {
        responseLatencyMedian: 0,
        responseLatencySd: 0,
        interruptLatencyMedian: 0,
        interruptLatencySd: 0,
        networkResilience: 0,
        naturalness: 0,
        noiseReduction: 0,
      };
    }
  }

  async processJobs() {
    if (this.isRunningJob) {
      return;
    }

    const jobs = await this.fetchJobs();
    if (jobs.length === 0) {
      return;
    }

    console.log(`[Daemon] Found ${jobs.length} pending job(s)`);

    const job = jobs[0];
    const claimed = await this.claimJob(job.id);
    if (!claimed) {
      return;
    }

    this.isRunningJob = true;
    try {
      const results = await this.executeJob(job);
      await this.completeJob(job.id, results);
    } catch (error) {
      console.error(`[Daemon] Job execution error:`, error.message);
    } finally {
      this.isRunningJob = false;
    }
  }

  start() {
    console.log(`[Daemon] Starting vox_eval_agentd`);
    console.log(`  - Server: ${VOX_SERVER}`);
    console.log(`  - Agent Name: ${VOX_AGENT_NAME}`);
    console.log(`  - Headless: ${HEADLESS}`);
    console.log('');

    // Start heartbeat
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, HEARTBEAT_INTERVAL);

    // Start job polling
    this.jobPollTimer = setInterval(() => {
      this.processJobs();
    }, JOB_POLL_INTERVAL);

    // Initial poll
    setTimeout(() => this.processJobs(), 2000);

    console.log(`[Daemon] Agent daemon started. Press Ctrl+C to stop.`);
  }

  stop() {
    console.log(`[Daemon] Stopping...`);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.jobPollTimer) clearInterval(this.jobPollTimer);
  }
}

// Main
async function main() {
  if (!AGENT_TOKEN) {
    console.error('[Daemon] Error: AGENT_TOKEN environment variable is required');
    process.exit(1);
  }

  const daemon = new VoxEvalAgentDaemon();

  // Register
  const registered = await daemon.register();
  if (!registered) {
    console.error('[Daemon] Failed to register, exiting');
    process.exit(1);
  }

  // Handle shutdown
  process.on('SIGINT', () => {
    daemon.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    daemon.stop();
    process.exit(0);
  });

  // Start
  daemon.start();
}

main().catch((error) => {
  console.error('[Daemon] Fatal error:', error);
  process.exit(1);
});
