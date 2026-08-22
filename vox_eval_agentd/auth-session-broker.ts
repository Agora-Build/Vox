/**
 * Vox Auth Session Broker — trusted sidecar that performs headless target logins.
 *
 * Runs aeval's own per-platform `setup:account` flow (config/platforms/<id>.yaml
 * in aeval-data) and returns the captured Playwright storageState. Stateless:
 * every request gets a fresh temp dir, and nothing is persisted or logged.
 * Shipped as its own image (vox-auth-session-broker, the Dockerfile's `broker` target).
 * Internal network ONLY. Registers itself with Core on startup and heartbeats;
 * `/mint` auth is the per-broker mint secret handed back at registration.
 */
import http from 'http';
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AEVAL_DATA_PATH = path.resolve(__dirname, 'aeval-data');

export interface MintRequest { platformId: string; email: string; password: string }
export type MintFn = (req: MintRequest) => Promise<unknown>;

const PLATFORM_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Constant-time bearer-secret check. A plain `!==` on the shared secret leaks
 * its length and a prefix-match position through response timing; compare
 * fixed-length SHA-256 digests with timingSafeEqual so every mismatch costs
 * the same time regardless of how much of the secret an attacker guessed.
 */
export function secretMatches(presented: string | undefined, expected: string): boolean {
  if (typeof presented !== 'string') return false;
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Strip any of `values` (raw credentials) out of `message` before it can
 * reach a log line or the durable `web_sessions.last_error` column.
 * aeval's stderr is third-party output and the scenario params carry raw
 * email/password, so any stderr-derived text is untrusted until scrubbed.
 * Empty values are ignored (never redact on an empty-string match).
 */
export function scrubCredentials(message: string, values: string[]): string {
  return values
    .filter((v) => v.length > 0)
    .reduce((acc, v) => acc.split(v).join('[redacted]'), message);
}

/** Real mint: one-step aeval scenario running setup:account → save_storage_state. */
export async function mintWithAeval(req: MintRequest, timeoutMs: number): Promise<unknown> {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vox-mint-'));
  const storageFile = path.join(workDir, 'session.json');
  const scenarioFile = path.join(workDir, 'mint.yaml');
  // YAML built with JSON.stringify'd scalars — JSON strings are valid YAML
  // double-quoted scalars, so credential characters can't break the document.
  const scenario = [
    '---',
    'name: session_mint',
    'params:',
    `  output_dir: ${JSON.stringify(path.join(workDir, 'out'))}`,
    'steps:',
    '  - type: platform.setup',
    `    platform_id: ${JSON.stringify(req.platformId)}`,
    '    mode: account',
    '    params:',
    `      mode: account`,
    `      email: ${JSON.stringify(req.email)}`,
    `      password: ${JSON.stringify(req.password)}`,
    `      storage_file: ${JSON.stringify(storageFile)}`,
    '',
  ].join('\n');
  fs.writeFileSync(scenarioFile, scenario, { mode: 0o600 });
  try {
    await new Promise<void>((resolve, reject) => {
      // Own process group so the timeout can kill aeval AND its browser children
      // (same discipline as vox-agentd's runAeval).
      const proc = spawn('aeval', ['run', scenarioFile], {
        cwd: AEVAL_DATA_PATH,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      let stderr = '';
      proc.stderr!.on('data', (d) => { stderr += d.toString(); });
      // stdout intentionally discarded — may echo step params. Never log it.
      proc.stdout!.on('data', () => {});
      let settled = false;
      const finish = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
      const killTree = (signal: NodeJS.Signals) => {
        try { if (proc.pid) { process.kill(-proc.pid, signal); return; } } catch { /* fall through */ }
        try { proc.kill(signal); } catch { /* already gone */ }
      };
      const timer = setTimeout(() => {
        killTree('SIGTERM');
        setTimeout(() => killTree('SIGKILL'), 5000);
        finish(() => reject(new Error(`login timed out after ${timeoutMs}ms`)));
      }, timeoutMs);
      proc.on('error', (err) => finish(() => reject(err)));
      proc.on('close', (code) => finish(() => {
        if (code === 0) resolve();
        else {
          const tail = scrubCredentials(stderr.trim().split('\n').pop() || 'login failed', [req.email, req.password]);
          reject(new Error(`aeval exited ${code}: ${tail}`));
        }
      }));
    });
    if (!fs.existsSync(storageFile)) {
      throw new Error('login completed but no storage state was saved');
    }
    return JSON.parse(fs.readFileSync(storageFile, 'utf8'));
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

export function createBrokerServer(deps: { mint: MintFn; getSecret: () => string | undefined }): http.Server {
  return http.createServer(async (req, res) => {
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === 'GET' && req.url === '/health') return json(200, { status: 'ok' });
      if (req.method !== 'POST' || req.url !== '/mint') return json(404, { error: 'not found' });
      const authz = req.headers.authorization;
      const presented = authz && authz.startsWith('Bearer ') ? authz.slice(7) : undefined;
      const secret = deps.getSecret();
      if (!secret) return json(401, { error: 'unauthorized' });
      if (!secretMatches(presented, secret)) return json(401, { error: 'unauthorized' });
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: Partial<MintRequest>;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(400, { error: 'invalid JSON body' }); }
      if (typeof body.platformId !== 'string' || !PLATFORM_ID_RE.test(body.platformId)) return json(400, { error: 'platformId is required' });
      if (typeof body.email !== 'string' || !body.email) return json(400, { error: 'email is required' });
      if (typeof body.password !== 'string' || !body.password) return json(400, { error: 'password is required' });
      console.log(`[Broker] Mint request for platform ${body.platformId}`); // never log email/password
      try {
        const storageState = await deps.mint(body as MintRequest);
        return json(200, { storageState });
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        // Defense-in-depth: scrub again here so even a future mint
        // implementation that forgets to scrub can't leak credentials
        // through logs or the 502 response body.
        const msg = scrubCredentials(raw, [body.email ?? '', body.password ?? '']);
        console.error(`[Broker] Mint failed for platform ${body.platformId}: ${msg}`);
        return json(502, { error: msg });
      }
    } catch (err) {
      console.error('[Broker] Request error:', err);
      return json(500, { error: 'internal error' });
    }
  });
}

// Registration client: this broker registers itself with Core on startup and
// heartbeats every HEARTBEAT_MS (60s). The `/mint` bearer secret is NOT a static
// env var — it is the per-broker `mintSecret` handed back by Core at
// registration, held only in this module's `state`.
let state: { brokerId: number; leaseId: string; mintSecret: string } | null = null;
const CORE_URL = process.env.VOX_CORE_URL!;        // e.g. http://vox-service:5000
const REG_TOKEN = process.env.BROKER_REG_TOKEN!;   // admin-issued registration token
const ADVERTISE_URL = process.env.BROKER_ADVERTISE_URL!; // internal URL Core will call
const BROKER_NAME = process.env.BROKER_NAME || 'auth-session-broker';
const HEARTBEAT_MS = 60000;

async function register(): Promise<void> {
  const res = await fetch(`${CORE_URL}/api/brokers/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${REG_TOKEN}` },
    body: JSON.stringify({ name: BROKER_NAME, brokerType: 'auth-session', url: ADVERTISE_URL }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status}`);
  state = await res.json();
}

export async function heartbeat(): Promise<void> {
  try {
    if (!state) { await register(); return; }
    const res = await fetch(`${CORE_URL}/api/brokers/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${REG_TOKEN}` },
      body: JSON.stringify({ brokerId: state.brokerId, leaseId: state.leaseId, state: 'idle' }),
    }).catch(() => null);
    if (!res || !res.ok) return;
    const body = await res.json().catch(() => ({}));
    if (body.reregister || body.superseded) { state = null; await register(); }
  } catch (err) {
    console.error('[Broker] heartbeat error:', err instanceof Error ? err.message : err);
  }
}

// Entrypoint (skipped under vitest import)
if (process.argv[1] && process.argv[1].endsWith('auth-session-broker.js')) {
  const port = parseInt(process.env.BROKER_PORT || '8200', 10);
  const timeoutMs = parseInt(process.env.WEB_SESSION_MINT_TIMEOUT_SECONDS || '180', 10) * 1000;
  const server = createBrokerServer({ mint: (r) => mintWithAeval(r, timeoutMs), getSecret: () => state?.mintSecret });
  (async () => {
    try {
      await register();
    } catch (err) {
      console.error('[Broker] registration failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
    server.listen(port, '0.0.0.0', () => console.log(`[Broker] Auth session broker listening on :${port}`));
    setInterval(heartbeat, HEARTBEAT_MS);
  })();
}
