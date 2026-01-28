/**
 * Job Recovery Tests
 *
 * Tests for the fault tolerance mechanism that handles:
 * - Agent crashes/disconnects
 * - Stale job detection
 * - Job reassignment to new agents
 * - Retry limits and failure handling
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

describe("Job Recovery - Stale Job Detection", () => {
  const STALE_THRESHOLD_MINUTES = 5;

  interface EvalAgent {
    id: number;
    name: string;
    region: string;
    state: "idle" | "occupied" | "offline";
    lastSeenAt: Date;
  }

  interface EvalJob {
    id: number;
    evalAgentId: number | null;
    status: "pending" | "running" | "completed" | "failed";
    retryCount: number;
    maxRetries: number;
    startedAt: Date | null;
    error: string | null;
  }

  const createAgent = (overrides: Partial<EvalAgent> = {}): EvalAgent => ({
    id: 1,
    name: "test-agent",
    region: "na",
    state: "idle",
    lastSeenAt: new Date(),
    ...overrides,
  });

  const createJob = (overrides: Partial<EvalJob> = {}): EvalJob => ({
    id: 1,
    evalAgentId: null,
    status: "pending",
    retryCount: 0,
    maxRetries: 3,
    startedAt: null,
    error: null,
    ...overrides,
  });

  describe("isAgentStale", () => {
    const isAgentStale = (agent: EvalAgent, thresholdMinutes: number): boolean => {
      const staleThreshold = new Date(Date.now() - thresholdMinutes * 60 * 1000);
      return agent.lastSeenAt < staleThreshold;
    };

    it("should detect stale agent when last heartbeat is old", () => {
      const staleAgent = createAgent({
        lastSeenAt: new Date(Date.now() - 10 * 60 * 1000), // 10 minutes ago
      });
      expect(isAgentStale(staleAgent, STALE_THRESHOLD_MINUTES)).toBe(true);
    });

    it("should not detect fresh agent as stale", () => {
      const freshAgent = createAgent({
        lastSeenAt: new Date(Date.now() - 2 * 60 * 1000), // 2 minutes ago
      });
      expect(isAgentStale(freshAgent, STALE_THRESHOLD_MINUTES)).toBe(false);
    });

    it("should detect agent exactly at threshold as stale", () => {
      const borderlineAgent = createAgent({
        lastSeenAt: new Date(Date.now() - 5 * 60 * 1000 - 1), // Just over 5 minutes
      });
      expect(isAgentStale(borderlineAgent, STALE_THRESHOLD_MINUTES)).toBe(true);
    });

    it("should not detect agent just under threshold as stale", () => {
      const borderlineAgent = createAgent({
        lastSeenAt: new Date(Date.now() - 5 * 60 * 1000 + 1000), // Just under 5 minutes
      });
      expect(isAgentStale(borderlineAgent, STALE_THRESHOLD_MINUTES)).toBe(false);
    });
  });

  describe("getStaleRunningJobs", () => {
    it("should find jobs with stale agents", () => {
      const agents: EvalAgent[] = [
        createAgent({ id: 1, lastSeenAt: new Date(Date.now() - 10 * 60 * 1000) }), // Stale
        createAgent({ id: 2, lastSeenAt: new Date() }), // Fresh
      ];

      const jobs: EvalJob[] = [
        createJob({ id: 1, evalAgentId: 1, status: "running" }), // Stale agent
        createJob({ id: 2, evalAgentId: 2, status: "running" }), // Fresh agent
        createJob({ id: 3, evalAgentId: null, status: "pending" }), // No agent
      ];

      const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MINUTES * 60 * 1000);

      const staleJobs = jobs.filter(job => {
        if (job.status !== "running" || !job.evalAgentId) return false;
        const agent = agents.find(a => a.id === job.evalAgentId);
        return agent && agent.lastSeenAt < staleThreshold;
      });

      expect(staleJobs).toHaveLength(1);
      expect(staleJobs[0].id).toBe(1);
    });

    it("should not find completed jobs as stale", () => {
      const staleAgent = createAgent({
        id: 1,
        lastSeenAt: new Date(Date.now() - 10 * 60 * 1000),
      });

      const completedJob = createJob({
        id: 1,
        evalAgentId: 1,
        status: "completed",
      });

      const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MINUTES * 60 * 1000);

      const isStale = completedJob.status === "running" &&
        completedJob.evalAgentId === staleAgent.id &&
        staleAgent.lastSeenAt < staleThreshold;

      expect(isStale).toBe(false);
    });
  });
});

describe("Job Recovery - Release and Retry", () => {
  interface Job {
    id: number;
    evalAgentId: number | null;
    status: "pending" | "running" | "completed" | "failed";
    retryCount: number;
    maxRetries: number;
    startedAt: Date | null;
    error: string | null;
  }

  const releaseStaleJob = (job: Job): Job => {
    if (job.retryCount >= job.maxRetries) {
      // Max retries exceeded - mark as failed
      return {
        ...job,
        status: "failed",
        error: "Agent timeout - max retries exceeded",
        evalAgentId: null,
        retryCount: job.retryCount + 1,
      };
    } else {
      // Release back to pending for retry
      return {
        ...job,
        status: "pending",
        evalAgentId: null,
        startedAt: null,
        error: null,
        retryCount: job.retryCount + 1,
      };
    }
  };

  it("should release job back to pending when retries remain", () => {
    const runningJob: Job = {
      id: 1,
      evalAgentId: 5,
      status: "running",
      retryCount: 1,
      maxRetries: 3,
      startedAt: new Date(),
      error: null,
    };

    const released = releaseStaleJob(runningJob);

    expect(released.status).toBe("pending");
    expect(released.evalAgentId).toBeNull();
    expect(released.startedAt).toBeNull();
    expect(released.retryCount).toBe(2);
    expect(released.error).toBeNull();
  });

  it("should mark job as failed when max retries exceeded", () => {
    const runningJob: Job = {
      id: 1,
      evalAgentId: 5,
      status: "running",
      retryCount: 3,
      maxRetries: 3,
      startedAt: new Date(),
      error: null,
    };

    const released = releaseStaleJob(runningJob);

    expect(released.status).toBe("failed");
    expect(released.evalAgentId).toBeNull();
    expect(released.error).toBe("Agent timeout - max retries exceeded");
    expect(released.retryCount).toBe(4);
  });

  it("should increment retry count on each release", () => {
    let job: Job = {
      id: 1,
      evalAgentId: 5,
      status: "running",
      retryCount: 0,
      maxRetries: 3,
      startedAt: new Date(),
      error: null,
    };

    // First retry
    job = releaseStaleJob(job);
    expect(job.retryCount).toBe(1);
    expect(job.status).toBe("pending");

    // Simulate being picked up and running again
    job.status = "running";
    job.evalAgentId = 6;

    // Second retry
    job = releaseStaleJob(job);
    expect(job.retryCount).toBe(2);
    expect(job.status).toBe("pending");

    // Third retry
    job.status = "running";
    job.evalAgentId = 7;
    job = releaseStaleJob(job);
    expect(job.retryCount).toBe(3);
    expect(job.status).toBe("pending");

    // Fourth attempt - max retries exceeded
    job.status = "running";
    job.evalAgentId = 8;
    job = releaseStaleJob(job);
    expect(job.retryCount).toBe(4);
    expect(job.status).toBe("failed");
  });
});

describe("Job Recovery - Agent State Management", () => {
  type AgentState = "idle" | "occupied" | "offline";

  interface Agent {
    id: number;
    state: AgentState;
    lastSeenAt: Date;
  }

  const markOfflineAgents = (
    agents: Agent[],
    thresholdMinutes: number
  ): Agent[] => {
    const staleThreshold = new Date(Date.now() - thresholdMinutes * 60 * 1000);

    return agents.map(agent => {
      if (agent.lastSeenAt < staleThreshold && agent.state !== "offline") {
        return { ...agent, state: "offline" as AgentState };
      }
      return agent;
    });
  };

  it("should mark stale agents as offline", () => {
    const agents: Agent[] = [
      { id: 1, state: "idle", lastSeenAt: new Date(Date.now() - 10 * 60 * 1000) },
      { id: 2, state: "occupied", lastSeenAt: new Date(Date.now() - 10 * 60 * 1000) },
      { id: 3, state: "idle", lastSeenAt: new Date() },
    ];

    const updated = markOfflineAgents(agents, 5);

    expect(updated[0].state).toBe("offline");
    expect(updated[1].state).toBe("offline");
    expect(updated[2].state).toBe("idle");
  });

  it("should not change already offline agents", () => {
    const agents: Agent[] = [
      { id: 1, state: "offline", lastSeenAt: new Date(Date.now() - 60 * 60 * 1000) },
    ];

    const updated = markOfflineAgents(agents, 5);

    expect(updated[0].state).toBe("offline");
  });

  it("should count offline agents correctly", () => {
    const agents: Agent[] = [
      { id: 1, state: "idle", lastSeenAt: new Date(Date.now() - 10 * 60 * 1000) },
      { id: 2, state: "occupied", lastSeenAt: new Date(Date.now() - 10 * 60 * 1000) },
      { id: 3, state: "offline", lastSeenAt: new Date(Date.now() - 60 * 60 * 1000) },
      { id: 4, state: "idle", lastSeenAt: new Date() },
    ];

    const staleThreshold = new Date(Date.now() - 5 * 60 * 1000);
    const markedOffline = agents.filter(
      a => a.lastSeenAt < staleThreshold && a.state !== "offline"
    ).length;

    expect(markedOffline).toBe(2);
  });
});

describe("Job Recovery - Full Recovery Flow", () => {
  interface Agent {
    id: number;
    state: "idle" | "occupied" | "offline";
    lastSeenAt: Date;
    region: string;
  }

  interface Job {
    id: number;
    evalAgentId: number | null;
    status: "pending" | "running" | "completed" | "failed";
    retryCount: number;
    maxRetries: number;
    region: string;
  }

  it("should allow another agent to pick up released job", () => {
    // Initial state: Job running on Agent 1
    let agents: Agent[] = [
      { id: 1, state: "occupied", lastSeenAt: new Date(), region: "na" },
      { id: 2, state: "idle", lastSeenAt: new Date(), region: "na" },
    ];

    let job: Job = {
      id: 1,
      evalAgentId: 1,
      status: "running",
      retryCount: 0,
      maxRetries: 3,
      region: "na",
    };

    // Agent 1 crashes (simulate by making lastSeenAt old)
    agents[0].lastSeenAt = new Date(Date.now() - 10 * 60 * 1000);

    // System detects stale job and releases it
    const staleThreshold = new Date(Date.now() - 5 * 60 * 1000);
    if (agents.find(a => a.id === job.evalAgentId)!.lastSeenAt < staleThreshold) {
      job = {
        ...job,
        status: "pending",
        evalAgentId: null,
        retryCount: job.retryCount + 1,
      };
      agents[0].state = "offline";
    }

    expect(job.status).toBe("pending");
    expect(job.evalAgentId).toBeNull();
    expect(job.retryCount).toBe(1);

    // Agent 2 claims the job
    const canClaim = (agent: Agent, j: Job) =>
      agent.state === "idle" &&
      agent.region === j.region &&
      j.status === "pending";

    expect(canClaim(agents[1], job)).toBe(true);

    // Agent 2 claims it
    job.evalAgentId = agents[1].id;
    job.status = "running";
    agents[1].state = "occupied";

    expect(job.status).toBe("running");
    expect(job.evalAgentId).toBe(2);
  });

  it("should eventually fail job after multiple agent crashes", () => {
    let job: Job = {
      id: 1,
      evalAgentId: null,
      status: "pending",
      retryCount: 0,
      maxRetries: 2,
      region: "na",
    };

    const simulateCrash = (j: Job): Job => {
      if (j.retryCount >= j.maxRetries) {
        return { ...j, status: "failed", evalAgentId: null };
      }
      return { ...j, status: "pending", evalAgentId: null, retryCount: j.retryCount + 1 };
    };

    // First run - agent crashes
    job.status = "running";
    job.evalAgentId = 1;
    job = simulateCrash(job);
    expect(job.status).toBe("pending");
    expect(job.retryCount).toBe(1);

    // Second run - agent crashes again
    job.status = "running";
    job.evalAgentId = 2;
    job = simulateCrash(job);
    expect(job.status).toBe("pending");
    expect(job.retryCount).toBe(2);

    // Third run - max retries exceeded
    job.status = "running";
    job.evalAgentId = 3;
    job = simulateCrash(job);
    expect(job.status).toBe("failed");
    expect(job.retryCount).toBe(2); // Not incremented on failure
  });
});

describe("Job Recovery - Heartbeat Mechanism", () => {
  const HEARTBEAT_INTERVAL = 30000; // 30 seconds
  const STALE_THRESHOLD = 5 * 60 * 1000; // 5 minutes

  it("should calculate missed heartbeats correctly", () => {
    const calculateMissedHeartbeats = (lastSeenAt: Date): number => {
      const timeSinceLastSeen = Date.now() - lastSeenAt.getTime();
      return Math.floor(timeSinceLastSeen / HEARTBEAT_INTERVAL);
    };

    // Just saw heartbeat
    const fresh = new Date(Date.now() - 10000); // 10 seconds ago
    expect(calculateMissedHeartbeats(fresh)).toBe(0);

    // Missed 1 heartbeat
    const missed1 = new Date(Date.now() - 45000); // 45 seconds ago
    expect(calculateMissedHeartbeats(missed1)).toBe(1);

    // Missed multiple heartbeats
    const missed5 = new Date(Date.now() - 3 * 60 * 1000); // 3 minutes ago
    expect(calculateMissedHeartbeats(missed5)).toBe(6);

    // Stale (5+ minutes)
    const stale = new Date(Date.now() - 6 * 60 * 1000); // 6 minutes ago
    expect(calculateMissedHeartbeats(stale)).toBe(12);
  });

  it("should trigger stale detection after threshold", () => {
    const isStale = (lastSeenAt: Date): boolean => {
      return Date.now() - lastSeenAt.getTime() > STALE_THRESHOLD;
    };

    expect(isStale(new Date(Date.now() - 4 * 60 * 1000))).toBe(false); // 4 min
    expect(isStale(new Date(Date.now() - 5 * 60 * 1000 - 1))).toBe(true); // Just over 5 min
    expect(isStale(new Date(Date.now() - 10 * 60 * 1000))).toBe(true); // 10 min
  });
});

describe("Job Recovery - Background Worker Simulation", () => {
  const CHECK_INTERVAL = 60000; // 60 seconds
  const STALE_THRESHOLD_MINUTES = 5;

  interface SystemState {
    agents: Map<number, { lastSeenAt: Date; state: string }>;
    jobs: Map<number, { evalAgentId: number | null; status: string; retryCount: number; maxRetries: number }>;
  }

  const runMaintenanceTasks = (state: SystemState): { releasedJobs: number; offlineAgents: number } => {
    const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MINUTES * 60 * 1000);
    let releasedJobs = 0;
    let offlineAgents = 0;

    // Find stale agents
    const staleAgentIds = new Set<number>();
    state.agents.forEach((agent, id) => {
      if (agent.lastSeenAt < staleThreshold && agent.state !== "offline") {
        staleAgentIds.add(id);
        agent.state = "offline";
        offlineAgents++;
      }
    });

    // Release jobs from stale agents
    state.jobs.forEach((job, id) => {
      if (job.status === "running" && job.evalAgentId && staleAgentIds.has(job.evalAgentId)) {
        if (job.retryCount >= job.maxRetries) {
          job.status = "failed";
        } else {
          job.status = "pending";
          job.retryCount++;
        }
        job.evalAgentId = null;
        releasedJobs++;
      }
    });

    return { releasedJobs, offlineAgents };
  };

  it("should release stale jobs and mark agents offline", () => {
    const state: SystemState = {
      agents: new Map([
        [1, { lastSeenAt: new Date(Date.now() - 10 * 60 * 1000), state: "occupied" }],
        [2, { lastSeenAt: new Date(), state: "idle" }],
      ]),
      jobs: new Map([
        [1, { evalAgentId: 1, status: "running", retryCount: 0, maxRetries: 3 }],
        [2, { evalAgentId: 2, status: "running", retryCount: 0, maxRetries: 3 }],
      ]),
    };

    const result = runMaintenanceTasks(state);

    expect(result.releasedJobs).toBe(1);
    expect(result.offlineAgents).toBe(1);
    expect(state.jobs.get(1)!.status).toBe("pending");
    expect(state.jobs.get(1)!.evalAgentId).toBeNull();
    expect(state.jobs.get(2)!.status).toBe("running"); // Still running
    expect(state.agents.get(1)!.state).toBe("offline");
    expect(state.agents.get(2)!.state).toBe("idle");
  });

  it("should handle no stale jobs gracefully", () => {
    const state: SystemState = {
      agents: new Map([
        [1, { lastSeenAt: new Date(), state: "occupied" }],
      ]),
      jobs: new Map([
        [1, { evalAgentId: 1, status: "running", retryCount: 0, maxRetries: 3 }],
      ]),
    };

    const result = runMaintenanceTasks(state);

    expect(result.releasedJobs).toBe(0);
    expect(result.offlineAgents).toBe(0);
  });

  it("should run periodically", () => {
    vi.useFakeTimers();

    let runCount = 0;
    const interval = setInterval(() => {
      runCount++;
    }, CHECK_INTERVAL);

    // Simulate 5 minutes
    vi.advanceTimersByTime(5 * 60 * 1000);

    expect(runCount).toBe(5); // Should run 5 times in 5 minutes

    clearInterval(interval);
    vi.useRealTimers();
  });
});

describe("Job Recovery - Edge Cases", () => {
  it("should handle job with no assigned agent", () => {
    const job = {
      id: 1,
      evalAgentId: null,
      status: "pending" as const,
      retryCount: 0,
    };

    // This job should not be considered stale since it's not running
    const isStaleJob = job.status === "running" && job.evalAgentId !== null;
    expect(isStaleJob).toBe(false);
  });

  it("should handle already completed job", () => {
    const job = {
      id: 1,
      evalAgentId: 1,
      status: "completed" as const,
      retryCount: 0,
    };

    // Completed jobs should never be released
    const shouldRelease = job.status === "running";
    expect(shouldRelease).toBe(false);
  });

  it("should handle already failed job", () => {
    const job = {
      id: 1,
      evalAgentId: null,
      status: "failed" as const,
      retryCount: 3,
    };

    // Failed jobs should not be processed again
    const shouldProcess = job.status === "pending" || job.status === "running";
    expect(shouldProcess).toBe(false);
  });

  it("should handle agent that comes back online", () => {
    const agent = {
      id: 1,
      state: "offline" as const,
      lastSeenAt: new Date(Date.now() - 60 * 60 * 1000), // 1 hour ago
    };

    // Agent sends heartbeat
    agent.lastSeenAt = new Date();
    agent.state = "idle";

    expect(agent.state).toBe("idle");
    expect(agent.lastSeenAt.getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  it("should handle multiple jobs from same crashed agent", () => {
    const crashedAgentId = 1;
    const jobs = [
      { id: 1, evalAgentId: crashedAgentId, status: "running", retryCount: 0, maxRetries: 3 },
      { id: 2, evalAgentId: crashedAgentId, status: "running", retryCount: 1, maxRetries: 3 },
      { id: 3, evalAgentId: crashedAgentId, status: "running", retryCount: 2, maxRetries: 3 },
      { id: 4, evalAgentId: crashedAgentId, status: "running", retryCount: 3, maxRetries: 3 },
    ];

    const releasedJobs = jobs.map(job => {
      if (job.retryCount >= job.maxRetries) {
        return { ...job, status: "failed" as const, evalAgentId: null };
      }
      return { ...job, status: "pending" as const, evalAgentId: null, retryCount: job.retryCount + 1 };
    });

    expect(releasedJobs[0].status).toBe("pending");
    expect(releasedJobs[1].status).toBe("pending");
    expect(releasedJobs[2].status).toBe("pending");
    expect(releasedJobs[3].status).toBe("failed"); // Max retries exceeded
  });
});
