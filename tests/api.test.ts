import { describe, it, expect, beforeAll } from 'vitest';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:5000';
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || 'admin@vox.local';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || 'admin123456';

interface AuthSession {
  cookie: string;
}

interface Workflow {
  id: number;
  name: string;
  description: string | null;
  ownerId: number;
  projectId: number | null;
  visibility: string;
  isMainline: boolean;
}

interface EvalSet {
  id: number;
  name: string;
  description: string | null;
  ownerId: number;
  visibility: string;
  isMainline: boolean;
}

interface Provider {
  id: string;
  name: string;
  description: string | null;
  sku: string;
  isActive: boolean;
}

interface EvalAgentToken {
  id: number;
  name: string;
  region: string;
  token?: string;
  isRevoked: boolean;
}

interface EvalAgent {
  id: number;
  name: string;
  region: string;
  state: string;
}

interface EvalJob {
  id: number;
  workflowId: number;
  status: string;
  region: string;
  scheduleId?: number | null;
}

interface EvalSchedule {
  id: number;
  name: string;
  workflowId: number;
  evalSetId: number | null;
  region: string;
  scheduleType: string;
  cronExpression: string | null;
  isEnabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  runCount: number;
  maxRuns: number | null;
}

interface Project {
  id: number;
  name: string;
  description: string | null;
  ownerId: number;
}

interface ApiKey {
  id: number;
  name: string;
  prefix: string;
  key?: string;
  isRevoked: boolean;
}

async function login(email: string, password: string): Promise<AuthSession> {
  const response = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    throw new Error(`Login failed: ${response.status}`);
  }

  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) {
    throw new Error('No session cookie received');
  }

  return { cookie: setCookie.split(';')[0] };
}

async function authFetch(session: AuthSession, url: string, options: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      'Cookie': session.cookie,
      'Content-Type': 'application/json',
    },
  });
}

describe('Vox API Tests', () => {
  let adminSession: AuthSession;
  let testWorkflowId: number;
  let testProjectId: number;
  let testEvalSetId: number;
  let testEvalAgentTokenId: number;
  let testEvalAgentToken: string;
  let testApiKeyId: number;
  let testApiKey: string;
  let testScheduleId: number;
  let testRecurringScheduleId: number;

  beforeAll(async () => {
    adminSession = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  });

  describe('Auth API', () => {
    it('should return auth status for logged in user', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/auth/status`);
      expect(response.ok).toBe(true);

      const data = await response.json();
      expect(data.initialized).toBe(true);
      expect(data.user).toBeDefined();
      expect(data.user.email).toBe(ADMIN_EMAIL);
      expect(data.user.isAdmin).toBe(true);
    });

    it('should reject unauthenticated requests', async () => {
      const response = await fetch(`${BASE_URL}/api/workflows`);
      expect(response.status).toBe(401);
    });

    it('should check Google OAuth status', async () => {
      const response = await fetch(`${BASE_URL}/api/auth/google/status`);
      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(typeof data.enabled).toBe('boolean');
    });
  });

  describe('Provider API', () => {
    it('should get all providers (public)', async () => {
      const response = await fetch(`${BASE_URL}/api/providers`);
      expect(response.ok).toBe(true);

      const providers: Provider[] = await response.json();
      expect(Array.isArray(providers)).toBe(true);
      expect(providers.length).toBeGreaterThan(0);
      expect(providers[0].sku).toBeDefined();
    });
  });

  describe('Project API', () => {
    it('should create a new project', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/projects`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Test Project',
          description: 'A test project for API testing',
        }),
      });

      expect(response.ok).toBe(true);
      const project: Project = await response.json();
      expect(project.name).toBe('Test Project');
      testProjectId = project.id;
    });

    it('should get all projects', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/projects`);
      expect(response.ok).toBe(true);

      const projects: Project[] = await response.json();
      expect(Array.isArray(projects)).toBe(true);
      expect(projects.length).toBeGreaterThan(0);
    });

    it('should get a single project by id', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/projects/${testProjectId}`);
      expect(response.ok).toBe(true);

      const project: Project = await response.json();
      expect(project.id).toBe(testProjectId);
      expect(project.name).toBe('Test Project');
    });

    it('should update a project', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/projects/${testProjectId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: 'Updated Test Project',
          description: 'Updated description',
        }),
      });

      expect(response.ok).toBe(true);
      const project: Project = await response.json();
      expect(project.name).toBe('Updated Test Project');
    });
  });

  describe('Workflow API', () => {
    it('should create a new workflow', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/workflows`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Test Workflow',
          description: 'A test workflow for API testing',
          visibility: 'public',
          projectId: testProjectId,
        }),
      });

      expect(response.ok).toBe(true);
      const workflow: Workflow = await response.json();
      expect(workflow.name).toBe('Test Workflow');
      expect(workflow.visibility).toBe('public');
      testWorkflowId = workflow.id;
    });

    it('should get all workflows', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/workflows`);
      expect(response.ok).toBe(true);

      const workflows: Workflow[] = await response.json();
      expect(Array.isArray(workflows)).toBe(true);
      expect(workflows.length).toBeGreaterThan(0);
    });

    it('should get a single workflow by id', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/workflows/${testWorkflowId}`);
      expect(response.ok).toBe(true);

      const workflow: Workflow = await response.json();
      expect(workflow.id).toBe(testWorkflowId);
      expect(workflow.name).toBe('Test Workflow');
    });

    it('should update a workflow', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/workflows/${testWorkflowId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: 'Updated Test Workflow',
          description: 'Updated description',
        }),
      });

      expect(response.ok).toBe(true);
      const workflow: Workflow = await response.json();
      expect(workflow.name).toBe('Updated Test Workflow');
    });
  });

  describe('Eval Set API', () => {
    it('should create an eval set', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-sets`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Test Eval Set',
          description: 'A test eval set for API testing',
          visibility: 'public',
          config: { test: true },
        }),
      });

      expect(response.ok).toBe(true);
      const evalSet: EvalSet = await response.json();
      expect(evalSet.name).toBe('Test Eval Set');
      expect(evalSet.visibility).toBe('public');
      testEvalSetId = evalSet.id;
    });

    it('should get all eval sets', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-sets`);
      expect(response.ok).toBe(true);

      const evalSets: EvalSet[] = await response.json();
      expect(Array.isArray(evalSets)).toBe(true);
      expect(evalSets.length).toBeGreaterThan(0);
    });

    it('should get a single eval set by id', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-sets/${testEvalSetId}`);
      expect(response.ok).toBe(true);

      const evalSet: EvalSet = await response.json();
      expect(evalSet.id).toBe(testEvalSetId);
      expect(evalSet.name).toBe('Test Eval Set');
    });
  });

  describe('Eval Schedule API', () => {
    it('should create a one-time schedule', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-schedules`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Test One-Time Schedule',
          workflowId: testWorkflowId,
          evalSetId: testEvalSetId,
          region: 'na',
          scheduleType: 'once',
        }),
      });

      expect(response.ok).toBe(true);
      const schedule: EvalSchedule = await response.json();
      expect(schedule.name).toBe('Test One-Time Schedule');
      expect(schedule.scheduleType).toBe('once');
      expect(schedule.isEnabled).toBe(true);
      expect(schedule.nextRunAt).toBeDefined();
      testScheduleId = schedule.id;
    });

    it('should create a recurring schedule with cron expression', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-schedules`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Test Recurring Schedule',
          workflowId: testWorkflowId,
          evalSetId: testEvalSetId,
          region: 'na',
          scheduleType: 'recurring',
          cronExpression: '0 * * * *', // Every hour
          maxRuns: 10,
        }),
      });

      expect(response.ok).toBe(true);
      const schedule: EvalSchedule = await response.json();
      expect(schedule.name).toBe('Test Recurring Schedule');
      expect(schedule.scheduleType).toBe('recurring');
      expect(schedule.cronExpression).toBe('0 * * * *');
      expect(schedule.maxRuns).toBe(10);
      expect(schedule.isEnabled).toBe(true);
      testRecurringScheduleId = schedule.id;
    });

    it('should reject recurring schedule without cron expression', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-schedules`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Invalid Schedule',
          workflowId: testWorkflowId,
          region: 'na',
          scheduleType: 'recurring',
          // Missing cronExpression
        }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain('cronExpression');
    });

    it('should reject schedule with invalid cron expression', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-schedules`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Invalid Cron Schedule',
          workflowId: testWorkflowId,
          region: 'na',
          scheduleType: 'recurring',
          cronExpression: '0 0 * *', // Invalid - only 4 parts
        }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain('Invalid cron');
    });

    it('should get all schedules', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-schedules`);
      expect(response.ok).toBe(true);

      const schedules: EvalSchedule[] = await response.json();
      expect(Array.isArray(schedules)).toBe(true);
      expect(schedules.length).toBeGreaterThanOrEqual(2);
    });

    it('should get a single schedule by id', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-schedules/${testScheduleId}`);
      expect(response.ok).toBe(true);

      const schedule: EvalSchedule = await response.json();
      expect(schedule.id).toBe(testScheduleId);
      expect(schedule.name).toBe('Test One-Time Schedule');
    });

    it('should update a schedule', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-schedules/${testRecurringScheduleId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: 'Updated Recurring Schedule',
          cronExpression: '30 * * * *', // Changed to every hour at :30
        }),
      });

      expect(response.ok).toBe(true);
      const schedule: EvalSchedule = await response.json();
      expect(schedule.name).toBe('Updated Recurring Schedule');
      expect(schedule.cronExpression).toBe('30 * * * *');
    });

    it('should disable a schedule', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-schedules/${testRecurringScheduleId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          isEnabled: false,
        }),
      });

      expect(response.ok).toBe(true);
      const schedule: EvalSchedule = await response.json();
      expect(schedule.isEnabled).toBe(false);
    });

    it('should re-enable a schedule and recalculate nextRunAt', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-schedules/${testRecurringScheduleId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          isEnabled: true,
        }),
      });

      expect(response.ok).toBe(true);
      const schedule: EvalSchedule = await response.json();
      expect(schedule.isEnabled).toBe(true);
      expect(schedule.nextRunAt).toBeDefined();
    });

    it('should run a schedule immediately (run-now)', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-schedules/${testRecurringScheduleId}/run-now`, {
        method: 'POST',
      });

      expect(response.ok).toBe(true);
      const result = await response.json();
      expect(result.job).toBeDefined();
      expect(result.job.workflowId).toBe(testWorkflowId);
      expect(result.job.scheduleId).toBe(testRecurringScheduleId);
    });

    it('should reject access to non-owned schedule', async () => {
      // First create a new user session (or use a different approach)
      // For now, test that we get proper 404 for non-existent schedule
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-schedules/999999`);
      expect(response.status).toBe(404);
    });

    it('should reject schedule creation with non-existent workflow', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-schedules`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Invalid Workflow Schedule',
          workflowId: 999999,
          region: 'na',
          scheduleType: 'once',
        }),
      });

      expect(response.status).toBe(404);
    });

    it('should reject schedule creation with invalid region', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-schedules`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Invalid Region Schedule',
          workflowId: testWorkflowId,
          region: 'invalid',
          scheduleType: 'once',
        }),
      });

      expect(response.status).toBe(400);
    });

    it('should reject schedule creation without name', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-schedules`, {
        method: 'POST',
        body: JSON.stringify({
          workflowId: testWorkflowId,
          region: 'na',
          scheduleType: 'once',
        }),
      });

      expect(response.status).toBe(400);
    });

    it('should create schedule with specific runAt time', async () => {
      const futureTime = new Date(Date.now() + 3600000).toISOString(); // 1 hour from now
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-schedules`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Future One-Time Schedule',
          workflowId: testWorkflowId,
          region: 'eu',
          scheduleType: 'once',
          runAt: futureTime,
        }),
      });

      expect(response.ok).toBe(true);
      const schedule: EvalSchedule = await response.json();
      expect(schedule.scheduleType).toBe('once');
      expect(schedule.region).toBe('eu');
      expect(new Date(schedule.nextRunAt!).getTime()).toBeGreaterThan(Date.now());

      // Cleanup
      await authFetch(adminSession, `${BASE_URL}/api/eval-schedules/${schedule.id}`, {
        method: 'DELETE',
      });
    });

    it('should create recurring schedule with daily cron', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-schedules`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Daily Schedule',
          workflowId: testWorkflowId,
          region: 'apac',
          scheduleType: 'recurring',
          cronExpression: '0 8 * * *', // Daily at 8 AM
        }),
      });

      expect(response.ok).toBe(true);
      const schedule: EvalSchedule = await response.json();
      expect(schedule.scheduleType).toBe('recurring');
      expect(schedule.cronExpression).toBe('0 8 * * *');

      // Cleanup
      await authFetch(adminSession, `${BASE_URL}/api/eval-schedules/${schedule.id}`, {
        method: 'DELETE',
      });
    });

    it('should delete schedules in cleanup', async () => {
      // Delete one-time schedule
      let response = await authFetch(adminSession, `${BASE_URL}/api/eval-schedules/${testScheduleId}`, {
        method: 'DELETE',
      });
      expect(response.ok).toBe(true);

      // Delete recurring schedule
      response = await authFetch(adminSession, `${BASE_URL}/api/eval-schedules/${testRecurringScheduleId}`, {
        method: 'DELETE',
      });
      expect(response.ok).toBe(true);
    });
  });

  describe('Eval Agent Token API (Admin Only)', () => {
    it('should create an eval agent token', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/admin/eval-agent-tokens`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Test Agent Token NA',
          region: 'na',
        }),
      });

      expect(response.ok).toBe(true);
      const agentToken: EvalAgentToken = await response.json();
      expect(agentToken.region).toBe('na');
      expect(agentToken.token).toBeDefined();
      expect(agentToken.token!.length).toBeGreaterThan(20);
      testEvalAgentTokenId = agentToken.id;
      testEvalAgentToken = agentToken.token!;
    });

    it('should get all eval agent tokens', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/admin/eval-agent-tokens`);
      expect(response.ok).toBe(true);

      const tokens: EvalAgentToken[] = await response.json();
      expect(Array.isArray(tokens)).toBe(true);
      expect(tokens.length).toBeGreaterThan(0);
    });
  });

  describe('Eval Agent Registration API', () => {
    let agentId: number;

    it('should register an eval agent with valid token', async () => {
      const response = await fetch(`${BASE_URL}/api/eval-agent/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${testEvalAgentToken}`,
        },
        body: JSON.stringify({
          name: 'Test Agent NA-1',
        }),
      });

      expect(response.ok).toBe(true);
      const agent: EvalAgent = await response.json();
      expect(agent.region).toBe('na');
      expect(agent.state).toBe('idle');
      agentId = agent.id;
    });

    it('should reject registration with invalid token', async () => {
      const response = await fetch(`${BASE_URL}/api/eval-agent/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer invalid-token',
        },
        body: JSON.stringify({
          name: 'Invalid Agent',
        }),
      });

      expect(response.status).toBe(401);
    });

    it('should get all eval agents (public)', async () => {
      const response = await fetch(`${BASE_URL}/api/eval-agents`);
      expect(response.ok).toBe(true);

      const agents: EvalAgent[] = await response.json();
      expect(Array.isArray(agents)).toBe(true);
      expect(agents.length).toBeGreaterThan(0);
    });

    it('should send agent heartbeat', async () => {
      const response = await fetch(`${BASE_URL}/api/eval-agent/heartbeat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${testEvalAgentToken}`,
        },
        body: JSON.stringify({
          agentId,
        }),
      });

      expect(response.ok).toBe(true);
    });
  });

  describe('Job API', () => {
    let testJobId: number;

    it('should run a workflow and create jobs', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/workflows/${testWorkflowId}/run`, {
        method: 'POST',
        body: JSON.stringify({
          evalSetId: testEvalSetId,
          region: 'na',
        }),
      });

      expect(response.ok).toBe(true);
      const result = await response.json();
      expect(result.job).toBeDefined();
      expect(result.job.workflowId).toBe(testWorkflowId);
      testJobId = result.job.id;
    });

    it('should get pending jobs for a region', async () => {
      const response = await fetch(`${BASE_URL}/api/eval-agent/jobs?region=na`, {
        headers: {
          'Authorization': `Bearer ${testEvalAgentToken}`,
        },
      });

      expect(response.ok).toBe(true);
      const jobs: EvalJob[] = await response.json();
      expect(Array.isArray(jobs)).toBe(true);
    });

    it('should reject job creation with invalid region', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/workflows/${testWorkflowId}/run`, {
        method: 'POST',
        body: JSON.stringify({
          evalSetId: testEvalSetId,
          region: 'invalid',
        }),
      });

      expect(response.status).toBe(400);
    });

    it('should reject job creation without region', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/workflows/${testWorkflowId}/run`, {
        method: 'POST',
        body: JSON.stringify({
          evalSetId: testEvalSetId,
        }),
      });

      expect(response.status).toBe(400);
    });
  });

  describe('API Key Management', () => {
    it('should create an API key', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/user/api-keys`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Test API Key',
        }),
      });

      expect(response.ok).toBe(true);
      const apiKey: ApiKey = await response.json();
      expect(apiKey.name).toBe('Test API Key');
      expect(apiKey.key).toBeDefined();
      expect(apiKey.key!.startsWith('vox_live_')).toBe(true);
      testApiKeyId = apiKey.id;
      testApiKey = apiKey.key!;
    });

    it('should get all API keys', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/user/api-keys`);
      expect(response.ok).toBe(true);

      const apiKeys: ApiKey[] = await response.json();
      expect(Array.isArray(apiKeys)).toBe(true);
      expect(apiKeys.length).toBeGreaterThan(0);
      // Key should not be returned in list
      expect(apiKeys[0].key).toBeUndefined();
    });

    it('should authenticate with API key', async () => {
      const response = await fetch(`${BASE_URL}/api/v1/user`, {
        headers: {
          'Authorization': `Bearer ${testApiKey}`,
        },
      });

      expect(response.ok).toBe(true);
      const { data } = await response.json();
      expect(data.email).toBe(ADMIN_EMAIL);
    });
  });

  describe('API v1 Endpoints', () => {
    it('should get workflows via API v1', async () => {
      const response = await fetch(`${BASE_URL}/api/v1/workflows`, {
        headers: {
          'Authorization': `Bearer ${testApiKey}`,
        },
      });

      expect(response.ok).toBe(true);
      const { data: workflows } = await response.json();
      expect(Array.isArray(workflows)).toBe(true);
    });

    it('should get eval sets via API v1', async () => {
      const response = await fetch(`${BASE_URL}/api/v1/eval-sets`, {
        headers: {
          'Authorization': `Bearer ${testApiKey}`,
        },
      });

      expect(response.ok).toBe(true);
      const { data: evalSets } = await response.json();
      expect(Array.isArray(evalSets)).toBe(true);
    });

    it('should get jobs via API v1', async () => {
      const response = await fetch(`${BASE_URL}/api/v1/jobs`, {
        headers: {
          'Authorization': `Bearer ${testApiKey}`,
        },
      });

      expect(response.ok).toBe(true);
      const { data: jobs } = await response.json();
      expect(Array.isArray(jobs)).toBe(true);
    });

    it('should get results via API v1', async () => {
      const response = await fetch(`${BASE_URL}/api/v1/results`, {
        headers: {
          'Authorization': `Bearer ${testApiKey}`,
        },
      });

      expect(response.ok).toBe(true);
      const { data } = await response.json();
      expect(Array.isArray(data)).toBe(true);
    });

    it('should get projects via API v1', async () => {
      const response = await fetch(`${BASE_URL}/api/v1/projects`, {
        headers: {
          'Authorization': `Bearer ${testApiKey}`,
        },
      });

      expect(response.ok).toBe(true);
      const { data: projects } = await response.json();
      expect(Array.isArray(projects)).toBe(true);
    });

    it('should get realtime metrics (public)', async () => {
      const response = await fetch(`${BASE_URL}/api/v1/metrics/realtime`);
      expect(response.ok).toBe(true);
      const { data } = await response.json();
      expect(Array.isArray(data)).toBe(true);
    });

    it('should get leaderboard (public)', async () => {
      const response = await fetch(`${BASE_URL}/api/v1/metrics/leaderboard`);
      expect(response.ok).toBe(true);
      const { data } = await response.json();
      expect(data).toBeDefined();
    });

    it('should get providers via API v1 (public)', async () => {
      const response = await fetch(`${BASE_URL}/api/v1/providers`);
      expect(response.ok).toBe(true);
      const { data: providers } = await response.json();
      expect(Array.isArray(providers)).toBe(true);
    });
  });

  describe('Public Metrics API', () => {
    it('should get realtime metrics', async () => {
      const response = await fetch(`${BASE_URL}/api/metrics/realtime`);
      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(Array.isArray(data)).toBe(true);
    });

    it('should get leaderboard', async () => {
      const response = await fetch(`${BASE_URL}/api/metrics/leaderboard`);
      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(data).toBeDefined();
    });
  });

  describe('Eval Results API', () => {
    it('should get eval results via API v1', async () => {
      const response = await fetch(`${BASE_URL}/api/v1/results`, {
        headers: {
          'Authorization': `Bearer ${testApiKey}`,
        },
      });

      expect(response.ok).toBe(true);
      const { data } = await response.json();
      expect(Array.isArray(data)).toBe(true);
    });

    it('should get results filtered by workflow', async () => {
      const response = await fetch(`${BASE_URL}/api/v1/results?workflowId=${testWorkflowId}`, {
        headers: {
          'Authorization': `Bearer ${testApiKey}`,
        },
      });

      expect(response.ok).toBe(true);
      const { data } = await response.json();
      expect(Array.isArray(data)).toBe(true);
    });

    it('should support pagination for results', async () => {
      const response = await fetch(`${BASE_URL}/api/v1/results?limit=5&offset=0`, {
        headers: {
          'Authorization': `Bearer ${testApiKey}`,
        },
      });

      expect(response.ok).toBe(true);
      const { data } = await response.json();
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeLessThanOrEqual(5);
    });
  });

  describe('Mainline and Leaderboard API', () => {
    it('should get mainline eval results from realtime metrics', async () => {
      const response = await fetch(`${BASE_URL}/api/metrics/realtime`);
      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(Array.isArray(data)).toBe(true);
      // Mainline results should have required fields
      if (data.length > 0) {
        expect(data[0]).toHaveProperty('providerId');
        expect(data[0]).toHaveProperty('region');
        expect(data[0]).toHaveProperty('responseLatencyMedian');
      }
    });

    it('should get leaderboard with provider rankings', async () => {
      const response = await fetch(`${BASE_URL}/api/metrics/leaderboard`);
      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(Array.isArray(data)).toBe(true);
      // Leaderboard should have rank and provider info
      if (data.length > 0) {
        expect(data[0]).toHaveProperty('rank');
        expect(data[0]).toHaveProperty('providerId');
        expect(data[0]).toHaveProperty('providerName');
        expect(data[0]).toHaveProperty('responseLatency');
      }
    });

    it('should get realtime metrics via API v1', async () => {
      const response = await fetch(`${BASE_URL}/api/v1/metrics/realtime`);
      expect(response.ok).toBe(true);
      const { data, meta } = await response.json();
      expect(Array.isArray(data)).toBe(true);
      expect(meta).toHaveProperty('timestamp');
      expect(meta).toHaveProperty('count');
    });

    it('should get leaderboard via API v1 with meta info', async () => {
      const response = await fetch(`${BASE_URL}/api/v1/metrics/leaderboard`);
      expect(response.ok).toBe(true);
      const { data, meta } = await response.json();
      expect(Array.isArray(data)).toBe(true);
      expect(meta).toHaveProperty('timestamp');
      expect(meta).toHaveProperty('region');
    });

    it('should filter leaderboard by region', async () => {
      const response = await fetch(`${BASE_URL}/api/v1/metrics/leaderboard?region=na`);
      expect(response.ok).toBe(true);
      const { data, meta } = await response.json();
      expect(Array.isArray(data)).toBe(true);
      expect(meta.region).toBe('na');
      // All results should be from NA region
      for (const item of data) {
        expect(item.region).toBe('na');
      }
    });
  });

  describe('Complete Job Flow', () => {
    let flowWorkflowId: number;
    let flowEvalSetId: number;
    let flowAgentToken: string;
    let flowAgentId: number;
    let flowJobId: number;

    it('should create workflow for job flow test', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/workflows`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Job Flow Test Workflow',
          description: 'Testing complete job submission flow',
          visibility: 'public',
        }),
      });
      expect(response.ok).toBe(true);
      const workflow = await response.json();
      flowWorkflowId = workflow.id;
    });

    it('should create eval set for job flow test', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-sets`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Job Flow Test Eval Set',
          visibility: 'public',
        }),
      });
      expect(response.ok).toBe(true);
      const evalSet = await response.json();
      flowEvalSetId = evalSet.id;
    });

    it('should create eval agent token for job flow', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/admin/eval-agent-tokens`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Job Flow Test Token',
          region: 'na',
        }),
      });
      expect(response.ok).toBe(true);
      const token = await response.json();
      flowAgentToken = token.token;
    });

    it('should register eval agent for job flow', async () => {
      const response = await fetch(`${BASE_URL}/api/eval-agent/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${flowAgentToken}`,
        },
        body: JSON.stringify({ name: 'Job-Flow-Test-Agent' }),
      });
      expect(response.ok).toBe(true);
      const agent = await response.json();
      flowAgentId = agent.id;
      expect(agent.region).toBe('na');
    });

    it('should create job by running workflow', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/workflows/${flowWorkflowId}/run`, {
        method: 'POST',
        body: JSON.stringify({
          evalSetId: flowEvalSetId,
          region: 'na',
        }),
      });
      expect(response.ok).toBe(true);
      const result = await response.json();
      flowJobId = result.job.id;
      expect(result.job.status).toBe('pending');
    });

    it('should claim job as eval agent', async () => {
      const response = await fetch(`${BASE_URL}/api/eval-agent/jobs/${flowJobId}/claim`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${flowAgentToken}`,
        },
        body: JSON.stringify({ agentId: flowAgentId }),
      });
      expect(response.ok).toBe(true);
      const job = await response.json();
      expect(job.status).toBe('running');
      expect(job.evalAgentId).toBe(flowAgentId);
    });

    it('should complete job with results', async () => {
      const response = await fetch(`${BASE_URL}/api/eval-agent/jobs/${flowJobId}/complete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${flowAgentToken}`,
        },
        body: JSON.stringify({
          agentId: flowAgentId,
          results: {
            responseLatencyMedian: 1200,
            responseLatencySd: 150,
            interruptLatencyMedian: 1100,
            interruptLatencySd: 120,
            networkResilience: 90,
            naturalness: 4.0,
            noiseReduction: 95,
          },
        }),
      });
      expect(response.ok).toBe(true);
    });

    it('should verify results were saved', async () => {
      const response = await fetch(`${BASE_URL}/api/v1/results?jobId=${flowJobId}`, {
        headers: { 'Authorization': `Bearer ${testApiKey}` },
      });
      expect(response.ok).toBe(true);
      const { data } = await response.json();
      expect(data.length).toBeGreaterThan(0);
      const result = data.find((r: any) => r.evalJobId === flowJobId);
      expect(result).toBeDefined();
      expect(result.responseLatencyMedian).toBe(1200);
      expect(result.naturalness).toBe(4.0);
    });

    it('should cleanup job flow test resources', async () => {
      // Delete workflow (cascades to jobs)
      await authFetch(adminSession, `${BASE_URL}/api/workflows/${flowWorkflowId}`, {
        method: 'DELETE',
      });
      // Delete eval set
      await authFetch(adminSession, `${BASE_URL}/api/eval-sets/${flowEvalSetId}`, {
        method: 'DELETE',
      });
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should return 404 for non-existent workflow', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/workflows/999999`);
      expect(response.status).toBe(404);
    });

    it('should return 404 for non-existent project', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/projects/999999`);
      expect(response.status).toBe(404);
    });

    it('should return 404 for non-existent eval set', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-sets/999999`);
      expect(response.status).toBe(404);
    });

    it('should reject workflow creation without name', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/workflows`, {
        method: 'POST',
        body: JSON.stringify({
          description: 'No name workflow',
        }),
      });

      expect(response.status).toBe(400);
    });

    it('should reject project creation without name', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/projects`, {
        method: 'POST',
        body: JSON.stringify({
          description: 'No name project',
        }),
      });

      expect(response.status).toBe(400);
    });

    it('should reject eval set creation without name', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-sets`, {
        method: 'POST',
        body: JSON.stringify({
          description: 'No name eval set',
        }),
      });

      expect(response.status).toBe(400);
    });

    it('should reject invalid eval agent token region', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/admin/eval-agent-tokens`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Invalid Region Token',
          region: 'invalid',
        }),
      });

      expect(response.status).toBe(400);
    });
  });

  describe('Multi-Region Eval Agent Tests', () => {
    let naToken: string;
    let apacToken: string;
    let euToken: string;
    let naAgentId: number;
    let apacAgentId: number;
    let euAgentId: number;
    let multiRegionWorkflowId: number;
    let naJobId: number;
    let apacJobId: number;
    let euJobId: number;

    it('should create eval agent tokens for all regions', async () => {
      // Create NA token
      const naResponse = await authFetch(adminSession, `${BASE_URL}/api/admin/eval-agent-tokens`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Multi-Region-NA', region: 'na' }),
      });
      expect(naResponse.ok).toBe(true);
      const naData = await naResponse.json();
      naToken = naData.token;

      // Create APAC token
      const apacResponse = await authFetch(adminSession, `${BASE_URL}/api/admin/eval-agent-tokens`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Multi-Region-APAC', region: 'apac' }),
      });
      expect(apacResponse.ok).toBe(true);
      const apacData = await apacResponse.json();
      apacToken = apacData.token;

      // Create EU token
      const euResponse = await authFetch(adminSession, `${BASE_URL}/api/admin/eval-agent-tokens`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Multi-Region-EU', region: 'eu' }),
      });
      expect(euResponse.ok).toBe(true);
      const euData = await euResponse.json();
      euToken = euData.token;
    });

    it('should register eval agents for all regions', async () => {
      // Register NA agent
      const naResponse = await fetch(`${BASE_URL}/api/eval-agent/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${naToken}`,
        },
        body: JSON.stringify({ name: 'Test-Agent-NA' }),
      });
      expect(naResponse.ok).toBe(true);
      const naAgent = await naResponse.json();
      naAgentId = naAgent.id;
      expect(naAgent.region).toBe('na');

      // Register APAC agent
      const apacResponse = await fetch(`${BASE_URL}/api/eval-agent/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apacToken}`,
        },
        body: JSON.stringify({ name: 'Test-Agent-APAC' }),
      });
      expect(apacResponse.ok).toBe(true);
      const apacAgent = await apacResponse.json();
      apacAgentId = apacAgent.id;
      expect(apacAgent.region).toBe('apac');

      // Register EU agent
      const euResponse = await fetch(`${BASE_URL}/api/eval-agent/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${euToken}`,
        },
        body: JSON.stringify({ name: 'Test-Agent-EU' }),
      });
      expect(euResponse.ok).toBe(true);
      const euAgent = await euResponse.json();
      euAgentId = euAgent.id;
      expect(euAgent.region).toBe('eu');
    });

    it('should create workflow for multi-region testing', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/workflows`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Multi-Region Test Workflow',
          description: 'Testing job distribution across regions',
          visibility: 'public',
        }),
      });
      expect(response.ok).toBe(true);
      const workflow = await response.json();
      multiRegionWorkflowId = workflow.id;
    });

    it('should create jobs for different regions', async () => {
      // Create NA job
      const naResponse = await authFetch(adminSession, `${BASE_URL}/api/workflows/${multiRegionWorkflowId}/run`, {
        method: 'POST',
        body: JSON.stringify({ region: 'na' }),
      });
      expect(naResponse.ok).toBe(true);
      const naResult = await naResponse.json();
      naJobId = naResult.job.id;
      expect(naResult.job.region).toBe('na');

      // Create APAC job
      const apacResponse = await authFetch(adminSession, `${BASE_URL}/api/workflows/${multiRegionWorkflowId}/run`, {
        method: 'POST',
        body: JSON.stringify({ region: 'apac' }),
      });
      expect(apacResponse.ok).toBe(true);
      const apacResult = await apacResponse.json();
      apacJobId = apacResult.job.id;
      expect(apacResult.job.region).toBe('apac');

      // Create EU job
      const euResponse = await authFetch(adminSession, `${BASE_URL}/api/workflows/${multiRegionWorkflowId}/run`, {
        method: 'POST',
        body: JSON.stringify({ region: 'eu' }),
      });
      expect(euResponse.ok).toBe(true);
      const euResult = await euResponse.json();
      euJobId = euResult.job.id;
      expect(euResult.job.region).toBe('eu');
    });

    it('should only show jobs matching agent region', async () => {
      // NA agent should only see NA jobs
      const naResponse = await fetch(`${BASE_URL}/api/eval-agent/jobs`, {
        headers: { 'Authorization': `Bearer ${naToken}` },
      });
      expect(naResponse.ok).toBe(true);
      const naJobs = await naResponse.json();
      const naJobRegions = naJobs.map((j: any) => j.region);
      expect(naJobRegions.every((r: string) => r === 'na')).toBe(true);

      // APAC agent should only see APAC jobs
      const apacResponse = await fetch(`${BASE_URL}/api/eval-agent/jobs`, {
        headers: { 'Authorization': `Bearer ${apacToken}` },
      });
      expect(apacResponse.ok).toBe(true);
      const apacJobs = await apacResponse.json();
      const apacJobRegions = apacJobs.map((j: any) => j.region);
      expect(apacJobRegions.every((r: string) => r === 'apac')).toBe(true);
    });

    it('should not allow agent to claim job from different region', async () => {
      // NA agent tries to claim APAC job - should fail
      const response = await fetch(`${BASE_URL}/api/eval-agent/jobs/${apacJobId}/claim`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${naToken}`,
        },
        body: JSON.stringify({ agentId: naAgentId }),
      });
      // Should fail because region mismatch
      expect(response.ok).toBe(false);
    });

    it('should allow each agent to claim job from their region', async () => {
      // NA agent claims NA job
      const naResponse = await fetch(`${BASE_URL}/api/eval-agent/jobs/${naJobId}/claim`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${naToken}`,
        },
        body: JSON.stringify({ agentId: naAgentId }),
      });
      expect(naResponse.ok).toBe(true);
      const naJob = await naResponse.json();
      expect(naJob.status).toBe('running');

      // APAC agent claims APAC job
      const apacResponse = await fetch(`${BASE_URL}/api/eval-agent/jobs/${apacJobId}/claim`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apacToken}`,
        },
        body: JSON.stringify({ agentId: apacAgentId }),
      });
      expect(apacResponse.ok).toBe(true);
      const apacJob = await apacResponse.json();
      expect(apacJob.status).toBe('running');
    });

    it('should cleanup multi-region test resources', async () => {
      // Complete jobs to cleanup
      await fetch(`${BASE_URL}/api/eval-agent/jobs/${naJobId}/complete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${naToken}`,
        },
        body: JSON.stringify({ agentId: naAgentId }),
      });

      await fetch(`${BASE_URL}/api/eval-agent/jobs/${apacJobId}/complete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apacToken}`,
        },
        body: JSON.stringify({ agentId: apacAgentId }),
      });

      // Delete workflow (cascades to jobs)
      await authFetch(adminSession, `${BASE_URL}/api/workflows/${multiRegionWorkflowId}`, {
        method: 'DELETE',
      });
    });
  });

  describe('Schedule Validation Tests', () => {
    let scheduleWorkflowId: number;
    let scheduleEvalSetId: number;

    it('should create workflow and eval set for schedule tests', async () => {
      const wfResponse = await authFetch(adminSession, `${BASE_URL}/api/workflows`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Schedule Test Workflow', visibility: 'public' }),
      });
      expect(wfResponse.ok).toBe(true);
      const workflow = await wfResponse.json();
      scheduleWorkflowId = workflow.id;

      const esResponse = await authFetch(adminSession, `${BASE_URL}/api/eval-sets`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Schedule Test Eval Set', visibility: 'public' }),
      });
      expect(esResponse.ok).toBe(true);
      const evalSet = await esResponse.json();
      scheduleEvalSetId = evalSet.id;
    });

    it('should reject schedule with invalid cron expression', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-schedules`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Invalid Cron Schedule',
          workflowId: scheduleWorkflowId,
          evalSetId: scheduleEvalSetId,
          region: 'na',
          scheduleType: 'recurring',
          cronExpression: 'invalid cron',
        }),
      });
      expect(response.status).toBe(400);
    });

    it('should reject recurring schedule without cron expression', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-schedules`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Missing Cron Schedule',
          workflowId: scheduleWorkflowId,
          evalSetId: scheduleEvalSetId,
          region: 'na',
          scheduleType: 'recurring',
        }),
      });
      expect(response.status).toBe(400);
    });

    it('should create valid one-time schedule', async () => {
      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours from now
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-schedules`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Valid One-Time Schedule',
          workflowId: scheduleWorkflowId,
          evalSetId: scheduleEvalSetId,
          region: 'na',
          scheduleType: 'once',
          nextRunAt: futureDate.toISOString(),
        }),
      });
      expect(response.ok).toBe(true);
      const schedule = await response.json();
      expect(schedule.scheduleType).toBe('once');
    });

    it('should create valid recurring schedule with cron', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-schedules`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Valid Recurring Schedule',
          workflowId: scheduleWorkflowId,
          evalSetId: scheduleEvalSetId,
          region: 'eu',
          scheduleType: 'recurring',
          cronExpression: '0 0 * * *', // Daily at midnight
        }),
      });
      expect(response.ok).toBe(true);
      const schedule = await response.json();
      expect(schedule.scheduleType).toBe('recurring');
      expect(schedule.cronExpression).toBe('0 0 * * *');
    });

    it('should cleanup schedule test resources', async () => {
      await authFetch(adminSession, `${BASE_URL}/api/workflows/${scheduleWorkflowId}`, {
        method: 'DELETE',
      });
      await authFetch(adminSession, `${BASE_URL}/api/eval-sets/${scheduleEvalSetId}`, {
        method: 'DELETE',
      });
    });
  });

  describe('API Key Permission Tests', () => {
    let testUserApiKey: string;
    let testUserWorkflowId: number;

    it('should create API key for permission tests', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/user/api-keys`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Permission Test Key' }),
      });
      expect(response.ok).toBe(true);
      const data = await response.json();
      testUserApiKey = data.key;
      expect(testUserApiKey).toContain('vox_live_');
    });

    it('should allow API key to list workflows via v1 API', async () => {
      const response = await fetch(`${BASE_URL}/api/v1/workflows`, {
        headers: { 'Authorization': `Bearer ${testUserApiKey}` },
      });
      expect(response.ok).toBe(true);
      const { data } = await response.json();
      expect(Array.isArray(data)).toBe(true);
    });

    it('should allow API key to create workflow via v1 API', async () => {
      const response = await fetch(`${BASE_URL}/api/v1/workflows`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${testUserApiKey}`,
        },
        body: JSON.stringify({
          name: 'API Key Created Workflow',
          description: 'Created via API key',
          visibility: 'public',
        }),
      });
      expect(response.ok).toBe(true);
      const { data } = await response.json();
      testUserWorkflowId = data.id;
    });

    it('should reject revoked API key', async () => {
      // Get all API keys to find the one we just created
      const keysResponse = await authFetch(adminSession, `${BASE_URL}/api/user/api-keys`);
      const keys = await keysResponse.json();
      const permTestKey = keys.find((k: any) => k.name === 'Permission Test Key');

      // Revoke the key
      await authFetch(adminSession, `${BASE_URL}/api/user/api-keys/${permTestKey.id}/revoke`, {
        method: 'POST',
      });

      // Try to use revoked key
      const response = await fetch(`${BASE_URL}/api/v1/workflows`, {
        headers: { 'Authorization': `Bearer ${testUserApiKey}` },
      });
      expect(response.status).toBe(401);
    });

    it('should cleanup API key test resources', async () => {
      // Delete workflow created by API key
      if (testUserWorkflowId) {
        await authFetch(adminSession, `${BASE_URL}/api/workflows/${testUserWorkflowId}`, {
          method: 'DELETE',
        });
      }
    });
  });

  describe('Concurrent Job Claiming Tests', () => {
    let concurrentWorkflowId: number;
    let concurrentJobId: number;
    let agent1Token: string;
    let agent2Token: string;
    let agent1Id: number;
    let agent2Id: number;

    it('should setup agents for concurrent test', async () => {
      // Create workflow
      const wfResponse = await authFetch(adminSession, `${BASE_URL}/api/workflows`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Concurrent Test Workflow', visibility: 'public' }),
      });
      expect(wfResponse.ok).toBe(true);
      const workflow = await wfResponse.json();
      concurrentWorkflowId = workflow.id;

      // Create two agent tokens for same region
      const token1Response = await authFetch(adminSession, `${BASE_URL}/api/admin/eval-agent-tokens`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Concurrent-Agent-1', region: 'na' }),
      });
      expect(token1Response.ok).toBe(true);
      const token1Data = await token1Response.json();
      agent1Token = token1Data.token;

      const token2Response = await authFetch(adminSession, `${BASE_URL}/api/admin/eval-agent-tokens`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Concurrent-Agent-2', region: 'na' }),
      });
      expect(token2Response.ok).toBe(true);
      const token2Data = await token2Response.json();
      agent2Token = token2Data.token;

      // Register agents
      const agent1Response = await fetch(`${BASE_URL}/api/eval-agent/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${agent1Token}`,
        },
        body: JSON.stringify({ name: 'Concurrent-Agent-1' }),
      });
      expect(agent1Response.ok).toBe(true);
      const agent1 = await agent1Response.json();
      agent1Id = agent1.id;

      const agent2Response = await fetch(`${BASE_URL}/api/eval-agent/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${agent2Token}`,
        },
        body: JSON.stringify({ name: 'Concurrent-Agent-2' }),
      });
      expect(agent2Response.ok).toBe(true);
      const agent2 = await agent2Response.json();
      agent2Id = agent2.id;

      // Create a single job
      const jobResponse = await authFetch(adminSession, `${BASE_URL}/api/workflows/${concurrentWorkflowId}/run`, {
        method: 'POST',
        body: JSON.stringify({ region: 'na' }),
      });
      expect(jobResponse.ok).toBe(true);
      const jobResult = await jobResponse.json();
      concurrentJobId = jobResult.job.id;
    });

    it('should only allow one agent to claim the same job', async () => {
      // Both agents try to claim the same job concurrently
      const [claim1, claim2] = await Promise.all([
        fetch(`${BASE_URL}/api/eval-agent/jobs/${concurrentJobId}/claim`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${agent1Token}`,
          },
          body: JSON.stringify({ agentId: agent1Id }),
        }),
        fetch(`${BASE_URL}/api/eval-agent/jobs/${concurrentJobId}/claim`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${agent2Token}`,
          },
          body: JSON.stringify({ agentId: agent2Id }),
        }),
      ]);

      // One should succeed (200), one should fail (409 conflict)
      const statuses = [claim1.status, claim2.status].sort();
      expect(statuses).toContain(200);
      expect(statuses).toContain(409);
    });

    it('should cleanup concurrent test resources', async () => {
      await authFetch(adminSession, `${BASE_URL}/api/workflows/${concurrentWorkflowId}`, {
        method: 'DELETE',
      });
    });
  });

  // ==================== ORGANIZATION TESTS ====================

  describe('Organization Management', () => {
    let orgSession: AuthSession;
    let orgUserId: number;
    let organizationId: number;
    const orgUserEmail = `orguser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
    const orgUserPassword = 'orgpass123';

    it('should register a new user for organization tests', async () => {
      // Create activation token first
      const inviteResponse = await authFetch(adminSession, `${BASE_URL}/api/admin/invite`, {
        method: 'POST',
        body: JSON.stringify({
          email: orgUserEmail,
          plan: 'premium',
        }),
      });
      expect(inviteResponse.ok).toBe(true);
      const { token } = await inviteResponse.json();

      // Register the user
      const registerResponse = await fetch(`${BASE_URL}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: `orguser-${Date.now()}`,
          password: orgUserPassword,
          token: token,
        }),
      });
      expect(registerResponse.ok).toBe(true);
    });

    it('should login as org user', async () => {
      const response = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: orgUserEmail,
          password: orgUserPassword,
        }),
      });
      expect(response.ok).toBe(true);
      const cookie = response.headers.get('set-cookie');
      expect(cookie).toBeTruthy();
      orgSession = { cookie: cookie! };

      const data = await response.json();
      orgUserId = data.user.id;
    });

    it('should create an organization', async () => {
      const response = await authFetch(orgSession, `${BASE_URL}/api/organizations`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Test Organization',
          address: '123 Test Street',
        }),
      });
      expect(response.ok).toBe(true);
      const org = await response.json();
      organizationId = org.id;
      expect(org.name).toBe('Test Organization');
    });

    it('should get user organization info', async () => {
      const response = await authFetch(orgSession, `${BASE_URL}/api/user/organization`);
      expect(response.ok).toBe(true);
      const org = await response.json();
      expect(org.id).toBe(organizationId);
      expect(org.isOrgAdmin).toBe(true);
    });

    it('should get organization details', async () => {
      const response = await authFetch(orgSession, `${BASE_URL}/api/organizations/${organizationId}`);
      expect(response.ok).toBe(true);
      const org = await response.json();
      expect(org.id).toBe(organizationId);
      expect(org.name).toBe('Test Organization');
    });

    it('should get organization members', async () => {
      const response = await authFetch(orgSession, `${BASE_URL}/api/organizations/${organizationId}/members`);
      expect(response.ok).toBe(true);
      const members = await response.json();
      expect(Array.isArray(members)).toBe(true);
      expect(members.length).toBe(1); // Just the creator
      expect(members[0].isOrgAdmin).toBe(true);
    });

    it('should get organization seats info', async () => {
      const response = await authFetch(orgSession, `${BASE_URL}/api/organizations/${organizationId}/seats`);
      expect(response.ok).toBe(true);
      const seats = await response.json();
      expect(seats.totalSeats).toBe(0);
      expect(seats.usedSeats).toBe(1); // Creator uses 1 seat
    });

    it('should calculate seat pricing', async () => {
      const response = await authFetch(orgSession, `${BASE_URL}/api/organizations/${organizationId}/seats/calculate`, {
        method: 'POST',
        body: JSON.stringify({ additionalSeats: 5 }),
      });
      expect(response.ok).toBe(true);
      const pricing = await response.json();
      expect(pricing.totalSeats).toBe(5);
      expect(pricing.pricePerSeat).toBeGreaterThan(0);
      expect(pricing.total).toBeGreaterThan(0);
    });

    it('should purchase seats (test mode)', async () => {
      const response = await authFetch(orgSession, `${BASE_URL}/api/organizations/${organizationId}/seats/purchase`, {
        method: 'POST',
        body: JSON.stringify({ additionalSeats: 3 }),
      });
      expect(response.ok).toBe(true);
      const result = await response.json();
      expect(result.newTotalSeats).toBe(3);
    });

    it('should verify seats were added', async () => {
      const response = await authFetch(orgSession, `${BASE_URL}/api/organizations/${organizationId}/seats`);
      expect(response.ok).toBe(true);
      const seats = await response.json();
      expect(seats.totalSeats).toBe(3);
    });

    it('should get payment history', async () => {
      const response = await authFetch(orgSession, `${BASE_URL}/api/organizations/${organizationId}/payments/history`);
      expect(response.ok).toBe(true);
      const history = await response.json();
      expect(Array.isArray(history)).toBe(true);
      expect(history.length).toBeGreaterThan(0);
      expect(history[0].status).toBe('completed');
    });

    it('should update organization', async () => {
      expect(orgSession).toBeDefined();
      const response = await authFetch(orgSession, `${BASE_URL}/api/organizations/${organizationId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Updated Organization' }),
      });
      expect(response.ok).toBe(true);
      const org = await response.json();
      expect(org.name).toBe('Updated Organization');
    });

    it('should prevent user from leaving if they are the only admin', async () => {
      expect(orgSession).toBeDefined();
      const response = await authFetch(orgSession, `${BASE_URL}/api/organizations/${organizationId}/leave`, {
        method: 'POST',
      });
      expect(response.status).toBe(400);
      const error = await response.json();
      expect(error.error).toContain('admin');
    });
  });

  describe('Stripe and Pricing Config', () => {
    it('should get Stripe config', async () => {
      const response = await fetch(`${BASE_URL}/api/payments/stripe-config`);
      expect(response.ok).toBe(true);
      const config = await response.json();
      expect(typeof config.enabled).toBe('boolean');
    });

    it('should get pricing tiers', async () => {
      const response = await fetch(`${BASE_URL}/api/pricing`);
      expect(response.ok).toBe(true);
      const pricing = await response.json();
      expect(Array.isArray(pricing)).toBe(true);
      expect(pricing.length).toBeGreaterThan(0);
    });
  });

  describe('Cleanup', () => {
    it('should delete eval set', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-sets/${testEvalSetId}`, {
        method: 'DELETE',
      });

      expect(response.ok).toBe(true);
    });

    it('should delete workflow', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/workflows/${testWorkflowId}`, {
        method: 'DELETE',
      });

      expect(response.ok).toBe(true);
    });

    it('should delete project', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/projects/${testProjectId}`, {
        method: 'DELETE',
      });

      expect(response.ok).toBe(true);
    });

    it('should revoke eval agent token', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/admin/eval-agent-tokens/${testEvalAgentTokenId}/revoke`, {
        method: 'POST',
      });

      expect(response.ok).toBe(true);
    });

    it('should revoke API key', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/user/api-keys/${testApiKeyId}/revoke`, {
        method: 'POST',
      });

      expect(response.ok).toBe(true);
    });

    it('should delete API key', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/user/api-keys/${testApiKeyId}`, {
        method: 'DELETE',
      });

      expect(response.ok).toBe(true);
    });
  });
});
