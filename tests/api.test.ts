import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const BASE_URL = 'http://localhost:5000';

interface AuthSession {
  cookie: string;
}

interface Workflow {
  id: number;
  name: string;
  description: string | null;
  userId: string;
  visibility: string;
  isMainline: boolean;
}

interface Vendor {
  id: number;
  workflowId: number;
  name: string;
  type: string;
  config: Record<string, unknown>;
}

interface TestCase {
  id: number;
  workflowId: number;
  vendorId: number;
  name: string;
  region: string;
  isEnabled: boolean;
}

interface WorkerToken {
  id: number;
  region: string;
  token?: string;
  isRevoked: boolean;
}

interface Worker {
  id: number;
  region: string;
  status: string;
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
  let testVendorId: number;
  let testCaseId: number;
  let testWorkerTokenId: number;
  let testWorkerToken: string;

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
  });

  describe('Workflow API', () => {
    it('should create a new workflow', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/workflows`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Test Workflow',
          description: 'A test workflow for API testing',
          visibility: 'public',
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
      const text = await response.text();
      if (text) {
        const workflow: Workflow = JSON.parse(text);
        expect(workflow.name).toBe('Updated Test Workflow');
      }
    });
  });

  describe('Vendor API', () => {
    it('should create a vendor for a workflow', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/workflows/${testWorkflowId}/vendors`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Test LiveKit Agent',
          type: 'livekit_agent',
          config: {
            apiKey: 'test-api-key',
            apiSecret: 'test-api-secret',
          },
        }),
      });
      
      expect(response.ok).toBe(true);
      const vendor: Vendor = await response.json();
      expect(vendor.name).toBe('Test LiveKit Agent');
      expect(vendor.type).toBe('livekit_agent');
      expect(vendor.workflowId).toBe(testWorkflowId);
      testVendorId = vendor.id;
    });

    it('should get vendors for a workflow', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/workflows/${testWorkflowId}/vendors`);
      expect(response.ok).toBe(true);
      
      const vendors: Vendor[] = await response.json();
      expect(Array.isArray(vendors)).toBe(true);
      expect(vendors.length).toBeGreaterThan(0);
      expect(vendors[0].workflowId).toBe(testWorkflowId);
    });

    it('should update a vendor', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/vendors/${testVendorId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: 'Updated LiveKit Agent',
        }),
      });
      
      expect(response.ok).toBe(true);
      const vendor: Vendor = await response.json();
      expect(vendor.name).toBe('Updated LiveKit Agent');
    });
  });

  describe('Test Case API', () => {
    it('should create a test case for a workflow', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/workflows/${testWorkflowId}/test-cases`, {
        method: 'POST',
        body: JSON.stringify({
          vendorId: testVendorId,
          name: 'NA Latency Test',
          region: 'na',
          config: {
            duration: 60,
            iterations: 10,
          },
        }),
      });
      
      expect(response.ok).toBe(true);
      const testCase: TestCase = await response.json();
      expect(testCase.name).toBe('NA Latency Test');
      expect(testCase.region).toBe('na');
      expect(testCase.workflowId).toBe(testWorkflowId);
      expect(testCase.vendorId).toBe(testVendorId);
      testCaseId = testCase.id;
    });

    it('should get test cases for a workflow', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/workflows/${testWorkflowId}/test-cases`);
      expect(response.ok).toBe(true);
      
      const testCases: TestCase[] = await response.json();
      expect(Array.isArray(testCases)).toBe(true);
      expect(testCases.length).toBeGreaterThan(0);
    });

    it('should update a test case', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/test-cases/${testCaseId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: 'Updated NA Latency Test',
          isEnabled: false,
        }),
      });
      
      expect(response.ok).toBe(true);
      const testCase: TestCase = await response.json();
      expect(testCase.name).toBe('Updated NA Latency Test');
      expect(testCase.isEnabled).toBe(false);
    });

    it('should re-enable a test case', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/test-cases/${testCaseId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          isEnabled: true,
        }),
      });
      
      expect(response.ok).toBe(true);
      const testCase: TestCase = await response.json();
      expect(testCase.isEnabled).toBe(true);
    });
  });

  describe('Worker Token API (Admin Only)', () => {
    it('should create a worker token', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/admin/worker-tokens`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Test Worker Token NA',
          region: 'na',
        }),
      });
      
      expect(response.ok).toBe(true);
      const workerToken: WorkerToken = await response.json();
      expect(workerToken.region).toBe('na');
      expect(workerToken.token).toBeDefined();
      expect(workerToken.token!.length).toBeGreaterThan(20);
      testWorkerTokenId = workerToken.id;
      testWorkerToken = workerToken.token!;
    });

    it('should get all worker tokens', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/admin/worker-tokens`);
      expect(response.ok).toBe(true);
      
      const tokens: WorkerToken[] = await response.json();
      expect(Array.isArray(tokens)).toBe(true);
      expect(tokens.length).toBeGreaterThan(0);
    });
  });

  describe('Worker Registration API', () => {
    let workerId: number;

    it('should register a worker with valid token', async () => {
      const response = await fetch(`${BASE_URL}/api/worker/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${testWorkerToken}`,
        },
        body: JSON.stringify({
          name: 'Test Worker NA-1',
        }),
      });
      
      expect(response.ok).toBe(true);
      const worker: Worker = await response.json();
      expect(worker.region).toBe('na');
      expect(worker.status).toBe('online');
      workerId = worker.id;
    });

    it('should reject registration with invalid token', async () => {
      const response = await fetch(`${BASE_URL}/api/worker/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer invalid-token',
        },
        body: JSON.stringify({
          name: 'Invalid Worker',
        }),
      });
      
      expect(response.status).toBe(401);
    });

    it('should get all workers (authenticated)', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/workers`);
      expect(response.ok).toBe(true);
      
      const workers: Worker[] = await response.json();
      expect(Array.isArray(workers)).toBe(true);
      expect(workers.length).toBeGreaterThan(0);
    });

    it('should send worker heartbeat', async () => {
      const response = await fetch(`${BASE_URL}/api/worker/heartbeat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${testWorkerToken}`,
        },
        body: JSON.stringify({
          workerId,
          status: 'online',
        }),
      });
      
      expect(response.ok).toBe(true);
    });
  });

  describe('Job API', () => {
    it('should run a workflow and create jobs', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/workflows/${testWorkflowId}/run`, {
        method: 'POST',
      });
      
      expect(response.ok).toBe(true);
      const result = await response.json();
      expect(result.jobs).toBeDefined();
      expect(result.jobs.length).toBeGreaterThan(0);
    });

    it('should get pending jobs for a region', async () => {
      const response = await fetch(`${BASE_URL}/api/worker/jobs?region=na`, {
        headers: {
          'Authorization': `Bearer ${testWorkerToken}`,
        },
      });
      
      expect(response.ok).toBe(true);
      const jobs = await response.json();
      expect(Array.isArray(jobs)).toBe(true);
    });
  });

  describe('Cleanup', () => {
    it('should delete a test case', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/test-cases/${testCaseId}`, {
        method: 'DELETE',
      });
      
      expect(response.ok).toBe(true);
    });

    it('should delete a vendor', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/vendors/${testVendorId}`, {
        method: 'DELETE',
      });
      
      expect(response.ok).toBe(true);
    });

    it('should revoke a worker token', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/admin/worker-tokens/${testWorkerTokenId}/revoke`, {
        method: 'POST',
      });
      
      expect(response.ok).toBe(true);
    });
  });
});
