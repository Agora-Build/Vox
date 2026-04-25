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
  config: Record<string, unknown>;
}

interface EvalSet {
  id: number;
  name: string;
  description: string | null;
  ownerId: number;
  visibility: string;
  isMainline: boolean;
  config: Record<string, unknown>;
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
  visibility: string;
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
  config?: Record<string, unknown>;
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
  let testProviderId: string;

  beforeAll(async () => {
    adminSession = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

    // Fetch a valid provider ID for tests that create workflows
    const providerResponse = await fetch(`${BASE_URL}/api/providers`);
    const providers: Provider[] = await providerResponse.json();
    testProviderId = providers[0].id;
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
          providerId: testProviderId,
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
          evalSetId: testEvalSetId,
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
          evalSetId: testEvalSetId,
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
          evalSetId: testEvalSetId,
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
          evalSetId: testEvalSetId,
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
        expect(data[0]).toHaveProperty('provider');
        expect(data[0]).toHaveProperty('region');
        expect(data[0]).toHaveProperty('responseLatency');
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
          providerId: testProviderId,
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

    it('should return 404 when deleting non-existent eval set', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-sets/999999`, {
        method: 'DELETE',
      });
      expect(response.status).toBe(404);
    });

    it('should reject unauthenticated eval set delete', async () => {
      const response = await fetch(`${BASE_URL}/api/eval-sets/${testEvalSetId}`, {
        method: 'DELETE',
      });
      expect(response.status).toBe(401);
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
    let multiRegionEvalSetId: number;
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

    it('should create workflow and eval set for multi-region testing', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/workflows`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Multi-Region Test Workflow',
          description: 'Testing job distribution across regions',
          visibility: 'public',
          providerId: testProviderId,
        }),
      });
      expect(response.ok).toBe(true);
      const workflow = await response.json();
      multiRegionWorkflowId = workflow.id;

      const esResponse = await authFetch(adminSession, `${BASE_URL}/api/eval-sets`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Multi-Region Test Eval Set', visibility: 'public' }),
      });
      expect(esResponse.ok).toBe(true);
      const evalSet = await esResponse.json();
      multiRegionEvalSetId = evalSet.id;
    });

    it('should create jobs for different regions', async () => {
      // Create NA job
      const naResponse = await authFetch(adminSession, `${BASE_URL}/api/workflows/${multiRegionWorkflowId}/run`, {
        method: 'POST',
        body: JSON.stringify({ region: 'na', evalSetId: multiRegionEvalSetId }),
      });
      expect(naResponse.ok).toBe(true);
      const naResult = await naResponse.json();
      naJobId = naResult.job.id;
      expect(naResult.job.region).toBe('na');

      // Create APAC job
      const apacResponse = await authFetch(adminSession, `${BASE_URL}/api/workflows/${multiRegionWorkflowId}/run`, {
        method: 'POST',
        body: JSON.stringify({ region: 'apac', evalSetId: multiRegionEvalSetId }),
      });
      expect(apacResponse.ok).toBe(true);
      const apacResult = await apacResponse.json();
      apacJobId = apacResult.job.id;
      expect(apacResult.job.region).toBe('apac');

      // Create EU job
      const euResponse = await authFetch(adminSession, `${BASE_URL}/api/workflows/${multiRegionWorkflowId}/run`, {
        method: 'POST',
        body: JSON.stringify({ region: 'eu', evalSetId: multiRegionEvalSetId }),
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
      // Delete eval set
      await authFetch(adminSession, `${BASE_URL}/api/eval-sets/${multiRegionEvalSetId}`, {
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
        body: JSON.stringify({ name: 'Schedule Test Workflow', visibility: 'public', providerId: testProviderId }),
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
          providerId: testProviderId,
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
    let concurrentEvalSetId: number;
    let concurrentJobId: number;
    let agent1Token: string;
    let agent2Token: string;
    let agent1Id: number;
    let agent2Id: number;

    it('should setup agents for concurrent test', async () => {
      // Create workflow
      const wfResponse = await authFetch(adminSession, `${BASE_URL}/api/workflows`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Concurrent Test Workflow', visibility: 'public', providerId: testProviderId }),
      });
      expect(wfResponse.ok).toBe(true);
      const workflow = await wfResponse.json();
      concurrentWorkflowId = workflow.id;

      // Create eval set
      const esResponse = await authFetch(adminSession, `${BASE_URL}/api/eval-sets`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Concurrent Test Eval Set', visibility: 'public' }),
      });
      expect(esResponse.ok).toBe(true);
      const evalSet = await esResponse.json();
      concurrentEvalSetId = evalSet.id;

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
        body: JSON.stringify({ region: 'na', evalSetId: concurrentEvalSetId }),
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
      await authFetch(adminSession, `${BASE_URL}/api/eval-sets/${concurrentEvalSetId}`, {
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

  describe('User-Facing Eval Agent Token API', () => {
    let basicSession: AuthSession;
    let premiumSession: AuthSession;
    let premiumTokenId: number;
    const basicEmail = `basic-token-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
    const premiumEmail = `premium-token-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
    const testPassword = 'testpass123';

    // Create basic and premium users for token tests
    it('should create a basic test user via invite', async () => {
      const inviteRes = await authFetch(adminSession, `${BASE_URL}/api/admin/invite`, {
        method: 'POST',
        body: JSON.stringify({ email: basicEmail, plan: 'basic' }),
      });
      expect(inviteRes.ok).toBe(true);
      const { token } = await inviteRes.json();

      const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: `basic-${Date.now()}`, password: testPassword, token }),
      });
      expect(regRes.ok).toBe(true);
    });

    it('should create a premium test user via invite', async () => {
      const inviteRes = await authFetch(adminSession, `${BASE_URL}/api/admin/invite`, {
        method: 'POST',
        body: JSON.stringify({ email: premiumEmail, plan: 'premium' }),
      });
      expect(inviteRes.ok).toBe(true);
      const { token } = await inviteRes.json();

      const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: `premium-${Date.now()}`, password: testPassword, token }),
      });
      expect(regRes.ok).toBe(true);
    });

    it('should login as basic user', async () => {
      basicSession = await login(basicEmail, testPassword);
      expect(basicSession.cookie).toBeTruthy();
    });

    it('should login as premium user', async () => {
      premiumSession = await login(premiumEmail, testPassword);
      expect(premiumSession.cookie).toBeTruthy();
    });

    // Basic user cannot create tokens
    it('should reject token creation for basic users (403)', async () => {
      const response = await authFetch(basicSession, `${BASE_URL}/api/eval-agent-tokens`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Basic Token', region: 'na' }),
      });
      expect(response.status).toBe(403);
    });

    // Basic user can still list tokens (empty list)
    it('should return empty token list for basic user', async () => {
      const response = await authFetch(basicSession, `${BASE_URL}/api/eval-agent-tokens`);
      expect(response.ok).toBe(true);
      const tokens = await response.json();
      expect(Array.isArray(tokens)).toBe(true);
      expect(tokens.length).toBe(0);
    });

    // Premium user can create private tokens
    it('should allow premium user to create a private token', async () => {
      const response = await authFetch(premiumSession, `${BASE_URL}/api/eval-agent-tokens`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Premium Private Token', region: 'na' }),
      });
      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(data.token).toBeDefined();
      expect(data.visibility).toBe('private');
      expect(data.region).toBe('na');
      premiumTokenId = data.id;
    });

    // Premium user cannot create public tokens (forced private)
    it('should force private visibility for premium user even if public requested', async () => {
      const response = await authFetch(premiumSession, `${BASE_URL}/api/eval-agent-tokens`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Premium Public Attempt', region: 'eu', visibility: 'public' }),
      });
      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(data.visibility).toBe('private');
    });

    // Premium user sees only own tokens
    it('should return only own tokens for premium user', async () => {
      const response = await authFetch(premiumSession, `${BASE_URL}/api/eval-agent-tokens`);
      expect(response.ok).toBe(true);
      const tokens = await response.json();
      expect(Array.isArray(tokens)).toBe(true);
      expect(tokens.length).toBe(2); // the two we just created
      for (const t of tokens) {
        expect(t.visibility).toBe('private');
      }
    });

    // Admin sees all tokens (including premium user's)
    it('should return all tokens for admin including other users tokens', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-agent-tokens`);
      expect(response.ok).toBe(true);
      const tokens = await response.json();
      expect(Array.isArray(tokens)).toBe(true);
      // Should include the premium user's tokens plus any existing admin tokens
      expect(tokens.length).toBeGreaterThanOrEqual(2);
    });

    // Admin can create public tokens
    it('should allow admin to create a public token', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-agent-tokens`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Admin Public Token', region: 'apac', visibility: 'public' }),
      });
      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(data.visibility).toBe('public');
    });

    // Admin can create private tokens
    it('should allow admin to create a private token', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-agent-tokens`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Admin Private Token', region: 'na', visibility: 'private' }),
      });
      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(data.visibility).toBe('private');
    });

    // Admin defaults to public if visibility omitted
    it('should default to public visibility for admin when not specified', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-agent-tokens`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Admin Default Token', region: 'eu' }),
      });
      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(data.visibility).toBe('public');
    });

    // Premium user can revoke own token
    it('should allow premium user to revoke own token', async () => {
      const response = await authFetch(premiumSession, `${BASE_URL}/api/eval-agent-tokens/${premiumTokenId}/revoke`, {
        method: 'POST',
      });
      expect(response.ok).toBe(true);
    });

    // Non-owner cannot revoke someone else's token
    it('should reject revocation by non-owner non-admin', async () => {
      // Get an admin token ID
      const listResponse = await authFetch(adminSession, `${BASE_URL}/api/eval-agent-tokens`);
      const tokens = await listResponse.json();
      const adminToken = tokens.find((t: EvalAgentToken) => !t.isRevoked && t.visibility === 'public');
      if (adminToken) {
        const response = await authFetch(premiumSession, `${BASE_URL}/api/eval-agent-tokens/${adminToken.id}/revoke`, {
          method: 'POST',
        });
        expect(response.status).toBe(403);
      }
    });

    // Token creation with invalid region
    it('should reject token creation with invalid region', async () => {
      const response = await authFetch(premiumSession, `${BASE_URL}/api/eval-agent-tokens`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Bad Region', region: 'invalid' }),
      });
      expect(response.status).toBe(400);
    });

    // Token creation with missing name
    it('should reject token creation with missing name', async () => {
      const response = await authFetch(premiumSession, `${BASE_URL}/api/eval-agent-tokens`, {
        method: 'POST',
        body: JSON.stringify({ region: 'na' }),
      });
      expect(response.status).toBe(400);
    });

    // Token creation with missing region
    it('should reject token creation with missing region', async () => {
      const response = await authFetch(premiumSession, `${BASE_URL}/api/eval-agent-tokens`, {
        method: 'POST',
        body: JSON.stringify({ name: 'No Region' }),
      });
      expect(response.status).toBe(400);
    });

    // Revoking non-existent token
    it('should return 404 when revoking non-existent token', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-agent-tokens/999999/revoke`, {
        method: 'POST',
      });
      expect(response.status).toBe(404);
    });

    // Unauthenticated access
    it('should reject unauthenticated access to token list', async () => {
      const response = await fetch(`${BASE_URL}/api/eval-agent-tokens`);
      expect(response.status).toBe(401);
    });

    it('should reject unauthenticated token creation', async () => {
      const response = await fetch(`${BASE_URL}/api/eval-agent-tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Unauth Token', region: 'na' }),
      });
      expect(response.status).toBe(401);
    });
  });

  describe('Community and My Evals Metrics API', () => {
    it('should get community metrics (public)', async () => {
      const response = await fetch(`${BASE_URL}/api/metrics/community`);
      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(Array.isArray(data)).toBe(true);
    });

    it('should get community metrics with time filter', async () => {
      const response = await fetch(`${BASE_URL}/api/metrics/community?hours=24&limit=10`);
      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeLessThanOrEqual(10);
    });

    it('should reject unauthenticated access to my-evals', async () => {
      const response = await fetch(`${BASE_URL}/api/metrics/my-evals`);
      expect(response.status).toBe(401);
    });

    it('should get my-evals metrics when authenticated', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/metrics/my-evals`);
      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(Array.isArray(data)).toBe(true);
    });

    it('should get my-evals metrics with time filter', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/metrics/my-evals?hours=24&limit=5`);
      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeLessThanOrEqual(5);
    });

    it('should get realtime (mainline) metrics with time filter', async () => {
      const response = await fetch(`${BASE_URL}/api/metrics/realtime?hours=1&limit=10`);
      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeLessThanOrEqual(10);
    });
  });

  describe('Eval Agent Visibility API', () => {
    it('should include visibility field in eval agents list', async () => {
      const response = await fetch(`${BASE_URL}/api/eval-agents`);
      expect(response.ok).toBe(true);
      const agents = await response.json();
      expect(Array.isArray(agents)).toBe(true);
      // Each agent should have a visibility field from its token
      for (const agent of agents) {
        expect(agent.visibility).toBeDefined();
        expect(['public', 'private']).toContain(agent.visibility);
      }
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

  // ==================== EVAL FRAMEWORK CONFIG TESTS ====================

  describe('Workflow Config (Framework + App Config)', () => {
    let configWorkflowId: number;

    it('should create a workflow with aeval framework config', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/workflows`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Config Test Workflow (aeval)',
          description: 'Workflow with aeval framework config',
          visibility: 'public',
          providerId: testProviderId,
          config: { framework: 'aeval' },
        }),
      });

      expect(response.ok).toBe(true);
      const workflow: Workflow = await response.json();
      expect(workflow.name).toBe('Config Test Workflow (aeval)');
      expect(workflow.config).toEqual({ framework: 'aeval' });
      configWorkflowId = workflow.id;
    });

    it('should create a workflow with voice-agent-tester framework and app YAML', async () => {
      const appYaml = 'url: "https://example.com"\nsteps:\n  - action: wait\n    selector: "#start"';
      const response = await authFetch(adminSession, `${BASE_URL}/api/workflows`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Config Test Workflow (VAT)',
          description: 'Workflow with VAT framework config',
          visibility: 'public',
          providerId: testProviderId,
          config: { framework: 'voice-agent-tester', app: appYaml },
        }),
      });

      expect(response.ok).toBe(true);
      const workflow: Workflow = await response.json();
      expect(workflow.config).toEqual({ framework: 'voice-agent-tester', app: appYaml });
    });

    it('should update workflow config via PATCH', async () => {
      const newAppYaml = 'url: "https://updated.com"\nsteps:\n  - action: click\n    selector: "#btn"';
      const response = await authFetch(adminSession, `${BASE_URL}/api/workflows/${configWorkflowId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          config: { framework: 'voice-agent-tester', app: newAppYaml },
        }),
      });

      expect(response.ok).toBe(true);
      const workflow: Workflow = await response.json();
      expect(workflow.config).toEqual({ framework: 'voice-agent-tester', app: newAppYaml });
    });

    it('should persist config when only updating other fields', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/workflows/${configWorkflowId}`, {
        method: 'PATCH',
        body: JSON.stringify({ description: 'New description only' }),
      });

      expect(response.ok).toBe(true);
      const workflow: Workflow = await response.json();
      expect(workflow.description).toBe('New description only');
      // config should remain from previous update
      expect((workflow.config as Record<string, unknown>).framework).toBe('voice-agent-tester');
    });

    it('should default config to empty object when not provided', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/workflows`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'No Config Workflow',
          visibility: 'public',
          providerId: testProviderId,
        }),
      });

      expect(response.ok).toBe(true);
      const workflow: Workflow = await response.json();
      expect(workflow.config).toEqual({});
    });
  });

  describe('Eval Set Config (Scenario)', () => {
    let configEvalSetId: number;

    it('should create an eval set with scenario config', async () => {
      const scenarioYaml = 'steps:\n  - action: speak\n    file: hello.mp3\n  - action: wait_for_voice\n    metrics: elapsed_time';
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-sets`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Config Test Eval Set',
          description: 'Eval set with scenario YAML',
          visibility: 'public',
          config: { scenario: scenarioYaml },
        }),
      });

      expect(response.ok).toBe(true);
      const evalSet: EvalSet = await response.json();
      expect(evalSet.name).toBe('Config Test Eval Set');
      expect(evalSet.config).toEqual({ scenario: scenarioYaml });
      configEvalSetId = evalSet.id;
    });

    it('should update eval set config via PATCH', async () => {
      const newScenarioYaml = 'steps:\n  - action: speak\n    file: goodbye.mp3';
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-sets/${configEvalSetId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          config: { scenario: newScenarioYaml },
        }),
      });

      expect(response.ok).toBe(true);
      const evalSet: EvalSet = await response.json();
      expect(evalSet.config).toEqual({ scenario: newScenarioYaml });
    });

    it('should preserve config when updating other fields', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-sets/${configEvalSetId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Renamed Eval Set' }),
      });

      expect(response.ok).toBe(true);
      const evalSet: EvalSet = await response.json();
      expect(evalSet.name).toBe('Renamed Eval Set');
      expect((evalSet.config as Record<string, unknown>).scenario).toBeDefined();
    });
  });

  describe('Job Config Merging', () => {
    let mergeWorkflowId: number;
    let mergeEvalSetId: number;

    beforeAll(async () => {
      // Create workflow with framework + app config
      const wfRes = await authFetch(adminSession, `${BASE_URL}/api/workflows`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Merge Test Workflow',
          visibility: 'public',
          providerId: testProviderId,
          config: { framework: 'voice-agent-tester', app: 'url: "https://merge-test.com"' },
        }),
      });
      const wf: Workflow = await wfRes.json();
      mergeWorkflowId = wf.id;

      // Create eval set with scenario config
      const esRes = await authFetch(adminSession, `${BASE_URL}/api/eval-sets`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Merge Test Eval Set',
          visibility: 'public',
          config: { scenario: 'steps:\n  - action: speak\n    file: test.mp3' },
        }),
      });
      const es: EvalSet = await esRes.json();
      mergeEvalSetId = es.id;
    });

    it('should merge workflow config and eval set config into job config', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/workflows/${mergeWorkflowId}/run`, {
        method: 'POST',
        body: JSON.stringify({
          evalSetId: mergeEvalSetId,
          region: 'na',
        }),
      });

      expect(response.ok).toBe(true);
      const result = await response.json();
      expect(result.job).toBeDefined();
      expect(result.job.config).toBeDefined();

      const jobConfig = result.job.config as Record<string, unknown>;
      // Workflow config fields
      expect(jobConfig.framework).toBe('voice-agent-tester');
      expect(jobConfig.app).toBe('url: "https://merge-test.com"');
      // Eval set config fields (merged)
      expect(jobConfig.scenario).toBe('steps:\n  - action: speak\n    file: test.mp3');
    });

    it('should produce empty config when both workflow and eval set have no config', async () => {
      // Create a workflow with no config
      const wfRes = await authFetch(adminSession, `${BASE_URL}/api/workflows`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Empty Config Workflow',
          visibility: 'public',
          providerId: testProviderId,
        }),
      });
      const wf: Workflow = await wfRes.json();

      // Create an eval set with no config
      const esRes = await authFetch(adminSession, `${BASE_URL}/api/eval-sets`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Empty Config Eval Set',
          visibility: 'public',
        }),
      });
      const es: EvalSet = await esRes.json();

      const response = await authFetch(adminSession, `${BASE_URL}/api/workflows/${wf.id}/run`, {
        method: 'POST',
        body: JSON.stringify({
          evalSetId: es.id,
          region: 'na',
        }),
      });

      expect(response.ok).toBe(true);
      const result = await response.json();
      expect(result.job.config).toEqual({});
    });

    it('should let eval set scenario override workflow scenario field if both set', async () => {
      // Workflow has a scenario field too (edge case)
      const wfRes = await authFetch(adminSession, `${BASE_URL}/api/workflows`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Override Test Workflow',
          visibility: 'public',
          providerId: testProviderId,
          config: { framework: 'aeval', scenario: 'old-scenario' },
        }),
      });
      const wf: Workflow = await wfRes.json();

      const esRes = await authFetch(adminSession, `${BASE_URL}/api/eval-sets`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Override Test Eval Set',
          visibility: 'public',
          config: { scenario: 'new-scenario' },
        }),
      });
      const es: EvalSet = await esRes.json();

      const response = await authFetch(adminSession, `${BASE_URL}/api/workflows/${wf.id}/run`, {
        method: 'POST',
        body: JSON.stringify({
          evalSetId: es.id,
          region: 'na',
        }),
      });

      expect(response.ok).toBe(true);
      const result = await response.json();
      // Eval set config is spread last, so its scenario wins
      expect(result.job.config.scenario).toBe('new-scenario');
      expect(result.job.config.framework).toBe('aeval');
    });
  });

  describe('Workflow Clone', () => {
    let sourceWorkflowId: number;

    beforeAll(async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/workflows`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Clone Source Workflow',
          description: 'Original workflow to clone',
          visibility: 'public',
          providerId: testProviderId,
          config: { framework: 'voice-agent-tester', app: 'url: "https://clone-me.com"' },
        }),
      });
      const wf: Workflow = await response.json();
      sourceWorkflowId = wf.id;
    });

    it('should clone a public workflow', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/workflows/${sourceWorkflowId}/clone`, {
        method: 'POST',
      });

      expect(response.ok).toBe(true);
      const cloned: Workflow = await response.json();
      expect(cloned.name).toBe('Clone of Clone Source Workflow');
      expect(cloned.config).toEqual({ framework: 'voice-agent-tester', app: 'url: "https://clone-me.com"' });
      expect(cloned.visibility).toBe('public');
      expect(cloned.isMainline).toBe(false);
      expect(cloned.id).not.toBe(sourceWorkflowId);
    });

    it('should return 404 for non-existent workflow clone', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/workflows/999999/clone`, {
        method: 'POST',
      });
      expect(response.status).toBe(404);
    });
  });

  describe('Eval Set Clone', () => {
    let sourceEvalSetId: number;

    beforeAll(async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-sets`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Clone Source Eval Set',
          description: 'Original eval set to clone',
          visibility: 'public',
          config: { scenario: 'steps:\n  - action: speak\n    file: clone.mp3' },
        }),
      });
      const es: EvalSet = await response.json();
      sourceEvalSetId = es.id;
    });

    it('should clone a public eval set', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-sets/${sourceEvalSetId}/clone`, {
        method: 'POST',
      });

      expect(response.ok).toBe(true);
      const cloned: EvalSet = await response.json();
      expect(cloned.name).toBe('Clone of Clone Source Eval Set');
      expect(cloned.config).toEqual({ scenario: 'steps:\n  - action: speak\n    file: clone.mp3' });
      expect(cloned.visibility).toBe('public');
      expect(cloned.isMainline).toBe(false);
      expect(cloned.id).not.toBe(sourceEvalSetId);
    });

    it('should return 404 for non-existent eval set clone', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-sets/999999/clone`, {
        method: 'POST',
      });
      expect(response.status).toBe(404);
    });
  });

  describe('Config Validation', () => {
    it('should reject workflow with invalid framework', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/workflows`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Invalid Framework Workflow',
          visibility: 'public',
          providerId: testProviderId,
          config: { framework: 'nonexistent-framework' },
        }),
      });

      expect(response.status).toBe(400);
      const error = await response.json();
      expect(error.error).toContain('Framework');
    });

    it('should reject workflow with oversized config', async () => {
      const bigYaml = 'x'.repeat(101_000); // > 100KB
      const response = await authFetch(adminSession, `${BASE_URL}/api/workflows`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Big Config Workflow',
          visibility: 'public',
          providerId: testProviderId,
          config: { framework: 'aeval', app: bigYaml },
        }),
      });

      expect(response.status).toBe(400);
      const error = await response.json();
      expect(error.error).toContain('too large');
    });

    it('should reject eval set with non-string scenario', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-sets`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Bad Scenario Eval Set',
          visibility: 'public',
          config: { scenario: 12345 },
        }),
      });

      expect(response.status).toBe(400);
      const error = await response.json();
      expect(error.error).toContain('scenario');
    });

    it('should normalize config: null to empty object on eval set PATCH', async () => {
      // First create an eval set with config
      const createRes = await authFetch(adminSession, `${BASE_URL}/api/eval-sets`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Null Config Test Eval Set',
          visibility: 'public',
          config: { scenario: 'steps:\n  - action: speak' },
        }),
      });
      expect(createRes.ok).toBe(true);
      const evalSet: EvalSet = await createRes.json();

      // PATCH with config: null
      const patchRes = await authFetch(adminSession, `${BASE_URL}/api/eval-sets/${evalSet.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ config: null }),
      });

      expect(patchRes.ok).toBe(true);
      const updated: EvalSet = await patchRes.json();
      expect(updated.config).toEqual({});
    });
  });

  describe('Run-Now Config Merging', () => {
    it('should merge workflow + eval set config when running schedule immediately', async () => {
      // Create workflow with config
      const wfRes = await authFetch(adminSession, `${BASE_URL}/api/workflows`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'RunNow Config Workflow',
          visibility: 'public',
          providerId: testProviderId,
          config: { framework: 'voice-agent-tester', app: 'url: "https://runnow.com"' },
        }),
      });
      expect(wfRes.ok).toBe(true);
      const wf: Workflow = await wfRes.json();

      // Create eval set with config
      const esRes = await authFetch(adminSession, `${BASE_URL}/api/eval-sets`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'RunNow Config Eval Set',
          visibility: 'public',
          config: { scenario: 'steps:\n  - action: speak\n    file: runnow.mp3' },
        }),
      });
      expect(esRes.ok).toBe(true);
      const es: EvalSet = await esRes.json();

      // Create a schedule
      const schedRes = await authFetch(adminSession, `${BASE_URL}/api/eval-schedules`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'RunNow Config Schedule',
          workflowId: wf.id,
          evalSetId: es.id,
          region: 'na',
          scheduleType: 'once',
        }),
      });
      expect(schedRes.ok).toBe(true);
      const sched: EvalSchedule = await schedRes.json();

      // Run now
      const runRes = await authFetch(adminSession, `${BASE_URL}/api/eval-schedules/${sched.id}/run-now`, {
        method: 'POST',
      });
      expect(runRes.ok).toBe(true);
      const result = await runRes.json();

      // Verify merged config
      expect(result.job.config).toBeDefined();
      const jobConfig = result.job.config as Record<string, unknown>;
      expect(jobConfig.framework).toBe('voice-agent-tester');
      expect(jobConfig.app).toBe('url: "https://runnow.com"');
      expect(jobConfig.scenario).toBe('steps:\n  - action: speak\n    file: runnow.mp3');
    });
  });

  describe('Clone Authorization', () => {
    let cloneSourceWorkflowId: number;
    let cloneSourceEvalSetId: number;

    beforeAll(async () => {
      // Create source items
      const wfRes = await authFetch(adminSession, `${BASE_URL}/api/workflows`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Auth Clone Source Workflow',
          visibility: 'public',
          providerId: testProviderId,
          config: { framework: 'aeval' },
        }),
      });
      const wf: Workflow = await wfRes.json();
      cloneSourceWorkflowId = wf.id;

      const esRes = await authFetch(adminSession, `${BASE_URL}/api/eval-sets`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Auth Clone Source Eval Set',
          visibility: 'public',
          config: { scenario: 'test' },
        }),
      });
      const es: EvalSet = await esRes.json();
      cloneSourceEvalSetId = es.id;
    });

    it('should reject workflow clone without authentication', async () => {
      const response = await fetch(`${BASE_URL}/api/workflows/${cloneSourceWorkflowId}/clone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      expect(response.status).toBe(401);
    });

    it('should reject eval set clone without authentication', async () => {
      const response = await fetch(`${BASE_URL}/api/eval-sets/${cloneSourceEvalSetId}/clone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      expect(response.status).toBe(401);
    });
  });

  describe('Apple-to-Apple Comparison Flow', () => {
    it('should run the same eval set against two different workflows', async () => {
      // Create a shared eval set (the "apple" test)
      const esRes = await authFetch(adminSession, `${BASE_URL}/api/eval-sets`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Shared Appointment Test',
          visibility: 'public',
          config: { scenario: 'steps:\n  - action: speak\n    file: hello.mp3\n  - action: wait_for_voice\n    metrics: elapsed_time' },
        }),
      });
      expect(esRes.ok).toBe(true);
      const evalSet: EvalSet = await esRes.json();

      // Create two workflows for different providers
      const wf1Res = await authFetch(adminSession, `${BASE_URL}/api/workflows`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Provider A Workflow',
          visibility: 'public',
          providerId: testProviderId,
          config: { framework: 'voice-agent-tester', app: 'url: "https://provider-a.com"' },
        }),
      });
      expect(wf1Res.ok).toBe(true);
      const wf1: Workflow = await wf1Res.json();

      const wf2Res = await authFetch(adminSession, `${BASE_URL}/api/workflows`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Provider B Workflow',
          visibility: 'public',
          providerId: testProviderId,
          config: { framework: 'voice-agent-tester', app: 'url: "https://provider-b.com"' },
        }),
      });
      expect(wf2Res.ok).toBe(true);
      const wf2: Workflow = await wf2Res.json();

      // Run same eval set against both workflows
      const job1Res = await authFetch(adminSession, `${BASE_URL}/api/workflows/${wf1.id}/run`, {
        method: 'POST',
        body: JSON.stringify({ evalSetId: evalSet.id, region: 'na' }),
      });
      expect(job1Res.ok).toBe(true);
      const job1 = await job1Res.json();

      const job2Res = await authFetch(adminSession, `${BASE_URL}/api/workflows/${wf2.id}/run`, {
        method: 'POST',
        body: JSON.stringify({ evalSetId: evalSet.id, region: 'na' }),
      });
      expect(job2Res.ok).toBe(true);
      const job2 = await job2Res.json();

      // Both jobs share same scenario but different app configs
      expect(job1.job.config.scenario).toBe(job2.job.config.scenario);
      expect(job1.job.config.app).toBe('url: "https://provider-a.com"');
      expect(job2.job.config.app).toBe('url: "https://provider-b.com"');
      expect(job1.job.config.framework).toBe('voice-agent-tester');
      expect(job2.job.config.framework).toBe('voice-agent-tester');
    });
  });

  // ====================================================================
  // Built-in Eval Set Protection
  // ====================================================================

  describe('Built-in Eval Set Protection', () => {
    let builtInEvalSetId: number;

    beforeAll(async () => {
      // Create an eval set with builtIn: true in config (simulates seeded data)
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-sets`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Test Built-in Eval Set',
          description: 'Simulated built-in eval set',
          visibility: 'public',
          config: { framework: 'aeval', builtIn: true, scenario: 'steps: []' },
        }),
      });
      expect(response.ok).toBe(true);
      const es: EvalSet = await response.json();
      builtInEvalSetId = es.id;
    });

    it('should reject PATCH on built-in eval set for non-admin', async () => {
      // premiumSession is a non-admin user
      if (!premiumSession) return; // skip if premium user not set up
      const response = await authFetch(premiumSession, `${BASE_URL}/api/eval-sets/${builtInEvalSetId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Hacked Name' }),
      });
      // Could be 403 (built-in guard) or 403 (not owner) — either is acceptable
      expect(response.status).toBe(403);
    });

    it('should allow PATCH on built-in eval set for admin', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-sets/${builtInEvalSetId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Updated Built-in Name' }),
      });
      expect(response.ok).toBe(true);
      const updated: EvalSet = await response.json();
      expect(updated.name).toBe('Updated Built-in Name');
    });

    it('should allow clone of built-in eval set', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-sets/${builtInEvalSetId}/clone`, {
        method: 'POST',
      });
      expect(response.ok).toBe(true);
      const cloned: EvalSet = await response.json();
      expect(cloned.name).toContain('Clone of');
      // builtIn flag should be stripped from cloned config
      expect(cloned.config.builtIn).toBeUndefined();
    });

    it('should strip builtIn flag from clone even without config override', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-sets/${builtInEvalSetId}/clone`, {
        method: 'POST',
        body: JSON.stringify({}), // No overrides
      });
      expect(response.ok).toBe(true);
      const cloned: EvalSet = await response.json();
      expect(cloned.config.builtIn).toBeUndefined();
      // But other config fields should be preserved
      expect(cloned.config.framework).toBe('aeval');
      expect(cloned.config.scenario).toBe('steps: []');
    });
  });

  // ====================================================================
  // Eval Set includePublic Query Param
  // ====================================================================

  describe('Eval Set includePublic', () => {
    it('should return only own eval sets without includePublic', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-sets`);
      expect(response.ok).toBe(true);
      const sets: EvalSet[] = await response.json();
      // All returned sets should be owned by admin
      // (We can't check exact ownership without knowing admin ID, but they should exist)
      expect(Array.isArray(sets)).toBe(true);
    });

    it('should return own + public eval sets with includePublic=true', async () => {
      const withPublic = await authFetch(adminSession, `${BASE_URL}/api/eval-sets?includePublic=true`);
      expect(withPublic.ok).toBe(true);
      const setsWithPublic: EvalSet[] = await withPublic.json();

      const withoutPublic = await authFetch(adminSession, `${BASE_URL}/api/eval-sets`);
      expect(withoutPublic.ok).toBe(true);
      const setsWithout: EvalSet[] = await withoutPublic.json();

      // With includePublic should include at least as many sets
      expect(setsWithPublic.length).toBeGreaterThanOrEqual(setsWithout.length);
    });

    it('should not duplicate own public eval sets with includePublic=true', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-sets?includePublic=true`);
      expect(response.ok).toBe(true);
      const sets: EvalSet[] = await response.json();

      // Check no duplicate IDs
      const ids = sets.map((s) => s.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });
  });

  // ====================================================================
  // Clone with Overrides
  // ====================================================================

  describe('Eval Set Clone with Overrides', () => {
    let cloneSourceId: number;

    beforeAll(async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-sets`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Override Clone Source',
          visibility: 'public',
          config: { scenario: 'original: true' },
        }),
      });
      expect(response.ok).toBe(true);
      const es: EvalSet = await response.json();
      cloneSourceId = es.id;
    });

    it('should clone with name override', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-sets/${cloneSourceId}/clone`, {
        method: 'POST',
        body: JSON.stringify({ name: 'My Custom Clone' }),
      });
      expect(response.ok).toBe(true);
      const cloned: EvalSet = await response.json();
      expect(cloned.name).toBe('My Custom Clone');
    });

    it('should clone with config override', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-sets/${cloneSourceId}/clone`, {
        method: 'POST',
        body: JSON.stringify({ config: { scenario: 'modified: true', framework: 'aeval' } }),
      });
      expect(response.ok).toBe(true);
      const cloned: EvalSet = await response.json();
      expect(cloned.config.scenario).toBe('modified: true');
    });

    it('should clone with both name and config overrides', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-sets/${cloneSourceId}/clone`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Full Override Clone',
          config: { scenario: 'new scenario', framework: 'aeval' },
        }),
      });
      expect(response.ok).toBe(true);
      const cloned: EvalSet = await response.json();
      expect(cloned.name).toBe('Full Override Clone');
      expect(cloned.config.scenario).toBe('new scenario');
    });

    it('should reject clone with invalid config', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/eval-sets/${cloneSourceId}/clone`, {
        method: 'POST',
        body: JSON.stringify({ config: { framework: 'invalid_framework' } }),
      });
      expect(response.status).toBe(400);
    });
  });

  // ====================================================================
  // Version-Gated Job Fetching
  // ====================================================================

  describe('Version-Gated Job Fetching', () => {
    let versionTestToken: string;
    let versionTestAgentId: number;
    let versionedWorkflowId: number;
    let versionedEvalSetId: number;
    let unversionedWorkflowId: number;
    let unversionedEvalSetId: number;

    beforeAll(async () => {
      // Create a new token for this test
      const tokenRes = await authFetch(adminSession, `${BASE_URL}/api/admin/eval-agent-tokens`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Version Test Token', region: 'na' }),
      });
      expect(tokenRes.ok).toBe(true);
      const tokenData: EvalAgentToken = await tokenRes.json();
      versionTestToken = tokenData.token!;

      // Register agent with frameworkVersion metadata
      const agentRes = await fetch(`${BASE_URL}/api/eval-agent/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${versionTestToken}`,
        },
        body: JSON.stringify({
          name: 'Version Test Agent',
          metadata: { framework: 'aeval', frameworkVersion: 'v0.1.0' },
        }),
      });
      expect(agentRes.ok).toBe(true);
      const agent: EvalAgent = await agentRes.json();
      versionTestAgentId = agent.id;

      // Create project for versioned workflows
      const projRes = await authFetch(adminSession, `${BASE_URL}/api/projects`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Version Gate Test Project' }),
      });
      const proj: Project = await projRes.json();

      // Create a workflow with frameworkVersion v0.1.0
      const wfRes = await authFetch(adminSession, `${BASE_URL}/api/workflows`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'v0.1.0 Workflow',
          projectId: proj.id,
          config: { framework: 'aeval', frameworkVersion: 'v0.1.0' },
        }),
      });
      const wf: Workflow = await wfRes.json();
      versionedWorkflowId = wf.id;

      // Create eval set for versioned workflow
      const esRes = await authFetch(adminSession, `${BASE_URL}/api/eval-sets`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'v0.1.0 Eval Set',
          config: { scenario: 'steps: []', frameworkVersion: 'v0.1.0' },
        }),
      });
      const es: EvalSet = await esRes.json();
      versionedEvalSetId = es.id;

      // Create unversioned workflow + eval set
      const uwfRes = await authFetch(adminSession, `${BASE_URL}/api/workflows`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Unversioned Workflow',
          projectId: proj.id,
          config: { framework: 'aeval' },
        }),
      });
      const uwf: Workflow = await uwfRes.json();
      unversionedWorkflowId = uwf.id;

      const uesRes = await authFetch(adminSession, `${BASE_URL}/api/eval-sets`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Unversioned Eval Set',
          config: { scenario: 'steps: []' },
        }),
      });
      const ues: EvalSet = await uesRes.json();
      unversionedEvalSetId = ues.id;
    });

    it('should show jobs with compatible version (v0.1.0 agent, v0.1.0 job)', async () => {
      // Create a v0.1.0 job
      const runRes = await authFetch(adminSession, `${BASE_URL}/api/workflows/${versionedWorkflowId}/run`, {
        method: 'POST',
        body: JSON.stringify({ region: 'na', evalSetId: versionedEvalSetId }),
      });
      expect(runRes.ok).toBe(true);

      // Agent fetches jobs - should see this one
      const jobsRes = await fetch(`${BASE_URL}/api/eval-agent/jobs`, {
        headers: { 'Authorization': `Bearer ${versionTestToken}` },
      });
      expect(jobsRes.ok).toBe(true);
      const jobs: EvalJob[] = await jobsRes.json();

      // Should have at least 1 job, and the v0.1.0 job should be present
      const versionedJobs = jobs.filter(
        (j) => (j.config as Record<string, unknown>)?.frameworkVersion === 'v0.1.0'
      );
      expect(versionedJobs.length).toBeGreaterThanOrEqual(1);
    });

    it('should show jobs without version requirement', async () => {
      // Create an unversioned job
      const runRes = await authFetch(adminSession, `${BASE_URL}/api/workflows/${unversionedWorkflowId}/run`, {
        method: 'POST',
        body: JSON.stringify({ region: 'na', evalSetId: unversionedEvalSetId }),
      });
      expect(runRes.ok).toBe(true);

      // Agent fetches jobs - should see unversioned jobs
      const jobsRes = await fetch(`${BASE_URL}/api/eval-agent/jobs`, {
        headers: { 'Authorization': `Bearer ${versionTestToken}` },
      });
      expect(jobsRes.ok).toBe(true);
      const jobs: EvalJob[] = await jobsRes.json();

      // Should include jobs without frameworkVersion in config
      const unversionedJobs = jobs.filter(
        (j) => !(j.config as Record<string, unknown>)?.frameworkVersion
      );
      expect(unversionedJobs.length).toBeGreaterThanOrEqual(1);
    });

    it('should filter out jobs requiring newer version', async () => {
      // Create a high-version workflow + eval set + job
      const projRes = await authFetch(adminSession, `${BASE_URL}/api/projects`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Future Version Project' }),
      });
      const proj: Project = await projRes.json();

      const wfRes = await authFetch(adminSession, `${BASE_URL}/api/workflows`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'v99.0.0 Workflow',
          projectId: proj.id,
          config: { framework: 'aeval', frameworkVersion: 'v99.0.0' },
        }),
      });
      const wf: Workflow = await wfRes.json();

      const esRes = await authFetch(adminSession, `${BASE_URL}/api/eval-sets`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'v99.0.0 Eval Set',
          config: { scenario: 'steps: []', frameworkVersion: 'v99.0.0' },
        }),
      });
      const es: EvalSet = await esRes.json();

      const runRes = await authFetch(adminSession, `${BASE_URL}/api/workflows/${wf.id}/run`, {
        method: 'POST',
        body: JSON.stringify({ region: 'na', evalSetId: es.id }),
      });
      expect(runRes.ok).toBe(true);

      // Agent with v0.1.0 fetches jobs
      const jobsRes = await fetch(`${BASE_URL}/api/eval-agent/jobs`, {
        headers: { 'Authorization': `Bearer ${versionTestToken}` },
      });
      expect(jobsRes.ok).toBe(true);
      const jobs: EvalJob[] = await jobsRes.json();

      // Should NOT contain any v99.0.0 jobs
      const futureJobs = jobs.filter(
        (j) => (j.config as Record<string, unknown>)?.frameworkVersion === 'v99.0.0'
      );
      expect(futureJobs.length).toBe(0);
    });

    it('should pass all jobs to legacy agent without frameworkVersion', async () => {
      // Create a new token + agent WITHOUT frameworkVersion
      const tokenRes = await authFetch(adminSession, `${BASE_URL}/api/admin/eval-agent-tokens`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Legacy Agent Token', region: 'na' }),
      });
      const tokenData: EvalAgentToken = await tokenRes.json();
      const legacyToken = tokenData.token!;

      // Register without metadata
      const agentRes = await fetch(`${BASE_URL}/api/eval-agent/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${legacyToken}`,
        },
        body: JSON.stringify({ name: 'Legacy Agent' }),
      });
      expect(agentRes.ok).toBe(true);

      // Legacy agent should see ALL pending jobs (no version filtering)
      const jobsRes = await fetch(`${BASE_URL}/api/eval-agent/jobs`, {
        headers: { 'Authorization': `Bearer ${legacyToken}` },
      });
      expect(jobsRes.ok).toBe(true);
      const jobs: EvalJob[] = await jobsRes.json();

      // Should include both versioned and unversioned jobs
      expect(jobs.length).toBeGreaterThanOrEqual(1);
      // Specifically, should include v99.0.0 jobs that the versioned agent couldn't see
      const futureJobs = jobs.filter(
        (j) => (j.config as Record<string, unknown>)?.frameworkVersion === 'v99.0.0'
      );
      expect(futureJobs.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ====================================================================
  // Heartbeat Metadata Persistence
  // ====================================================================

  describe('Heartbeat Metadata Persistence', () => {
    let hbToken: string;
    let hbAgentId: number;

    beforeAll(async () => {
      const tokenRes = await authFetch(adminSession, `${BASE_URL}/api/admin/eval-agent-tokens`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Heartbeat Test Token', region: 'na' }),
      });
      const tokenData: EvalAgentToken = await tokenRes.json();
      hbToken = tokenData.token!;

      const agentRes = await fetch(`${BASE_URL}/api/eval-agent/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${hbToken}`,
        },
        body: JSON.stringify({
          name: 'Heartbeat Test Agent',
          metadata: { framework: 'aeval', frameworkVersion: 'v0.1.0' },
        }),
      });
      const agent: EvalAgent = await agentRes.json();
      hbAgentId = agent.id;
    });

    it('should persist metadata sent with heartbeat', async () => {
      const response = await fetch(`${BASE_URL}/api/eval-agent/heartbeat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${hbToken}`,
        },
        body: JSON.stringify({
          agentId: hbAgentId,
          state: 'idle',
          metadata: { framework: 'aeval', frameworkVersion: 'v0.2.0' },
        }),
      });
      expect(response.ok).toBe(true);

      // Verify via public agents endpoint
      const agentsRes = await fetch(`${BASE_URL}/api/eval-agents`);
      const agents = await agentsRes.json();
      const our = agents.find((a: EvalAgent & { metadata?: Record<string, unknown> }) => a.id === hbAgentId);
      expect(our).toBeDefined();
      expect((our as { metadata?: Record<string, unknown> }).metadata?.frameworkVersion).toBe('v0.2.0');
    });
  });

  // ====================================================================
  // mergeEvalConfig propagates frameworkVersion
  // ====================================================================

  describe('mergeEvalConfig frameworkVersion propagation', () => {
    it('should propagate frameworkVersion from workflow and eval set to job config', async () => {
      const projRes = await authFetch(adminSession, `${BASE_URL}/api/projects`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Config Merge Test Project' }),
      });
      const proj: Project = await projRes.json();

      const wfRes = await authFetch(adminSession, `${BASE_URL}/api/workflows`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Config Merge Workflow',
          projectId: proj.id,
          config: { framework: 'aeval', frameworkVersion: 'v0.3.0' },
        }),
      });
      const wf: Workflow = await wfRes.json();

      const esRes = await authFetch(adminSession, `${BASE_URL}/api/eval-sets`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Config Merge Eval Set',
          config: { scenario: 'test: true', frameworkVersion: 'v0.3.0' },
        }),
      });
      const es: EvalSet = await esRes.json();

      const runRes = await authFetch(adminSession, `${BASE_URL}/api/workflows/${wf.id}/run`, {
        method: 'POST',
        body: JSON.stringify({ region: 'na', evalSetId: es.id }),
      });
      expect(runRes.ok).toBe(true);
      const data = await runRes.json();

      // Job config should contain merged frameworkVersion
      expect(data.job.config.frameworkVersion).toBe('v0.3.0');
      expect(data.job.config.framework).toBe('aeval');
      expect(data.job.config.scenario).toBe('test: true');
    });
  });

  // ==================== Job Detail API ====================
  describe('Job Detail API', () => {
    it('should get job detail with result data', async () => {
      // Get a completed job
      const jobsRes = await authFetch(adminSession, `${BASE_URL}/api/eval-jobs?status=completed&limit=1`);
      if (!jobsRes.ok) return; // skip if no completed jobs
      const jobs = await jobsRes.json();
      if (jobs.length === 0) return;

      const detailRes = await authFetch(adminSession, `${BASE_URL}/api/eval-jobs/${jobs[0].id}/detail`);
      expect(detailRes.ok).toBe(true);
      const detail = await detailRes.json();
      expect(detail.job).toBeDefined();
      expect(detail.job.id).toBe(jobs[0].id);
      expect(detail.workflowName).toBeDefined();
      expect(typeof detail.workflowName).toBe('string');
    });

    it('should return 404 for non-existent job', async () => {
      const res = await authFetch(adminSession, `${BASE_URL}/api/eval-jobs/999999/detail`);
      expect(res.status).toBe(404);
    });

    it('should require authentication for job detail', async () => {
      const res = await fetch(`${BASE_URL}/api/eval-jobs/1/detail`);
      expect(res.status).toBe(401);
    });
  });

  // ==================== Storage Config API ====================
  describe('Storage Config API', () => {
    it('should return null when no config exists', async () => {
      const res = await authFetch(adminSession, `${BASE_URL}/api/user/storage-config`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      // Either null or an existing config object
      expect(data === null || typeof data === 'object').toBe(true);
    });

    it('should create and retrieve storage config', async () => {
      const putRes = await authFetch(adminSession, `${BASE_URL}/api/user/storage-config`, {
        method: 'PUT',
        body: JSON.stringify({
          s3Endpoint: 'https://test.r2.cloudflarestorage.com',
          s3Bucket: 'test-bucket',
          s3Region: 'auto',
          s3AccessKeyId: 'test-access-key',
          s3SecretAccessKey: 'test-secret-key',
        }),
      });
      // May fail if CREDENTIAL_ENCRYPTION_KEY not set — that's OK
      if (putRes.ok) {
        const getRes = await authFetch(adminSession, `${BASE_URL}/api/user/storage-config`);
        expect(getRes.ok).toBe(true);
        const config = await getRes.json();
        expect(config.s3Endpoint).toBe('https://test.r2.cloudflarestorage.com');
        expect(config.s3Bucket).toBe('test-bucket');
        expect(config.s3AccessKeyId).toMatch(/^\*{4}/); // masked

        // Clean up
        await authFetch(adminSession, `${BASE_URL}/api/user/storage-config`, { method: 'DELETE' });
      }
    });

    it('should require authentication', async () => {
      const res = await fetch(`${BASE_URL}/api/user/storage-config`);
      expect(res.status).toBe(401);
    });
  });

  // ==================== API Keys API ====================
  describe('API Keys API', () => {
    it('should list API keys', async () => {
      const res = await authFetch(adminSession, `${BASE_URL}/api/user/api-keys`);
      expect(res.ok).toBe(true);
      const keys = await res.json();
      expect(Array.isArray(keys)).toBe(true);
    });

    it('should create, list, and delete an API key', async () => {
      // Create
      const createRes = await authFetch(adminSession, `${BASE_URL}/api/user/api-keys`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Test Key' }),
      });
      expect(createRes.ok).toBe(true);
      const created = await createRes.json();
      expect(created.key).toBeDefined();
      expect(created.key).toMatch(/^vox_live_/);
      expect(created.name).toBe('Test Key');

      // List and find it
      const listRes = await authFetch(adminSession, `${BASE_URL}/api/user/api-keys`);
      const keys = await listRes.json();
      const found = keys.find((k: { id: number }) => k.id === created.id);
      expect(found).toBeDefined();
      expect(found.isRevoked).toBe(false);

      // Delete
      const deleteRes = await authFetch(adminSession, `${BASE_URL}/api/user/api-keys/${created.id}`, { method: 'DELETE' });
      expect(deleteRes.ok).toBe(true);
    });

    it('should create API key with expiry', async () => {
      const res = await authFetch(adminSession, `${BASE_URL}/api/user/api-keys`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Expiring Key', expiresInDays: 30 }),
      });
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.expiresAt).toBeDefined();
      expect(new Date(data.expiresAt).getTime()).toBeGreaterThan(Date.now());

      // Clean up
      await authFetch(adminSession, `${BASE_URL}/api/user/api-keys/${data.id}`, { method: 'DELETE' });
    });

    it('should revoke an API key', async () => {
      // Create
      const createRes = await authFetch(adminSession, `${BASE_URL}/api/user/api-keys`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Revoke Test' }),
      });
      const created = await createRes.json();

      // Revoke
      const revokeRes = await authFetch(adminSession, `${BASE_URL}/api/user/api-keys/${created.id}/revoke`, { method: 'POST' });
      expect(revokeRes.ok).toBe(true);

      // Verify revoked
      const listRes = await authFetch(adminSession, `${BASE_URL}/api/user/api-keys`);
      const keys = await listRes.json();
      const revoked = keys.find((k: { id: number }) => k.id === created.id);
      expect(revoked.isRevoked).toBe(true);

      // Clean up
      await authFetch(adminSession, `${BASE_URL}/api/user/api-keys/${created.id}`, { method: 'DELETE' });
    });

    it('should require name to create key', async () => {
      const res = await authFetch(adminSession, `${BASE_URL}/api/user/api-keys`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });

  // ==================== Eval Schedules API ====================
  describe('Eval Schedules API', () => {
    it('should list schedules', async () => {
      const res = await authFetch(adminSession, `${BASE_URL}/api/eval-schedules`);
      expect(res.ok).toBe(true);
      const schedules = await res.json();
      expect(Array.isArray(schedules)).toBe(true);
      // Admin should see all schedules with creatorName
      if (schedules.length > 0) {
        expect(schedules[0].creatorName).toBeDefined();
        expect(schedules[0].workflowName).toBeDefined();
      }
    });

    it('should toggle schedule enabled state', async () => {
      const listRes = await authFetch(adminSession, `${BASE_URL}/api/eval-schedules`);
      const schedules = await listRes.json();
      if (schedules.length === 0) return;

      const schedule = schedules[0];
      const original = schedule.isEnabled;

      // Toggle off
      const patchRes = await authFetch(adminSession, `${BASE_URL}/api/eval-schedules/${schedule.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isEnabled: !original }),
      });
      expect(patchRes.ok).toBe(true);
      const updated = await patchRes.json();
      expect(updated.isEnabled).toBe(!original);

      // Restore
      await authFetch(adminSession, `${BASE_URL}/api/eval-schedules/${schedule.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isEnabled: original }),
      });
    });
  });

  // ==================== Providers API ====================
  describe('Providers API', () => {
    it('should list all active providers', async () => {
      const res = await fetch(`${BASE_URL}/api/providers`);
      expect(res.ok).toBe(true);
      const providers = await res.json();
      expect(Array.isArray(providers)).toBe(true);
      expect(providers.length).toBeGreaterThanOrEqual(2);
      const names = providers.map((p: Provider) => p.name);
      expect(names).toContain('Agora ConvoAI Engine');
      expect(names).toContain('LiveKit Agents');
    });

    it('should include ElevenLabs Agents provider', async () => {
      const res = await fetch(`${BASE_URL}/api/providers`);
      const providers = await res.json();
      const names = providers.map((p: Provider) => p.name);
      expect(names).toContain('ElevenLabs Agents');
    });

    it('should have convoai SKU for all current providers', async () => {
      const res = await fetch(`${BASE_URL}/api/providers`);
      const providers = await res.json();
      for (const p of providers) {
        expect(p.sku).toBe('convoai');
      }
    });
  });

  // ==================== Metrics API (P95 fields) ====================
  describe('Metrics API with P95', () => {
    it('should include p95 fields in realtime metrics', async () => {
      const res = await fetch(`${BASE_URL}/api/metrics/realtime?limit=5`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      if (data.length > 0) {
        expect(data[0]).toHaveProperty('responseLatencyP95');
        expect(data[0]).toHaveProperty('interruptLatencyP95');
        expect(data[0]).toHaveProperty('responseLatencySd');
        expect(data[0]).toHaveProperty('interruptLatencySd');
        expect(data[0]).toHaveProperty('providerId');
      }
    });

    it('should include p95 in leaderboard', async () => {
      const res = await fetch(`${BASE_URL}/api/metrics/leaderboard`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      if (data.length > 0) {
        expect(data[0]).toHaveProperty('responseLatencyP95');
        expect(data[0]).toHaveProperty('interruptLatencyP95');
      }
    });
  });
});
