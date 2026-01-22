import { describe, it, expect, beforeAll } from 'vitest';

const BASE_URL = 'http://localhost:5000';

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

  beforeAll(async () => {
    adminSession = await login('brent@agora.io', '1234567890');
  });

  describe('Auth API', () => {
    it('should return auth status for logged in user', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/auth/status`);
      expect(response.ok).toBe(true);

      const data = await response.json();
      expect(data.initialized).toBe(true);
      expect(data.user).toBeDefined();
      expect(data.user.email).toBe('brent@agora.io');
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
      const data = await response.json();
      expect(data.email).toBe('brent@agora.io');
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
      const workflows: Workflow[] = await response.json();
      expect(Array.isArray(workflows)).toBe(true);
    });

    it('should get eval sets via API v1', async () => {
      const response = await fetch(`${BASE_URL}/api/v1/eval-sets`, {
        headers: {
          'Authorization': `Bearer ${testApiKey}`,
        },
      });

      expect(response.ok).toBe(true);
      const evalSets: EvalSet[] = await response.json();
      expect(Array.isArray(evalSets)).toBe(true);
    });

    it('should get jobs via API v1', async () => {
      const response = await fetch(`${BASE_URL}/api/v1/jobs`, {
        headers: {
          'Authorization': `Bearer ${testApiKey}`,
        },
      });

      expect(response.ok).toBe(true);
      const jobs: EvalJob[] = await response.json();
      expect(Array.isArray(jobs)).toBe(true);
    });

    it('should get results via API v1', async () => {
      const response = await fetch(`${BASE_URL}/api/v1/results`, {
        headers: {
          'Authorization': `Bearer ${testApiKey}`,
        },
      });

      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(Array.isArray(data)).toBe(true);
    });

    it('should get projects via API v1', async () => {
      const response = await fetch(`${BASE_URL}/api/v1/projects`, {
        headers: {
          'Authorization': `Bearer ${testApiKey}`,
        },
      });

      expect(response.ok).toBe(true);
      const projects: Project[] = await response.json();
      expect(Array.isArray(projects)).toBe(true);
    });

    it('should get realtime metrics (public)', async () => {
      const response = await fetch(`${BASE_URL}/api/v1/metrics/realtime`);
      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(data.results).toBeDefined();
      expect(data.timestamp).toBeDefined();
    });

    it('should get leaderboard (public)', async () => {
      const response = await fetch(`${BASE_URL}/api/v1/metrics/leaderboard`);
      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(data.providers).toBeDefined();
      expect(data.timestamp).toBeDefined();
    });

    it('should get providers via API v1 (public)', async () => {
      const response = await fetch(`${BASE_URL}/api/v1/providers`);
      expect(response.ok).toBe(true);
      const providers: Provider[] = await response.json();
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
