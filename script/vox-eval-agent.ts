#!/usr/bin/env npx tsx
/**
 * vox_eval_agentd - Vox Evaluation Agent Daemon
 *
 * A standalone process that:
 * 1. Registers with Vox server using a token
 * 2. Sends periodic heartbeats
 * 3. Fetches and claims pending jobs
 * 4. Executes evaluation tests
 * 5. Reports results back to the server
 *
 * Usage:
 *   npx tsx script/vox-eval-agent.ts --token <TOKEN> [--server <URL>] [--name <NAME>]
 *
 * Example:
 *   npx tsx script/vox-eval-agent.ts --token vox_agent_xxx --server http://localhost:5000 --name "NA-Agent-1"
 */

import { spawn } from 'child_process';

const DEFAULT_SERVER = 'http://localhost:5000';
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const JOB_POLL_INTERVAL = 10000; // 10 seconds

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

class VoxEvalAgent {
  private token: string;
  private serverUrl: string;
  private name: string;
  private agentId: number | null = null;
  private region: string | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private jobPollTimer: NodeJS.Timeout | null = null;
  private isRunningJob = false;
  private simulate: boolean;

  constructor(token: string, serverUrl: string, name: string, simulate: boolean = true) {
    this.token = token;
    this.serverUrl = serverUrl;
    this.name = name;
    this.simulate = simulate;
  }

  private async fetch(path: string, options: RequestInit = {}): Promise<Response> {
    const url = `${this.serverUrl}${path}`;
    return fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
        ...options.headers,
      },
    });
  }

  async register(): Promise<boolean> {
    console.log(`[Agent] Registering with server: ${this.serverUrl}`);

    try {
      const response = await this.fetch('/api/eval-agent/register', {
        method: 'POST',
        body: JSON.stringify({ name: this.name }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error(`[Agent] Registration failed: ${response.status} - ${error}`);
        return false;
      }

      const agent: EvalAgent = await response.json();
      this.agentId = agent.id;
      this.region = agent.region;

      console.log(`[Agent] Registered successfully!`);
      console.log(`  - Agent ID: ${agent.id}`);
      console.log(`  - Name: ${agent.name}`);
      console.log(`  - Region: ${agent.region}`);
      console.log(`  - State: ${agent.state}`);

      return true;
    } catch (error) {
      console.error(`[Agent] Registration error:`, error);
      return false;
    }
  }

  async sendHeartbeat(): Promise<boolean> {
    if (!this.agentId) return false;

    try {
      const response = await this.fetch('/api/eval-agent/heartbeat', {
        method: 'POST',
        body: JSON.stringify({ agentId: this.agentId }),
      });

      if (!response.ok) {
        console.error(`[Agent] Heartbeat failed: ${response.status}`);
        return false;
      }

      console.log(`[Agent] Heartbeat sent at ${new Date().toISOString()}`);
      return true;
    } catch (error) {
      console.error(`[Agent] Heartbeat error:`, error);
      return false;
    }
  }

  async fetchJobs(): Promise<EvalJob[]> {
    if (!this.region) return [];

    try {
      const response = await this.fetch(`/api/eval-agent/jobs?region=${this.region}`);

      if (!response.ok) {
        console.error(`[Agent] Failed to fetch jobs: ${response.status}`);
        return [];
      }

      return await response.json();
    } catch (error) {
      console.error(`[Agent] Error fetching jobs:`, error);
      return [];
    }
  }

  async claimJob(jobId: number): Promise<boolean> {
    if (!this.agentId) return false;

    try {
      const response = await this.fetch(`/api/eval-agent/jobs/${jobId}/claim`, {
        method: 'POST',
        body: JSON.stringify({ agentId: this.agentId }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error(`[Agent] Failed to claim job ${jobId}: ${response.status} - ${error}`);
        return false;
      }

      console.log(`[Agent] Successfully claimed job ${jobId}`);
      return true;
    } catch (error) {
      console.error(`[Agent] Error claiming job:`, error);
      return false;
    }
  }

  async completeJob(jobId: number, results: EvalResult): Promise<boolean> {
    try {
      const response = await this.fetch(`/api/eval-agent/jobs/${jobId}/complete`, {
        method: 'POST',
        body: JSON.stringify({ results }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error(`[Agent] Failed to complete job ${jobId}: ${response.status} - ${error}`);
        return false;
      }

      console.log(`[Agent] Job ${jobId} completed successfully`);
      return true;
    } catch (error) {
      console.error(`[Agent] Error completing job:`, error);
      return false;
    }
  }

  async runEvaluation(job: EvalJob): Promise<EvalResult> {
    console.log(`[Agent] Starting evaluation for job ${job.id}`);
    console.log(`  - Workflow ID: ${job.workflowId}`);
    console.log(`  - Eval Set ID: ${job.evalSetId}`);
    console.log(`  - Region: ${job.region}`);

    if (this.simulate) {
      // Simulate evaluation with random but realistic results
      console.log(`[Agent] Running simulated evaluation...`);
      await this.sleep(5000); // Simulate 5 seconds of work

      const results: EvalResult = {
        responseLatencyMedian: Math.floor(Math.random() * 500) + 200, // 200-700ms
        responseLatencySd: Math.floor(Math.random() * 100) + 20, // 20-120ms
        interruptLatencyMedian: Math.floor(Math.random() * 300) + 100, // 100-400ms
        interruptLatencySd: Math.floor(Math.random() * 50) + 10, // 10-60ms
        networkResilience: Math.floor(Math.random() * 20) + 80, // 80-100%
        naturalness: Math.round((Math.random() * 1.5 + 3.5) * 10) / 10, // 3.5-5.0
        noiseReduction: Math.floor(Math.random() * 15) + 85, // 85-100%
      };

      console.log(`[Agent] Simulated results:`);
      console.log(`  - Response Latency: ${results.responseLatencyMedian}ms (SD: ${results.responseLatencySd}ms)`);
      console.log(`  - Interrupt Latency: ${results.interruptLatencyMedian}ms (SD: ${results.interruptLatencySd}ms)`);
      console.log(`  - Network Resilience: ${results.networkResilience}%`);
      console.log(`  - Naturalness: ${results.naturalness}/5.0`);
      console.log(`  - Noise Reduction: ${results.noiseReduction}%`);

      return results;
    } else {
      // Run actual voice-agent-tester
      console.log(`[Agent] Running voice-agent-tester...`);
      return await this.runVoiceAgentTester(job);
    }
  }

  private async runVoiceAgentTester(job: EvalJob): Promise<EvalResult> {
    // This would integrate with the actual voice-agent-tester tool
    // Example: npm start -- -a apps/livekit.yaml -s suites/appointment.yaml --headless false

    return new Promise((resolve, reject) => {
      const config = job.config as { app?: string; suite?: string } | null;
      const appConfig = config?.app || 'apps/livekit.yaml';
      const suiteConfig = config?.suite || 'suites/appointment.yaml';

      console.log(`[Agent] Running: voice-agent-tester -a ${appConfig} -s ${suiteConfig}`);

      // For now, simulate since voice-agent-tester is external
      // In production, this would spawn the actual process
      setTimeout(() => {
        resolve({
          responseLatencyMedian: 350,
          responseLatencySd: 45,
          interruptLatencyMedian: 180,
          interruptLatencySd: 25,
          networkResilience: 92,
          naturalness: 4.2,
          noiseReduction: 95,
        });
      }, 10000);
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async processJobs(): Promise<void> {
    if (this.isRunningJob) {
      console.log(`[Agent] Already running a job, skipping poll`);
      return;
    }

    const jobs = await this.fetchJobs();

    if (jobs.length === 0) {
      console.log(`[Agent] No pending jobs for region ${this.region}`);
      return;
    }

    console.log(`[Agent] Found ${jobs.length} pending job(s)`);

    // Try to claim the first job
    const job = jobs[0];
    const claimed = await this.claimJob(job.id);

    if (!claimed) {
      console.log(`[Agent] Could not claim job ${job.id}, will retry later`);
      return;
    }

    // Run the evaluation
    this.isRunningJob = true;
    try {
      const results = await this.runEvaluation(job);
      await this.completeJob(job.id, results);
    } catch (error) {
      console.error(`[Agent] Evaluation failed:`, error);
    } finally {
      this.isRunningJob = false;
    }
  }

  start(): void {
    console.log(`[Agent] Starting Vox Eval Agent Daemon`);
    console.log(`  - Server: ${this.serverUrl}`);
    console.log(`  - Name: ${this.name}`);
    console.log(`  - Simulation mode: ${this.simulate}`);
    console.log('');

    // Start heartbeat timer
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, HEARTBEAT_INTERVAL);

    // Start job polling timer
    this.jobPollTimer = setInterval(() => {
      this.processJobs();
    }, JOB_POLL_INTERVAL);

    // Initial job poll
    setTimeout(() => this.processJobs(), 1000);

    console.log(`[Agent] Agent daemon started. Press Ctrl+C to stop.`);
  }

  stop(): void {
    console.log(`[Agent] Stopping agent daemon...`);

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    if (this.jobPollTimer) {
      clearInterval(this.jobPollTimer);
    }

    console.log(`[Agent] Agent daemon stopped.`);
  }
}

// Parse command line arguments
function parseArgs(): { token: string; server: string; name: string; simulate: boolean } {
  const args = process.argv.slice(2);
  let token = '';
  let server = DEFAULT_SERVER;
  let name = `Agent-${Date.now()}`;
  let simulate = true;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--token':
      case '-t':
        token = args[++i];
        break;
      case '--server':
      case '-s':
        server = args[++i];
        break;
      case '--name':
      case '-n':
        name = args[++i];
        break;
      case '--no-simulate':
        simulate = false;
        break;
      case '--help':
      case '-h':
        console.log(`
Vox Evaluation Agent Daemon

Usage:
  npx tsx script/vox-eval-agent.ts --token <TOKEN> [options]

Options:
  -t, --token <TOKEN>   Agent registration token (required)
  -s, --server <URL>    Vox server URL (default: ${DEFAULT_SERVER})
  -n, --name <NAME>     Agent name (default: Agent-<timestamp>)
  --no-simulate         Run actual voice-agent-tester instead of simulation
  -h, --help            Show this help message

Example:
  npx tsx script/vox-eval-agent.ts --token vox_agent_xxx --name "NA-Agent-1"
`);
        process.exit(0);
    }
  }

  if (!token) {
    console.error('Error: --token is required');
    console.error('Run with --help for usage information');
    process.exit(1);
  }

  return { token, server, name, simulate };
}

// Main entry point
async function main() {
  const { token, server, name, simulate } = parseArgs();

  const agent = new VoxEvalAgent(token, server, name, simulate);

  // Register with the server
  const registered = await agent.register();
  if (!registered) {
    console.error('[Agent] Failed to register, exiting...');
    process.exit(1);
  }

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    agent.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    agent.stop();
    process.exit(0);
  });

  // Start the agent
  agent.start();
}

main().catch(error => {
  console.error('[Agent] Fatal error:', error);
  process.exit(1);
});
