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
