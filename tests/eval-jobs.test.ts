import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Eval Job Queue', () => {
  type JobStatus = 'pending' | 'running' | 'completed' | 'failed';
  type Region = 'na' | 'apac' | 'eu';

  interface EvalJob {
    id: number;
    scheduleId: number | null;
    workflowId: number;
    evalSetId: number;
    evalAgentId: number | null;
    region: Region;
    status: JobStatus;
    priority: number;
    retryCount: number;
    maxRetries: number;
    startedAt: Date | null;
    completedAt: Date | null;
    error: string | null;
    createdAt: Date;
    updatedAt: Date;
  }

  const createMockJob = (overrides: Partial<EvalJob> = {}): EvalJob => ({
    id: 1,
    scheduleId: null,
    workflowId: 1,
    evalSetId: 1,
    evalAgentId: null,
    region: 'na',
    status: 'pending',
    priority: 0,
    retryCount: 0,
    maxRetries: 3,
    startedAt: null,
    completedAt: null,
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

  describe('Job Creation', () => {
    it('should create job with pending status', () => {
      const job = createMockJob();

      expect(job.status).toBe('pending');
      expect(job.evalAgentId).toBeNull();
      expect(job.startedAt).toBeNull();
    });

    it('should set default retry count to 0', () => {
      const job = createMockJob();

      expect(job.retryCount).toBe(0);
      expect(job.maxRetries).toBe(3);
    });

    it('should set default priority to 0', () => {
      const job = createMockJob();

      expect(job.priority).toBe(0);
    });

    it('should assign region from workflow or default', () => {
      const naJob = createMockJob({ region: 'na' });
      const apacJob = createMockJob({ region: 'apac' });
      const euJob = createMockJob({ region: 'eu' });

      expect(naJob.region).toBe('na');
      expect(apacJob.region).toBe('apac');
      expect(euJob.region).toBe('eu');
    });
  });

  describe('Job Claiming', () => {
    it('should allow claiming pending job', () => {
      const job = createMockJob({ status: 'pending' });

      const canClaim = (j: EvalJob) => j.status === 'pending' && j.evalAgentId === null;

      expect(canClaim(job)).toBe(true);
    });

    it('should not allow claiming already running job', () => {
      const job = createMockJob({ status: 'running', evalAgentId: 5 });

      const canClaim = (j: EvalJob) => j.status === 'pending' && j.evalAgentId === null;

      expect(canClaim(job)).toBe(false);
    });

    it('should update job on claim', () => {
      const job = createMockJob();

      // Simulate claim
      const claimJob = (j: EvalJob, agentId: number) => {
        j.status = 'running';
        j.evalAgentId = agentId;
        j.startedAt = new Date();
        j.updatedAt = new Date();
      };

      claimJob(job, 42);

      expect(job.status).toBe('running');
      expect(job.evalAgentId).toBe(42);
      expect(job.startedAt).toBeInstanceOf(Date);
    });

    it('should match job to agent region', () => {
      const naJob = createMockJob({ region: 'na' });
      const apacJob = createMockJob({ region: 'apac' });

      const agent = { id: 1, region: 'na' as Region };

      const canAgentClaim = (job: EvalJob, agentRegion: Region) => {
        return job.region === agentRegion && job.status === 'pending';
      };

      expect(canAgentClaim(naJob, agent.region)).toBe(true);
      expect(canAgentClaim(apacJob, agent.region)).toBe(false);
    });
  });

  describe('Job Completion', () => {
    it('should mark job as completed', () => {
      const job = createMockJob({ status: 'running', evalAgentId: 1 });

      // Simulate completion
      const completeJob = (j: EvalJob) => {
        j.status = 'completed';
        j.completedAt = new Date();
        j.updatedAt = new Date();
      };

      completeJob(job);

      expect(job.status).toBe('completed');
      expect(job.completedAt).toBeInstanceOf(Date);
    });

    it('should mark job as failed with error', () => {
      const job = createMockJob({ status: 'running', evalAgentId: 1 });

      // Simulate failure
      const failJob = (j: EvalJob, error: string) => {
        j.status = 'failed';
        j.error = error;
        j.completedAt = new Date();
        j.updatedAt = new Date();
      };

      failJob(job, 'Connection timeout');

      expect(job.status).toBe('failed');
      expect(job.error).toBe('Connection timeout');
    });
  });

  describe('Job Retry Logic', () => {
    it('should allow retry if under max retries', () => {
      const job = createMockJob({ status: 'failed', retryCount: 1, maxRetries: 3 });

      const canRetry = (j: EvalJob) => j.status === 'failed' && j.retryCount < j.maxRetries;

      expect(canRetry(job)).toBe(true);
    });

    it('should not allow retry if at max retries', () => {
      const job = createMockJob({ status: 'failed', retryCount: 3, maxRetries: 3 });

      const canRetry = (j: EvalJob) => j.status === 'failed' && j.retryCount < j.maxRetries;

      expect(canRetry(job)).toBe(false);
    });

    it('should increment retry count on retry', () => {
      const job = createMockJob({ status: 'failed', retryCount: 1 });

      // Simulate retry
      const retryJob = (j: EvalJob) => {
        j.retryCount++;
        j.status = 'pending';
        j.evalAgentId = null;
        j.startedAt = null;
        j.completedAt = null;
        j.error = null;
        j.updatedAt = new Date();
      };

      retryJob(job);

      expect(job.retryCount).toBe(2);
      expect(job.status).toBe('pending');
    });
  });

  describe('Job Queue Ordering', () => {
    it('should order by priority (higher first)', () => {
      const jobs = [
        createMockJob({ id: 1, priority: 0 }),
        createMockJob({ id: 2, priority: 10 }),
        createMockJob({ id: 3, priority: 5 }),
      ];

      const sorted = [...jobs].sort((a, b) => b.priority - a.priority);

      expect(sorted[0].id).toBe(2); // priority 10
      expect(sorted[1].id).toBe(3); // priority 5
      expect(sorted[2].id).toBe(1); // priority 0
    });

    it('should order by creation time for same priority', () => {
      const now = Date.now();
      const jobs = [
        createMockJob({ id: 1, priority: 0, createdAt: new Date(now) }),
        createMockJob({ id: 2, priority: 0, createdAt: new Date(now - 2000) }),
        createMockJob({ id: 3, priority: 0, createdAt: new Date(now - 1000) }),
      ];

      const sorted = [...jobs].sort((a, b) => {
        if (a.priority !== b.priority) return b.priority - a.priority;
        return a.createdAt.getTime() - b.createdAt.getTime();
      });

      expect(sorted[0].id).toBe(2); // oldest
      expect(sorted[1].id).toBe(3);
      expect(sorted[2].id).toBe(1); // newest
    });
  });

  describe('Job Status Transitions', () => {
    const validTransitions: Record<JobStatus, JobStatus[]> = {
      pending: ['running'],
      running: ['completed', 'failed'],
      completed: [],
      failed: ['pending'], // retry
    };

    it('should validate status transitions', () => {
      const canTransition = (from: JobStatus, to: JobStatus) => {
        return validTransitions[from].includes(to);
      };

      // Valid transitions
      expect(canTransition('pending', 'running')).toBe(true);
      expect(canTransition('running', 'completed')).toBe(true);
      expect(canTransition('running', 'failed')).toBe(true);
      expect(canTransition('failed', 'pending')).toBe(true); // retry

      // Invalid transitions
      expect(canTransition('pending', 'completed')).toBe(false);
      expect(canTransition('completed', 'running')).toBe(false);
      expect(canTransition('completed', 'pending')).toBe(false);
    });
  });

  describe('Job Filtering', () => {
    it('should filter jobs by status', () => {
      const jobs = [
        createMockJob({ id: 1, status: 'pending' }),
        createMockJob({ id: 2, status: 'running' }),
        createMockJob({ id: 3, status: 'completed' }),
        createMockJob({ id: 4, status: 'pending' }),
      ];

      const pendingJobs = jobs.filter(j => j.status === 'pending');
      expect(pendingJobs).toHaveLength(2);
    });

    it('should filter jobs by region', () => {
      const jobs = [
        createMockJob({ id: 1, region: 'na' }),
        createMockJob({ id: 2, region: 'apac' }),
        createMockJob({ id: 3, region: 'na' }),
      ];

      const naJobs = jobs.filter(j => j.region === 'na');
      expect(naJobs).toHaveLength(2);
    });

    it('should get pending jobs for specific region', () => {
      const jobs = [
        createMockJob({ id: 1, status: 'pending', region: 'na' }),
        createMockJob({ id: 2, status: 'running', region: 'na' }),
        createMockJob({ id: 3, status: 'pending', region: 'apac' }),
      ];

      const pendingNaJobs = jobs.filter(j => j.status === 'pending' && j.region === 'na');
      expect(pendingNaJobs).toHaveLength(1);
      expect(pendingNaJobs[0].id).toBe(1);
    });
  });

  describe('Job Metrics', () => {
    it('should calculate job duration', () => {
      const startedAt = new Date(Date.now() - 60000); // 1 minute ago
      const completedAt = new Date();

      const getDuration = (start: Date, end: Date) => {
        return end.getTime() - start.getTime();
      };

      const duration = getDuration(startedAt, completedAt);
      expect(duration).toBeGreaterThanOrEqual(59000);
      expect(duration).toBeLessThanOrEqual(61000);
    });

    it('should count jobs by status', () => {
      const jobs = [
        createMockJob({ status: 'pending' }),
        createMockJob({ status: 'pending' }),
        createMockJob({ status: 'running' }),
        createMockJob({ status: 'completed' }),
        createMockJob({ status: 'completed' }),
        createMockJob({ status: 'completed' }),
        createMockJob({ status: 'failed' }),
      ];

      const countByStatus = (jobs: EvalJob[]) => {
        return jobs.reduce((acc, job) => {
          acc[job.status] = (acc[job.status] || 0) + 1;
          return acc;
        }, {} as Record<JobStatus, number>);
      };

      const counts = countByStatus(jobs);
      expect(counts.pending).toBe(2);
      expect(counts.running).toBe(1);
      expect(counts.completed).toBe(3);
      expect(counts.failed).toBe(1);
    });
  });

  describe('Atomic Job Claims', () => {
    it('should prevent race conditions in claim', () => {
      // Simulate optimistic locking
      interface JobWithVersion extends EvalJob {
        version: number;
      }

      const job: JobWithVersion = {
        ...createMockJob(),
        version: 1,
      };

      const claimWithVersion = (j: JobWithVersion, agentId: number, expectedVersion: number) => {
        if (j.version !== expectedVersion) {
          return { success: false, error: 'Version mismatch' };
        }
        j.evalAgentId = agentId;
        j.status = 'running';
        j.version++;
        return { success: true };
      };

      // First claim succeeds
      const result1 = claimWithVersion(job, 1, 1);
      expect(result1.success).toBe(true);

      // Second claim fails due to version mismatch
      const result2 = claimWithVersion(job, 2, 1);
      expect(result2.success).toBe(false);
    });
  });
});
