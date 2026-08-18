/**
 * Vox Session Broker — trusted sidecar that performs headless target logins.
 *
 * Runs aeval's own per-platform `setup:account` flow (config/platforms/<id>.yaml
 * in aeval-data) and returns the captured Playwright storageState. Stateless:
 * every request gets a fresh temp dir, and nothing is persisted or logged.
 * Deployed from the vox_eval_agentd image with CMD ["node", "session-broker.js"].
 * Internal network ONLY — auth is a single shared secret with Core.
 */
import http from 'http';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AEVAL_DATA_PATH = path.resolve(__dirname, 'aeval-data');

export interface MintRequest { platformId: string; email: string; password: string }
export type MintFn = (req: MintRequest) => Promise<unknown>;

const PLATFORM_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

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
        else reject(new Error(`aeval exited ${code}: ${stderr.trim().split('\n').pop() || 'login failed'}`));
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

export function createBrokerServer(deps: { mint: MintFn; secret: string }): http.Server {
  return http.createServer(async (req, res) => {
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === 'GET' && req.url === '/health') return json(200, { status: 'ok' });
      if (req.method !== 'POST' || req.url !== '/mint') return json(404, { error: 'not found' });
      if (req.headers.authorization !== `Bearer ${deps.secret}`) return json(401, { error: 'unauthorized' });
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
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Broker] Mint failed for platform ${body.platformId}: ${msg}`);
        return json(502, { error: msg });
      }
    } catch (err) {
      console.error('[Broker] Request error:', err);
      return json(500, { error: 'internal error' });
    }
  });
}

// Entrypoint (skipped under vitest import)
if (process.argv[1] && process.argv[1].endsWith('session-broker.js')) {
  const secret = process.env.SESSION_BROKER_SECRET;
  if (!secret) { console.error('[Broker] SESSION_BROKER_SECRET is required'); process.exit(1); }
  const port = parseInt(process.env.BROKER_PORT || '8200', 10);
  const timeoutMs = parseInt(process.env.WEB_SESSION_MINT_TIMEOUT_SECONDS || '180', 10) * 1000;
  const server = createBrokerServer({ mint: (r) => mintWithAeval(r, timeoutMs), secret });
  server.listen(port, '0.0.0.0', () => console.log(`[Broker] Session broker listening on :${port}`));
}
