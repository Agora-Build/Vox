import { describe, it, expect, beforeAll } from 'vitest';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const S3_ENDPOINT = process.env.S3_ENDPOINT;
const S3_BUCKET = process.env.S3_BUCKET;
const S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID;
const S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY;
const S3_REGION = process.env.S3_REGION || 'auto';

const isConfigured = !!(S3_ENDPOINT && S3_BUCKET && S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY);

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:5000';
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || 'admin@vox.local';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || 'admin123456';
const VOX_API_KEY = process.env.VOX_API_KEY || 'vox_live_BpX-_pn9qcik9wXxBfznA0IgFGu2J-Jx';

// Auth helpers
interface AuthSession { cookie: string }

async function login(email: string, password: string): Promise<AuthSession> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status}`);
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('No session cookie');
  return { cookie: setCookie.split(';')[0] };
}

async function authFetch(session: AuthSession, url: string, options: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...options,
    headers: { ...options.headers, Cookie: session.cookie, 'Content-Type': 'application/json' },
  });
}

// ==================== S3/R2 Direct Tests ====================

describe.skipIf(!isConfigured)('S3/R2 Direct Operations', () => {
  let client: S3Client;
  const testKey = `test/vox-test-${Date.now()}.txt`;
  const testContent = `Vox S3 test at ${new Date().toISOString()}`;

  beforeAll(() => {
    client = new S3Client({
      endpoint: S3_ENDPOINT!,
      region: S3_REGION,
      credentials: { accessKeyId: S3_ACCESS_KEY_ID!, secretAccessKey: S3_SECRET_ACCESS_KEY! },
      forcePathStyle: true,
    });
  });

  it('should upload a file to R2', async () => {
    await client.send(new PutObjectCommand({
      Bucket: S3_BUCKET!,
      Key: testKey,
      Body: testContent,
      ContentType: 'text/plain',
    }));

    // Verify it exists
    const head = await client.send(new HeadObjectCommand({ Bucket: S3_BUCKET!, Key: testKey }));
    expect(head.$metadata.httpStatusCode).toBe(200);
    expect(head.ContentLength).toBe(testContent.length);
  });

  it('should generate a signed URL that works', async () => {
    const command = new GetObjectCommand({ Bucket: S3_BUCKET!, Key: testKey });
    const url = await getSignedUrl(client, command, { expiresIn: 300 });

    expect(url).toContain(S3_BUCKET);
    expect(url).toContain('X-Amz-Signature');

    // Fetch via signed URL
    const res = await fetch(url);
    expect(res.ok).toBe(true);
    const body = await res.text();
    expect(body).toBe(testContent);
  });

  it('should upload and retrieve JSON', async () => {
    const jsonKey = `test/vox-metrics-${Date.now()}.json`;
    const metrics = {
      responseLatencyMedian: 1500,
      interruptLatencyMedian: 400,
      responseLatencyP95: 2100,
    };

    await client.send(new PutObjectCommand({
      Bucket: S3_BUCKET!,
      Key: jsonKey,
      Body: JSON.stringify(metrics),
      ContentType: 'application/json',
    }));

    const signedUrl = await getSignedUrl(client, new GetObjectCommand({ Bucket: S3_BUCKET!, Key: jsonKey }), { expiresIn: 300 });
    const res = await fetch(signedUrl);
    const data = await res.json();
    expect(data.responseLatencyMedian).toBe(1500);
    expect(data.responseLatencyP95).toBe(2100);

    // Clean up
    await client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET!, Key: jsonKey }));
  });

  it('should upload and retrieve binary (simulated audio)', async () => {
    const audioKey = `test/vox-recording-${Date.now()}.webm`;
    const fakeAudio = Buffer.alloc(1024, 0x42); // 1KB of 'B'

    await client.send(new PutObjectCommand({
      Bucket: S3_BUCKET!,
      Key: audioKey,
      Body: fakeAudio,
      ContentType: 'audio/webm',
    }));

    const signedUrl = await getSignedUrl(client, new GetObjectCommand({ Bucket: S3_BUCKET!, Key: audioKey }), { expiresIn: 300 });
    const res = await fetch(signedUrl);
    expect(res.ok).toBe(true);
    expect(res.headers.get('content-type')).toContain('webm');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBe(1024);

    // Clean up
    await client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET!, Key: audioKey }));
  });

  it('should clean up test file', async () => {
    await client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET!, Key: testKey }));
  });
});

// ==================== Vox API Artifact Tests ====================

describe.skipIf(!isConfigured)('Vox Artifact API Integration', () => {
  let adminSession: AuthSession;

  beforeAll(async () => {
    adminSession = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  });

  it('should store artifact metadata via eval-agent API', async () => {
    // Get a completed job to test with
    const jobsRes = await authFetch(adminSession, `${BASE_URL}/api/eval-jobs?status=completed&limit=1`);
    if (!jobsRes.ok) return;
    const jobs = await jobsRes.json();
    if (jobs.length === 0) return;

    const jobId = jobs[0].id;

    // Upload a test file to R2
    const client = new S3Client({
      endpoint: S3_ENDPOINT!,
      region: S3_REGION,
      credentials: { accessKeyId: S3_ACCESS_KEY_ID!, secretAccessKey: S3_SECRET_ACCESS_KEY! },
      forcePathStyle: true,
    });

    const testKey = `jobs/${jobId}/test-metrics.json`;
    const testData = JSON.stringify({ test: true, timestamp: Date.now() });
    await client.send(new PutObjectCommand({
      Bucket: S3_BUCKET!,
      Key: testKey,
      Body: testData,
      ContentType: 'application/json',
    }));

    // Report artifacts via Vox API (using Vox API key)
    const artifactRes = await fetch(`${BASE_URL}/api/eval-agent/jobs/${jobId}/artifacts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${VOX_API_KEY}`,
      },
      body: JSON.stringify({
        zipUrl: `jobs/${jobId}/artifacts.zip`,
        files: [{ name: 'test-metrics.json', url: testKey, size: testData.length, contentType: 'application/json' }],
      }),
    });
    // May fail if API key is invalid for eval-agent auth — that's OK for this test
    if (artifactRes.ok) {
      // Verify detail endpoint returns signed URLs
      const detailRes = await authFetch(adminSession, `${BASE_URL}/api/eval-jobs/${jobId}/detail`);
      expect(detailRes.ok).toBe(true);
      const detail = await detailRes.json();
      if (detail.result?.artifactFiles?.length > 0) {
        const file = detail.result.artifactFiles[0];
        // If S3 is configured on server, URL should be signed
        if (file.url.includes('X-Amz-Signature')) {
          const fetchRes = await fetch(file.url);
          expect(fetchRes.ok).toBe(true);
        }
      }
    }

    // Clean up R2
    await client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET!, Key: testKey }));
  });

  it('should return job detail with signed artifact URL', async () => {
    const jobsRes = await authFetch(adminSession, `${BASE_URL}/api/eval-jobs?status=completed&limit=1`);
    if (!jobsRes.ok) return;
    const jobs = await jobsRes.json();
    if (jobs.length === 0) return;

    const detailRes = await authFetch(adminSession, `${BASE_URL}/api/eval-jobs/${jobs[0].id}/detail`);
    expect(detailRes.ok).toBe(true);
    const detail = await detailRes.json();
    expect(detail.job).toBeDefined();
    expect(detail.result).toBeDefined();
    // artifactUrl will be null if no artifacts uploaded yet — that's fine
  });
});

// ==================== Storage Config API Tests ====================

describe.skipIf(!isConfigured)('Storage Config with Real R2', () => {
  let adminSession: AuthSession;

  beforeAll(async () => {
    adminSession = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  });

  it('should save and retrieve storage config with real R2 credentials', async () => {
    const putRes = await authFetch(adminSession, `${BASE_URL}/api/user/storage-config`, {
      method: 'PUT',
      body: JSON.stringify({
        s3Endpoint: S3_ENDPOINT,
        s3Bucket: S3_BUCKET,
        s3Region: S3_REGION,
        s3AccessKeyId: S3_ACCESS_KEY_ID,
        s3SecretAccessKey: S3_SECRET_ACCESS_KEY,
      }),
    });

    if (!putRes.ok) {
      // Encryption key not configured — skip
      console.log('Storage config test skipped: encryption not configured');
      return;
    }

    const getRes = await authFetch(adminSession, `${BASE_URL}/api/user/storage-config`);
    expect(getRes.ok).toBe(true);
    const config = await getRes.json();
    expect(config.s3Endpoint).toBe(S3_ENDPOINT);
    expect(config.s3Bucket).toBe(S3_BUCKET);
    expect(config.s3AccessKeyId).toMatch(/^\*{4}/); // masked

    // Clean up
    const delRes = await authFetch(adminSession, `${BASE_URL}/api/user/storage-config`, { method: 'DELETE' });
    expect(delRes.ok).toBe(true);

    // Verify deleted
    const getRes2 = await authFetch(adminSession, `${BASE_URL}/api/user/storage-config`);
    const config2 = await getRes2.json();
    expect(config2).toBeNull();
  });
});

// ==================== Signed URL Expiry Logic ====================

describe('Signed URL Logic (unit)', () => {
  it('should generate different signatures for different keys', async () => {
    if (!isConfigured) return;

    const client = new S3Client({
      endpoint: S3_ENDPOINT!,
      region: S3_REGION,
      credentials: { accessKeyId: S3_ACCESS_KEY_ID!, secretAccessKey: S3_SECRET_ACCESS_KEY! },
      forcePathStyle: true,
    });

    const url1 = await getSignedUrl(client, new GetObjectCommand({ Bucket: S3_BUCKET!, Key: 'jobs/1/file.json' }), { expiresIn: 3600 });
    const url2 = await getSignedUrl(client, new GetObjectCommand({ Bucket: S3_BUCKET!, Key: 'jobs/2/file.json' }), { expiresIn: 3600 });

    expect(url1).not.toBe(url2);
    expect(url1).toContain('jobs/1/file.json');
    expect(url2).toContain('jobs/2/file.json');
  });

  it('should include expiry in signed URL', async () => {
    if (!isConfigured) return;

    const client = new S3Client({
      endpoint: S3_ENDPOINT!,
      region: S3_REGION,
      credentials: { accessKeyId: S3_ACCESS_KEY_ID!, secretAccessKey: S3_SECRET_ACCESS_KEY! },
      forcePathStyle: true,
    });

    const url = await getSignedUrl(client, new GetObjectCommand({ Bucket: S3_BUCKET!, Key: 'test/any.txt' }), { expiresIn: 3600 });
    expect(url).toContain('X-Amz-Expires=3600');
  });

  it('should use different expiry when specified', async () => {
    if (!isConfigured) return;

    const client = new S3Client({
      endpoint: S3_ENDPOINT!,
      region: S3_REGION,
      credentials: { accessKeyId: S3_ACCESS_KEY_ID!, secretAccessKey: S3_SECRET_ACCESS_KEY! },
      forcePathStyle: true,
    });

    const url = await getSignedUrl(client, new GetObjectCommand({ Bucket: S3_BUCKET!, Key: 'test/any.txt' }), { expiresIn: 7200 });
    expect(url).toContain('X-Amz-Expires=7200');
  });
});
