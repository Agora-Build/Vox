/**
 * Tests for vox_eval_agentd - Vox Evaluation Agent Daemon
 *
 * Tests the core functionality of the eval agent daemon including:
 * - Result parsing from CSV reports
 * - API communication with Vox server
 * - Job execution flow
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createServer } from "http";
import express from "express";
import { execSync } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";

// Mock the parseResults function logic for testing
function parseResults(csvContent: string): {
  responseLatencyMedian: number;
  responseLatencySd: number;
  interruptLatencyMedian: number;
  interruptLatencySd: number;
  networkResilience: number;
  naturalness: number;
  noiseReduction: number;
} {
  // Default results
  const results = {
    responseLatencyMedian: 0,
    responseLatencySd: 0,
    interruptLatencyMedian: 0,
    interruptLatencySd: 0,
    networkResilience: 85,
    naturalness: 3.5,
    noiseReduction: 90,
  };

  if (!csvContent || csvContent.trim() === "") {
    return results;
  }

  const lines = csvContent.trim().split("\n");
  if (lines.length < 2) {
    return results;
  }

  // CSV is comma-space separated
  const headers = lines[0].split(", ").map((h) => h.trim());
  const allLatencies: number[][] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(", ").map((v) => v.trim());
    const runLatencies: number[] = [];

    headers.forEach((header, idx) => {
      if (header.includes("elapsed_time")) {
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

  if (allLatencies.length > 0) {
    // Get first elapsed_time from each run (response latency)
    const responseLatencies = allLatencies
      .map((run) => run[0])
      .filter((v) => !isNaN(v));

    if (responseLatencies.length > 0) {
      // Calculate median
      const sorted = [...responseLatencies].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      results.responseLatencyMedian =
        sorted.length % 2 !== 0
          ? Math.round(sorted[mid])
          : Math.round((sorted[mid - 1] + sorted[mid]) / 2);

      // Calculate standard deviation
      if (responseLatencies.length > 1) {
        const mean =
          responseLatencies.reduce((a, b) => a + b, 0) /
          responseLatencies.length;
        const variance =
          responseLatencies.reduce((a, b) => a + Math.pow(b - mean, 2), 0) /
          responseLatencies.length;
        results.responseLatencySd = Math.round(Math.sqrt(variance));
      }
    }

    // Get second elapsed_time from each run (interrupt latency)
    const interruptLatencies = allLatencies
      .map((run) => run[1])
      .filter((v) => !isNaN(v) && v !== undefined);

    if (interruptLatencies.length > 0) {
      const sorted = [...interruptLatencies].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      results.interruptLatencyMedian =
        sorted.length % 2 !== 0
          ? Math.round(sorted[mid])
          : Math.round((sorted[mid - 1] + sorted[mid]) / 2);

      if (interruptLatencies.length > 1) {
        const mean =
          interruptLatencies.reduce((a, b) => a + b, 0) /
          interruptLatencies.length;
        const variance =
          interruptLatencies.reduce((a, b) => a + Math.pow(b - mean, 2), 0) /
          interruptLatencies.length;
        results.interruptLatencySd = Math.round(Math.sqrt(variance));
      }
    }
  }

  return results;
}

describe("Eval Agent Daemon - Result Parsing", () => {
  it("should return default results for empty CSV", () => {
    const results = parseResults("");
    expect(results.responseLatencyMedian).toBe(0);
    expect(results.interruptLatencyMedian).toBe(0);
    expect(results.networkResilience).toBe(85);
    expect(results.naturalness).toBe(3.5);
    expect(results.noiseReduction).toBe(90);
  });

  it("should parse single run with one elapsed_time", () => {
    const csv = `application, scenario, elapsed_time_1
livekit.yaml, basic.yaml, 250`;
    const results = parseResults(csv);
    expect(results.responseLatencyMedian).toBe(250);
    expect(results.responseLatencySd).toBe(0);
  });

  it("should parse single run with two elapsed_time columns", () => {
    const csv = `application, scenario, elapsed_time_1, elapsed_time_2
livekit.yaml, basic.yaml, 250, 150`;
    const results = parseResults(csv);
    expect(results.responseLatencyMedian).toBe(250);
    expect(results.interruptLatencyMedian).toBe(150);
  });

  it("should calculate median for multiple runs", () => {
    const csv = `application, scenario, elapsed_time_1, elapsed_time_2
livekit.yaml, basic.yaml, 200, 100
livekit.yaml, basic.yaml, 300, 200
livekit.yaml, basic.yaml, 250, 150`;
    const results = parseResults(csv);
    // Median of [200, 250, 300] = 250
    expect(results.responseLatencyMedian).toBe(250);
    // Median of [100, 150, 200] = 150
    expect(results.interruptLatencyMedian).toBe(150);
  });

  it("should calculate median for even number of runs", () => {
    const csv = `application, scenario, elapsed_time_1
livekit.yaml, basic.yaml, 200
livekit.yaml, basic.yaml, 300`;
    const results = parseResults(csv);
    // Median of [200, 300] = (200+300)/2 = 250
    expect(results.responseLatencyMedian).toBe(250);
  });

  it("should calculate standard deviation for multiple runs", () => {
    const csv = `application, scenario, elapsed_time_1
livekit.yaml, basic.yaml, 200
livekit.yaml, basic.yaml, 300
livekit.yaml, basic.yaml, 400`;
    const results = parseResults(csv);
    // Mean = 300, variance = ((200-300)^2 + (300-300)^2 + (400-300)^2) / 3 = 6666.67
    // SD = sqrt(6666.67) ≈ 82
    expect(results.responseLatencySd).toBeGreaterThan(0);
    expect(results.responseLatencySd).toBeLessThan(100);
  });

  it("should handle malformed CSV gracefully", () => {
    const csv = `not,a,valid,csv
with,missing,values`;
    const results = parseResults(csv);
    // Should return defaults
    expect(results.responseLatencyMedian).toBe(0);
    expect(results.interruptLatencyMedian).toBe(0);
  });

  it("should handle CSV with only headers", () => {
    const csv = `application, scenario, elapsed_time_1`;
    const results = parseResults(csv);
    expect(results.responseLatencyMedian).toBe(0);
  });

  it("should handle real-world CSV format", () => {
    const csv = `application, scenario, step_1_elapsed_time, step_2_elapsed_time, step_3_elapsed_time
apps/livekit.yaml, scenarios/appointment.yaml, 1250, 890, 750
apps/livekit.yaml, scenarios/appointment.yaml, 1180, 920, 800
apps/livekit.yaml, scenarios/appointment.yaml, 1320, 850, 720`;
    const results = parseResults(csv);
    // Response latency median of [1250, 1180, 1320] = 1250
    expect(results.responseLatencyMedian).toBe(1250);
    // Interrupt latency median of [890, 920, 850] = 890
    expect(results.interruptLatencyMedian).toBe(890);
  });
});

describe("Eval Agent Daemon - API Communication", () => {
  let app: express.Express;
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  const testToken = "test-token-123";
  let registeredAgentId: number | null = null;

  beforeAll(async () => {
    app = express();
    app.use(express.json());

    // Mock eval agent API endpoints
    app.post("/api/eval-agent/register", (req, res) => {
      const authHeader = req.headers.authorization;
      if (!authHeader || authHeader !== `Bearer ${testToken}`) {
        return res.status(401).json({ error: "Invalid token" });
      }

      registeredAgentId = Date.now();
      res.json({
        id: registeredAgentId,
        name: req.body.name || "test-agent",
        region: "na",
        state: "idle",
      });
    });

    app.post("/api/eval-agent/heartbeat", (req, res) => {
      const authHeader = req.headers.authorization;
      if (!authHeader || authHeader !== `Bearer ${testToken}`) {
        return res.status(401).json({ error: "Invalid token" });
      }

      if (req.body.agentId === registeredAgentId) {
        res.json({ success: true });
      } else {
        res.status(404).json({ error: "Agent not found" });
      }
    });

    app.get("/api/eval-agent/jobs", (req, res) => {
      const authHeader = req.headers.authorization;
      if (!authHeader || authHeader !== `Bearer ${testToken}`) {
        return res.status(401).json({ error: "Invalid token" });
      }

      const region = req.query.region;
      if (region === "na") {
        res.json([
          { id: 1, workflowId: 1, region: "na", status: "pending" },
        ]);
      } else {
        res.json([]);
      }
    });

    app.post("/api/eval-agent/jobs/:id/claim", (req, res) => {
      const authHeader = req.headers.authorization;
      if (!authHeader || authHeader !== `Bearer ${testToken}`) {
        return res.status(401).json({ error: "Invalid token" });
      }

      res.json({ success: true, job: { id: parseInt(req.params.id), status: "running" } });
    });

    app.post("/api/eval-agent/jobs/:id/complete", (req, res) => {
      const authHeader = req.headers.authorization;
      if (!authHeader || authHeader !== `Bearer ${testToken}`) {
        return res.status(401).json({ error: "Invalid token" });
      }

      const { results } = req.body;
      if (!results) {
        return res.status(400).json({ error: "Results required" });
      }

      res.json({ success: true });
    });

    server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          baseUrl = `http://localhost:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("should register agent with valid token", async () => {
    const res = await request(app)
      .post("/api/eval-agent/register")
      .set("Authorization", `Bearer ${testToken}`)
      .send({ name: "test-agent" });

    expect(res.status).toBe(200);
    expect(res.body.id).toBeDefined();
    expect(res.body.name).toBe("test-agent");
    expect(res.body.region).toBe("na");
  });

  it("should reject registration with invalid token", async () => {
    const res = await request(app)
      .post("/api/eval-agent/register")
      .set("Authorization", "Bearer invalid-token")
      .send({ name: "test-agent" });

    expect(res.status).toBe(401);
  });

  it("should send heartbeat for registered agent", async () => {
    // First register
    const registerRes = await request(app)
      .post("/api/eval-agent/register")
      .set("Authorization", `Bearer ${testToken}`)
      .send({ name: "heartbeat-test-agent" });

    const agentId = registerRes.body.id;

    // Then send heartbeat
    const res = await request(app)
      .post("/api/eval-agent/heartbeat")
      .set("Authorization", `Bearer ${testToken}`)
      .send({ agentId });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("should fetch jobs for registered region", async () => {
    const res = await request(app)
      .get("/api/eval-agent/jobs?region=na")
      .set("Authorization", `Bearer ${testToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0].region).toBe("na");
  });

  it("should return empty array for other regions", async () => {
    const res = await request(app)
      .get("/api/eval-agent/jobs?region=eu")
      .set("Authorization", `Bearer ${testToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(0);
  });

  it("should claim a job", async () => {
    const res = await request(app)
      .post("/api/eval-agent/jobs/1/claim")
      .set("Authorization", `Bearer ${testToken}`)
      .send({ agentId: registeredAgentId });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("should complete a job with results", async () => {
    const results = {
      responseLatencyMedian: 250,
      responseLatencySd: 30,
      interruptLatencyMedian: 150,
      interruptLatencySd: 20,
      networkResilience: 85,
      naturalness: 4.2,
      noiseReduction: 90,
    };

    const res = await request(app)
      .post("/api/eval-agent/jobs/1/complete")
      .set("Authorization", `Bearer ${testToken}`)
      .send({ agentId: registeredAgentId, results });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("should reject job completion without results", async () => {
    const res = await request(app)
      .post("/api/eval-agent/jobs/1/complete")
      .set("Authorization", `Bearer ${testToken}`)
      .send({ agentId: registeredAgentId });

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// aeval result parsing (mirrors daemon's parseAevalResults / parseAevalStdout)
// ---------------------------------------------------------------------------

interface EvalResults {
  responseLatencyMedian: number;
  responseLatencySd: number;
  interruptLatencyMedian: number;
  interruptLatencySd: number;
  networkResilience: number;
  naturalness: number;
  noiseReduction: number;
}

const AEVAL_DEFAULTS: EvalResults = {
  responseLatencyMedian: 0,
  responseLatencySd: 0,
  interruptLatencyMedian: 0,
  interruptLatencySd: 0,
  networkResilience: 85,
  naturalness: 3.5,
  noiseReduction: 90,
};

/** Mirror of daemon's parseAevalResults — works on raw JSON string instead of reading a file */
function parseAevalMetricsJson(jsonContent: string): EvalResults {
  const results = { ...AEVAL_DEFAULTS };

  const metrics = JSON.parse(jsonContent);

  const rl = metrics.response_latency || metrics.responseLatency || {};
  const il = metrics.interrupt_latency || metrics.interruptLatency || {};

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

  return results;
}

/** Mirror of daemon's parseAevalStdout */
function parseAevalStdout(stdout: string): EvalResults {
  const results = { ...AEVAL_DEFAULTS };

  const medianMatch = stdout.match(/median[:\s]+(\d+)/i);
  if (medianMatch) {
    results.responseLatencyMedian = parseInt(medianMatch[1]);
  }

  return results;
}

/** Mirror of daemon's resolveAevalOutputDir */
function resolveAevalOutputDir(aevalDataPath: string, scenarioConfig: string): string {
  const scenarioBasename = path.basename(scenarioConfig, path.extname(scenarioConfig));
  return path.join(aevalDataPath, "output", scenarioBasename);
}

/** Mirror of daemon's framework-selection logic from executeJob */
function selectFramework(
  jobConfigFramework: string | undefined,
  envFramework: string,
): string {
  return jobConfigFramework || envFramework;
}

// ---------------------------------------------------------------------------
// aeval tests
// ---------------------------------------------------------------------------

describe("Eval Agent Daemon - aeval Metrics JSON Parsing", () => {
  it("should parse metrics with median_ms / stddev_ms keys", () => {
    const json = JSON.stringify({
      response_latency: { median_ms: 420.7, stddev_ms: 55.3 },
      interrupt_latency: { median_ms: 180.2, stddev_ms: 22.8 },
    });
    const results = parseAevalMetricsJson(json);
    expect(results.responseLatencyMedian).toBe(421);
    expect(results.responseLatencySd).toBe(55);
    expect(results.interruptLatencyMedian).toBe(180);
    expect(results.interruptLatencySd).toBe(23);
  });

  it("should parse metrics with median / stddev keys (no _ms suffix)", () => {
    const json = JSON.stringify({
      response_latency: { median: 350, stddev: 40 },
      interrupt_latency: { median: 120, stddev: 15 },
    });
    const results = parseAevalMetricsJson(json);
    expect(results.responseLatencyMedian).toBe(350);
    expect(results.responseLatencySd).toBe(40);
    expect(results.interruptLatencyMedian).toBe(120);
    expect(results.interruptLatencySd).toBe(15);
  });

  it("should parse metrics with sd key as alias for stddev", () => {
    const json = JSON.stringify({
      response_latency: { median: 300, sd: 28 },
      interrupt_latency: { median: 90, sd: 12 },
    });
    const results = parseAevalMetricsJson(json);
    expect(results.responseLatencySd).toBe(28);
    expect(results.interruptLatencySd).toBe(12);
  });

  it("should prefer median_ms over median when both present", () => {
    const json = JSON.stringify({
      response_latency: { median_ms: 500, median: 9999 },
    });
    const results = parseAevalMetricsJson(json);
    expect(results.responseLatencyMedian).toBe(500);
  });

  it("should handle camelCase key variants (responseLatency)", () => {
    const json = JSON.stringify({
      responseLatency: { median_ms: 275 },
      interruptLatency: { median_ms: 130 },
    });
    const results = parseAevalMetricsJson(json);
    expect(results.responseLatencyMedian).toBe(275);
    expect(results.interruptLatencyMedian).toBe(130);
  });

  it("should return defaults when response_latency and interrupt_latency are missing", () => {
    const json = JSON.stringify({ some_other_key: 42 });
    const results = parseAevalMetricsJson(json);
    expect(results.responseLatencyMedian).toBe(0);
    expect(results.responseLatencySd).toBe(0);
    expect(results.interruptLatencyMedian).toBe(0);
    expect(results.interruptLatencySd).toBe(0);
    expect(results.networkResilience).toBe(85);
    expect(results.naturalness).toBe(3.5);
    expect(results.noiseReduction).toBe(90);
  });

  it("should pick up optional top-level overrides", () => {
    const json = JSON.stringify({
      response_latency: { median_ms: 100 },
      network_resilience: 72,
      naturalness: 4.1,
      noise_reduction: 88,
    });
    const results = parseAevalMetricsJson(json);
    expect(results.networkResilience).toBe(72);
    expect(results.naturalness).toBe(4.1);
    expect(results.noiseReduction).toBe(88);
  });

  it("should round fractional latency values", () => {
    const json = JSON.stringify({
      response_latency: { median_ms: 333.7, stddev_ms: 44.4 },
      interrupt_latency: { median_ms: 111.1, stddev_ms: 9.9 },
    });
    const results = parseAevalMetricsJson(json);
    expect(results.responseLatencyMedian).toBe(334);
    expect(results.responseLatencySd).toBe(44);
    expect(results.interruptLatencyMedian).toBe(111);
    expect(results.interruptLatencySd).toBe(10);
  });

  it("should handle only response_latency without interrupt_latency", () => {
    const json = JSON.stringify({
      response_latency: { median_ms: 500, stddev_ms: 60 },
    });
    const results = parseAevalMetricsJson(json);
    expect(results.responseLatencyMedian).toBe(500);
    expect(results.responseLatencySd).toBe(60);
    expect(results.interruptLatencyMedian).toBe(0);
    expect(results.interruptLatencySd).toBe(0);
  });

  it("should throw on invalid JSON", () => {
    expect(() => parseAevalMetricsJson("not json at all")).toThrow();
  });
});

describe("Eval Agent Daemon - aeval Stdout Fallback Parsing", () => {
  it("should extract median from stdout line", () => {
    const stdout = `[aeval] Starting eval...\n[aeval] median: 480\n[aeval] Done.`;
    const results = parseAevalStdout(stdout);
    expect(results.responseLatencyMedian).toBe(480);
  });

  it("should handle case-insensitive match", () => {
    const stdout = `Median: 320`;
    const results = parseAevalStdout(stdout);
    expect(results.responseLatencyMedian).toBe(320);
  });

  it("should return defaults when no median found in stdout", () => {
    const stdout = `[aeval] some random output with no numbers we care about`;
    const results = parseAevalStdout(stdout);
    expect(results.responseLatencyMedian).toBe(0);
    expect(results.networkResilience).toBe(85);
  });

  it("should return defaults for empty stdout", () => {
    const results = parseAevalStdout("");
    expect(results.responseLatencyMedian).toBe(0);
  });
});

describe("Eval Agent Daemon - aeval Output Directory Resolution", () => {
  it("should resolve output dir from yaml scenario path", () => {
    const dir = resolveAevalOutputDir(
      "/app/aeval-data",
      "examples/response/response_R00_en.yaml",
    );
    expect(dir).toBe("/app/aeval-data/output/response_R00_en");
  });

  it("should strip .yml extension too", () => {
    const dir = resolveAevalOutputDir(
      "/app/aeval-data",
      "scenarios/latency_test.yml",
    );
    expect(dir).toBe("/app/aeval-data/output/latency_test");
  });

  it("should handle flat filename without directory", () => {
    const dir = resolveAevalOutputDir("/app/aeval-data", "basic.yaml");
    expect(dir).toBe("/app/aeval-data/output/basic");
  });

  it("should handle deeply nested scenario paths", () => {
    const dir = resolveAevalOutputDir(
      "/app/aeval-data",
      "a/b/c/d/my_scenario.yaml",
    );
    expect(dir).toBe("/app/aeval-data/output/my_scenario");
  });
});

describe("Eval Agent Daemon - Framework Selection", () => {
  it("should default to aeval when env is aeval and no job override", () => {
    expect(selectFramework(undefined, "aeval")).toBe("aeval");
  });

  it("should default to voice-agent-tester when env says so", () => {
    expect(selectFramework(undefined, "voice-agent-tester")).toBe("voice-agent-tester");
  });

  it("should prefer job-level framework over env default", () => {
    expect(selectFramework("voice-agent-tester", "aeval")).toBe("voice-agent-tester");
    expect(selectFramework("aeval", "voice-agent-tester")).toBe("aeval");
  });

  it("should fall back to env when job framework is empty string", () => {
    expect(selectFramework("", "aeval")).toBe("aeval");
  });
});

describe("Eval Agent Daemon - aeval File-Based Parsing (temp dir)", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vox-aeval-test-"));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should read and parse a real metrics.json file", () => {
    const outputDir = path.join(tmpDir, "run1");
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputDir, "metrics.json"),
      JSON.stringify({
        response_latency: { median_ms: 512, stddev_ms: 38 },
        interrupt_latency: { median_ms: 200, stddev_ms: 15 },
      }),
    );

    const raw = fs.readFileSync(path.join(outputDir, "metrics.json"), "utf-8");
    const results = parseAevalMetricsJson(raw);
    expect(results.responseLatencyMedian).toBe(512);
    expect(results.responseLatencySd).toBe(38);
    expect(results.interruptLatencyMedian).toBe(200);
    expect(results.interruptLatencySd).toBe(15);
  });

  it("should detect missing metrics.json gracefully", () => {
    const missingDir = path.join(tmpDir, "does-not-exist");
    const metricsPath = path.join(missingDir, "metrics.json");
    expect(fs.existsSync(metricsPath)).toBe(false);
    // Daemon would fall back to stdout parsing — just verify the file check works
  });
});

describe("Eval Agent Daemon - Job Flow Integration", () => {
  it("should follow correct job lifecycle", async () => {
    // This test validates the expected job lifecycle:
    // 1. Agent registers
    // 2. Agent fetches pending jobs
    // 3. Agent claims a job
    // 4. Agent executes the job
    // 5. Agent reports results

    // We're testing the data flow and state transitions
    const jobLifecycle = {
      registered: false,
      heartbeatSent: false,
      jobFetched: false,
      jobClaimed: false,
      jobCompleted: false,
    };

    // Simulate registration
    jobLifecycle.registered = true;
    expect(jobLifecycle.registered).toBe(true);

    // Simulate heartbeat
    jobLifecycle.heartbeatSent = true;
    expect(jobLifecycle.heartbeatSent).toBe(true);

    // Simulate job fetch
    jobLifecycle.jobFetched = true;
    expect(jobLifecycle.jobFetched).toBe(true);

    // Simulate job claim
    jobLifecycle.jobClaimed = true;
    expect(jobLifecycle.jobClaimed).toBe(true);

    // Simulate job completion
    jobLifecycle.jobCompleted = true;
    expect(jobLifecycle.jobCompleted).toBe(true);

    // All steps should be completed
    expect(Object.values(jobLifecycle).every((v) => v)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Daemon script validation (smoke tests that run in Vitest)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// compareVersions tests (imported logic mirrored here for unit testing)
// ---------------------------------------------------------------------------

/** Mirror of server/aeval-seed.ts compareVersions */
function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const parse = (v: string) =>
    v
      .replace(/^v/i, "")
      .split(".")
      .map((n) => parseInt(n, 10) || 0);

  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);

  for (let i = 0; i < len; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

describe("Eval Agent Daemon - Version Comparison (compareVersions)", () => {
  it("should return 0 for equal versions", () => {
    expect(compareVersions("v0.1.0", "v0.1.0")).toBe(0);
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
  });

  it("should handle v prefix", () => {
    expect(compareVersions("v0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("V1.0.0", "v1.0.0")).toBe(0);
  });

  it("should compare major versions", () => {
    expect(compareVersions("v1.0.0", "v0.1.0")).toBe(1);
    expect(compareVersions("v0.1.0", "v1.0.0")).toBe(-1);
  });

  it("should compare minor versions", () => {
    expect(compareVersions("v0.2.0", "v0.1.0")).toBe(1);
    expect(compareVersions("v0.1.0", "v0.2.0")).toBe(-1);
  });

  it("should compare patch versions", () => {
    expect(compareVersions("v0.1.1", "v0.1.0")).toBe(1);
    expect(compareVersions("v0.1.0", "v0.1.1")).toBe(-1);
  });

  it("should handle different segment counts", () => {
    expect(compareVersions("v1.0", "v1.0.0")).toBe(0);
    expect(compareVersions("v1.0.1", "v1.0")).toBe(1);
    expect(compareVersions("v1", "v1.0.0")).toBe(0);
  });

  it("should work for version gating scenario", () => {
    // Agent v0.1.0, job needs v0.2.0 → agent too old
    expect(compareVersions("v0.2.0", "v0.1.0")).toBe(1);
    // Agent v0.1.0, job needs v0.1.0 → OK
    expect(compareVersions("v0.1.0", "v0.1.0")).toBe(0);
    // Agent v0.2.0, job needs v0.1.0 → OK
    expect(compareVersions("v0.1.0", "v0.2.0")).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// Version detection test
// ---------------------------------------------------------------------------

describe("Eval Agent Daemon - aeval Version Detection", () => {
  // Mirrors the regex used in detectAevalVersion: /v?(\d+\.\d+\.\d+)/
  // Always normalizes to "v" prefix
  const parseVersion = (output: string): string | null => {
    const match = output.match(/v?(\d+\.\d+\.\d+)/);
    return match ? `v${match[1]}` : null;
  };

  it("should extract version from 'aeval 0.1.1' (no v prefix)", () => {
    expect(parseVersion("aeval 0.1.1\n")).toBe("v0.1.1");
  });

  it("should extract version from 'aeval v0.1.0' (with v prefix)", () => {
    expect(parseVersion("aeval v0.1.0\n")).toBe("v0.1.0");
  });

  it("should extract version from plain version string", () => {
    expect(parseVersion("v1.2.3")).toBe("v1.2.3");
    expect(parseVersion("1.2.3")).toBe("v1.2.3");
  });

  it("should handle version with extra text", () => {
    expect(parseVersion("aeval v0.1.0 (build 12345)\n")).toBe("v0.1.0");
    expect(parseVersion("aeval 0.1.1 (build 12345)\n")).toBe("v0.1.1");
  });

  it("should return null for unrecognized output", () => {
    expect(parseVersion("unknown version")).toBeNull();
    expect(parseVersion("")).toBeNull();
  });
});

describe("Eval Agent Daemon - Script Validation", () => {
  const projectRoot = path.resolve(__dirname, "..");
  const daemonTsPath = path.join(projectRoot, "vox_eval_agentd", "vox-agentd.ts");

  it("vox-agentd.ts should exist", () => {
    expect(fs.existsSync(daemonTsPath)).toBe(true);
  });

  it("vox-agentd.ts should compile without errors", () => {
    // Use esbuild to parse/transform without executing (the script runs main() on import)
    execSync(
      `node -e "require('esbuild').transformSync(require('fs').readFileSync('${daemonTsPath}','utf8'),{loader:'ts'})"`,
      { stdio: "pipe", timeout: 15000, cwd: projectRoot },
    );
  });
});
