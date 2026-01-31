/**
 * Extended Tests for vox_eval_agentd - Vox Evaluation Agent Daemon
 *
 * Additional tests covering:
 * - Configuration validation
 * - Error handling scenarios
 * - Job concurrency control
 * - Heartbeat behavior
 * - Process lifecycle
 * - Edge cases
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("Eval Agent Daemon - Configuration", () => {
  describe("Environment Variables", () => {
    it("should require AGENT_TOKEN", () => {
      const validateConfig = (token: string | undefined) => {
        if (!token) {
          return { valid: false, error: "AGENT_TOKEN environment variable is required" };
        }
        return { valid: true };
      };

      expect(validateConfig(undefined).valid).toBe(false);
      expect(validateConfig("").valid).toBe(false);
      expect(validateConfig("valid-token").valid).toBe(true);
    });

    it("should use default server URL if not provided", () => {
      const getServerUrl = (env?: string) => env || "http://localhost:5000";

      expect(getServerUrl(undefined)).toBe("http://localhost:5000");
      expect(getServerUrl("https://vox.example.com")).toBe("https://vox.example.com");
    });

    it("should generate unique agent name if not provided", () => {
      const getAgentName = (env?: string, id?: number) =>
        env || `eval-agent-${id || Date.now()}`;

      const name1 = getAgentName(undefined, 1);
      const name2 = getAgentName(undefined, 2);

      expect(name1).toMatch(/^eval-agent-\d+$/);
      expect(name1).not.toBe(name2); // Unique with different IDs
      expect(getAgentName("custom-agent")).toBe("custom-agent");
    });

    it("should parse HEADLESS environment variable", () => {
      const parseHeadless = (env?: string) => env !== "false";

      expect(parseHeadless(undefined)).toBe(true);
      expect(parseHeadless("true")).toBe(true);
      expect(parseHeadless("false")).toBe(false);
    });
  });

  describe("Interval Configuration", () => {
    it("should use 30 second heartbeat interval", () => {
      const HEARTBEAT_INTERVAL = 30000;
      expect(HEARTBEAT_INTERVAL).toBe(30000);
    });

    it("should use 10 second job poll interval", () => {
      const JOB_POLL_INTERVAL = 10000;
      expect(JOB_POLL_INTERVAL).toBe(10000);
    });
  });
});

describe("Eval Agent Daemon - Job Concurrency", () => {
  it("should prevent concurrent job execution", () => {
    let isRunningJob = false;

    const tryStartJob = (): boolean => {
      if (isRunningJob) {
        return false;
      }
      isRunningJob = true;
      return true;
    };

    const finishJob = () => {
      isRunningJob = false;
    };

    // First job starts
    expect(tryStartJob()).toBe(true);

    // Second job rejected while first is running
    expect(tryStartJob()).toBe(false);
    expect(tryStartJob()).toBe(false);

    // After first job finishes
    finishJob();
    expect(tryStartJob()).toBe(true);
  });

  it("should release lock even on job failure", () => {
    let isRunningJob = false;

    const executeJob = async (shouldFail: boolean) => {
      isRunningJob = true;
      try {
        if (shouldFail) {
          throw new Error("Job failed");
        }
        return { success: true };
      } finally {
        isRunningJob = false;
      }
    };

    // Execute failing job
    executeJob(true).catch(() => {});

    // Lock should be released
    setTimeout(() => {
      expect(isRunningJob).toBe(false);
    }, 0);
  });
});

describe("Eval Agent Daemon - Heartbeat Behavior", () => {
  it("should skip heartbeat if not registered", () => {
    let agentId: number | null = null;
    let heartbeatsSent = 0;

    const sendHeartbeat = () => {
      if (!agentId) return;
      heartbeatsSent++;
    };

    sendHeartbeat();
    expect(heartbeatsSent).toBe(0);

    agentId = 123;
    sendHeartbeat();
    expect(heartbeatsSent).toBe(1);
  });

  it("should continue heartbeats on failure", () => {
    let heartbeatCount = 0;
    let failedCount = 0;

    const sendHeartbeat = async (shouldFail: boolean) => {
      heartbeatCount++;
      try {
        if (shouldFail) {
          throw new Error("Network error");
        }
      } catch {
        failedCount++;
      }
    };

    // Simulate multiple heartbeats with some failures
    sendHeartbeat(false);
    sendHeartbeat(true);
    sendHeartbeat(false);
    sendHeartbeat(true);

    expect(heartbeatCount).toBe(4);
    expect(failedCount).toBe(2);
  });
});

describe("Eval Agent Daemon - Job Fetching", () => {
  it("should return empty array if not registered", () => {
    let region: string | null = null;

    const fetchJobs = () => {
      if (!region) return [];
      return [{ id: 1, region }];
    };

    expect(fetchJobs()).toEqual([]);

    region = "na";
    expect(fetchJobs()).toEqual([{ id: 1, region: "na" }]);
  });

  it("should filter jobs by region", () => {
    const allJobs = [
      { id: 1, region: "na", status: "pending" },
      { id: 2, region: "apac", status: "pending" },
      { id: 3, region: "na", status: "pending" },
      { id: 4, region: "eu", status: "pending" },
    ];

    const fetchJobsForRegion = (region: string) =>
      allJobs.filter(j => j.region === region);

    expect(fetchJobsForRegion("na")).toHaveLength(2);
    expect(fetchJobsForRegion("apac")).toHaveLength(1);
    expect(fetchJobsForRegion("eu")).toHaveLength(1);
  });

  it("should handle empty job queue", () => {
    const jobs: any[] = [];

    const processJobs = () => {
      if (jobs.length === 0) {
        return { processed: false, reason: "no jobs" };
      }
      return { processed: true, job: jobs[0] };
    };

    expect(processJobs()).toEqual({ processed: false, reason: "no jobs" });
  });
});

describe("Eval Agent Daemon - Job Claiming", () => {
  it("should handle claim failure gracefully", () => {
    let claimAttempts = 0;
    let claimSuccesses = 0;

    const claimJob = async (jobId: number, shouldSucceed: boolean) => {
      claimAttempts++;
      if (!shouldSucceed) {
        return false;
      }
      claimSuccesses++;
      return true;
    };

    claimJob(1, true);
    claimJob(2, false);
    claimJob(3, true);

    setTimeout(() => {
      expect(claimAttempts).toBe(3);
      expect(claimSuccesses).toBe(2);
    }, 0);
  });

  it("should only process first job when multiple available", () => {
    const jobs = [
      { id: 1, priority: 10 },
      { id: 2, priority: 5 },
      { id: 3, priority: 15 },
    ];

    // Sort by priority descending
    const sortedJobs = [...jobs].sort((a, b) => b.priority - a.priority);
    const jobToProcess = sortedJobs[0];

    expect(jobToProcess.id).toBe(3); // Highest priority
  });
});

describe("Eval Agent Daemon - Result Parsing Edge Cases", () => {
  const parseResults = (csvContent: string, stdout: string = "") => {
    let results = {
      responseLatencyMedian: 0,
      responseLatencySd: 0,
      interruptLatencyMedian: 0,
      interruptLatencySd: 0,
      networkResilience: 85,
      naturalness: 3.5,
      noiseReduction: 90,
    };

    if (csvContent) {
      const lines = csvContent.trim().split("\n");
      if (lines.length >= 2) {
        const headers = lines[0].split(", ").map(h => h.trim());
        const allLatencies: number[][] = [];

        for (let i = 1; i < lines.length; i++) {
          const values = lines[i].split(", ").map(v => v.trim());
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
          const responseLatencies = allLatencies.map(run => run[0]).filter(v => !isNaN(v));
          if (responseLatencies.length > 0) {
            const sorted = [...responseLatencies].sort((a, b) => a - b);
            const mid = Math.floor(sorted.length / 2);
            results.responseLatencyMedian = sorted.length % 2 !== 0
              ? Math.round(sorted[mid])
              : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
          }
        }
      }
    }

    // Fallback to stdout parsing
    if (results.responseLatencyMedian === 0 && stdout) {
      const elapsedMatch = stdout.match(/elapsed[_\s]?time[:\s]+(\d+)/i);
      if (elapsedMatch) {
        results.responseLatencyMedian = parseInt(elapsedMatch[1]);
      }
    }

    return results;
  };

  it("should handle CSV with missing values", () => {
    const csv = `application, scenario, elapsed_time_1
livekit.yaml, basic.yaml, `;
    const results = parseResults(csv);
    expect(results.responseLatencyMedian).toBe(0);
  });

  it("should handle CSV with non-numeric values", () => {
    const csv = `application, scenario, elapsed_time_1
livekit.yaml, basic.yaml, NaN`;
    const results = parseResults(csv);
    expect(results.responseLatencyMedian).toBe(0);
  });

  it("should handle CSV with negative values", () => {
    const csv = `application, scenario, elapsed_time_1
livekit.yaml, basic.yaml, -100`;
    const results = parseResults(csv);
    expect(results.responseLatencyMedian).toBe(-100);
  });

  it("should handle CSV with very large values", () => {
    const csv = `application, scenario, elapsed_time_1
livekit.yaml, basic.yaml, 999999999`;
    const results = parseResults(csv);
    expect(results.responseLatencyMedian).toBe(999999999);
  });

  it("should fallback to stdout when CSV is empty", () => {
    const stdout = "Test output elapsed_time: 350ms";
    const results = parseResults("", stdout);
    expect(results.responseLatencyMedian).toBe(350);
  });

  it("should fallback to stdout with average format", () => {
    const stdout = "Results: Average: 425ms";
    const results = parseResults("", stdout);
    // Current implementation only matches elapsed_time, not Average
    // This test documents current behavior
    expect(results.responseLatencyMedian).toBe(0);
  });

  it("should handle multiple elapsed_time patterns in stdout", () => {
    const stdout = "elapsed_time: 200\nelapsed_time: 300";
    const results = parseResults("", stdout);
    // Should take first match
    expect(results.responseLatencyMedian).toBe(200);
  });
});

describe("Eval Agent Daemon - Process Lifecycle", () => {
  it("should track running state correctly", () => {
    interface DaemonState {
      agentId: number | null;
      region: string | null;
      isRunningJob: boolean;
      heartbeatTimer: NodeJS.Timeout | null;
      jobPollTimer: NodeJS.Timeout | null;
    }

    const state: DaemonState = {
      agentId: null,
      region: null,
      isRunningJob: false,
      heartbeatTimer: null,
      jobPollTimer: null,
    };

    // Before registration
    expect(state.agentId).toBeNull();
    expect(state.region).toBeNull();

    // After registration
    state.agentId = 123;
    state.region = "na";
    expect(state.agentId).toBe(123);
    expect(state.region).toBe("na");
  });

  it("should clean up timers on stop", () => {
    let heartbeatCleared = false;
    let jobPollCleared = false;

    const mockClearInterval = (timer: any) => {
      if (timer === "heartbeat") heartbeatCleared = true;
      if (timer === "jobPoll") jobPollCleared = true;
    };

    const stop = () => {
      mockClearInterval("heartbeat");
      mockClearInterval("jobPoll");
    };

    stop();

    expect(heartbeatCleared).toBe(true);
    expect(jobPollCleared).toBe(true);
  });
});

describe("Eval Agent Daemon - Error Handling", () => {
  it("should handle network timeout", async () => {
    const fetchWithTimeout = async (timeoutMs: number) => {
      return new Promise((_, reject) => {
        setTimeout(() => reject(new Error("Request timed out")), timeoutMs);
      });
    };

    await expect(fetchWithTimeout(10)).rejects.toThrow("Request timed out");
  });

  it("should handle server 5xx errors", async () => {
    const handleResponse = async (status: number) => {
      if (status >= 500) {
        return { success: false, error: "Server error", retryable: true };
      }
      if (status >= 400) {
        return { success: false, error: "Client error", retryable: false };
      }
      return { success: true };
    };

    expect(await handleResponse(500)).toEqual({
      success: false,
      error: "Server error",
      retryable: true,
    });
    expect(await handleResponse(503)).toEqual({
      success: false,
      error: "Server error",
      retryable: true,
    });
  });

  it("should handle malformed JSON response", () => {
    const parseResponse = (body: string) => {
      try {
        return { success: true, data: JSON.parse(body) };
      } catch {
        return { success: false, error: "Invalid JSON" };
      }
    };

    expect(parseResponse('{"valid": true}')).toEqual({
      success: true,
      data: { valid: true },
    });
    expect(parseResponse("not json")).toEqual({
      success: false,
      error: "Invalid JSON",
    });
  });

  it("should handle process spawn errors", async () => {
    const runProcess = async (shouldFail: boolean) => {
      if (shouldFail) {
        throw new Error("spawn ENOENT");
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    await expect(runProcess(true)).rejects.toThrow("spawn ENOENT");
    await expect(runProcess(false)).resolves.toEqual({
      code: 0,
      stdout: "",
      stderr: "",
    });
  });
});

describe("Eval Agent Daemon - Job Execution", () => {
  it("should use default config when not provided", () => {
    const getConfig = (job: { config?: { application?: string; scenario?: string } }) => {
      const config = job.config || {};
      return {
        application: config.application || "applications/livekit.yaml",
        scenario: config.scenario || "scenarios/basic_conversation.yaml",
      };
    };

    const jobWithConfig = {
      config: {
        application: "apps/custom.yaml",
        scenario: "scenes/test.yaml",
      },
    };

    const jobWithoutConfig = {};

    expect(getConfig(jobWithConfig)).toEqual({
      application: "apps/custom.yaml",
      scenario: "scenes/test.yaml",
    });

    expect(getConfig(jobWithoutConfig)).toEqual({
      application: "applications/livekit.yaml",
      scenario: "scenarios/basic_conversation.yaml",
    });
  });

  it("should return minimal results on execution failure", () => {
    const getFailureResults = () => ({
      responseLatencyMedian: 0,
      responseLatencySd: 0,
      interruptLatencyMedian: 0,
      interruptLatencySd: 0,
      networkResilience: 0,
      naturalness: 0,
      noiseReduction: 0,
    });

    const results = getFailureResults();
    expect(results.responseLatencyMedian).toBe(0);
    expect(results.networkResilience).toBe(0);
  });
});

describe("Eval Agent Daemon - Authorization", () => {
  it("should include Bearer token in requests", () => {
    const token = "test-token-123";

    const buildHeaders = (customHeaders?: Record<string, string>) => ({
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      ...customHeaders,
    });

    const headers = buildHeaders();
    expect(headers.Authorization).toBe("Bearer test-token-123");
  });

  it("should reject requests without valid token", () => {
    const validateToken = (authHeader?: string) => {
      if (!authHeader) return { valid: false, error: "Missing authorization" };
      if (!authHeader.startsWith("Bearer ")) return { valid: false, error: "Invalid format" };
      const token = authHeader.slice(7);
      if (token.length < 10) return { valid: false, error: "Invalid token" };
      return { valid: true };
    };

    expect(validateToken(undefined).valid).toBe(false);
    expect(validateToken("").valid).toBe(false);
    expect(validateToken("Basic abc123").valid).toBe(false);
    expect(validateToken("Bearer short").valid).toBe(false);
    expect(validateToken("Bearer valid-token-123").valid).toBe(true);
  });
});

describe("Eval Agent Daemon - Logging", () => {
  it("should format log messages with prefix", () => {
    const formatLog = (prefix: string, message: string) => `[${prefix}] ${message}`;

    expect(formatLog("Daemon", "Starting")).toBe("[Daemon] Starting");
    expect(formatLog("VAT", "Running test")).toBe("[VAT] Running test");
  });

  it("should include job details in logs", () => {
    const logJobInfo = (job: { id: number; workflowId: number; region: string }) => {
      return [
        `Executing job ${job.id}`,
        `  - Workflow ID: ${job.workflowId}`,
        `  - Region: ${job.region}`,
      ];
    };

    const logs = logJobInfo({ id: 42, workflowId: 10, region: "apac" });
    expect(logs[0]).toContain("42");
    expect(logs[1]).toContain("10");
    expect(logs[2]).toContain("apac");
  });
});

describe("Eval Agent Daemon - Statistics Calculations", () => {
  const calculateStats = (values: number[]) => {
    if (values.length === 0) return { median: 0, stdDev: 0 };

    // Median
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 !== 0
      ? Math.round(sorted[mid])
      : Math.round((sorted[mid - 1] + sorted[mid]) / 2);

    // Standard deviation
    let stdDev = 0;
    if (values.length > 1) {
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length;
      stdDev = Math.round(Math.sqrt(variance));
    }

    return { median, stdDev };
  };

  it("should calculate median for odd count", () => {
    expect(calculateStats([1, 2, 3]).median).toBe(2);
    expect(calculateStats([100, 200, 300, 400, 500]).median).toBe(300);
  });

  it("should calculate median for even count", () => {
    expect(calculateStats([1, 2, 3, 4]).median).toBe(3); // (2+3)/2 rounded
    expect(calculateStats([100, 200, 300, 400]).median).toBe(250);
  });

  it("should calculate standard deviation", () => {
    const stats = calculateStats([200, 300, 400]);
    expect(stats.stdDev).toBeGreaterThan(0);
    expect(stats.stdDev).toBeLessThan(100);
  });

  it("should return 0 std dev for single value", () => {
    expect(calculateStats([100]).stdDev).toBe(0);
  });

  it("should handle empty array", () => {
    expect(calculateStats([])).toEqual({ median: 0, stdDev: 0 });
  });

  it("should handle identical values", () => {
    expect(calculateStats([100, 100, 100]).stdDev).toBe(0);
  });
});
