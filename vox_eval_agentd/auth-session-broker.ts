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
import { StringDecoder } from 'string_decoder';
import { summarizeAevalFailure, hasAevalDiagnosis, hasLoguruDiagnosis, LINE_TERMINATORS } from './aeval-output';

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
    // Longest first, matching summarizeAevalFailure. Order is load-bearing when
    // one credential contains another: with password "brent@agora.op-2026!" and
    // email "brent@agora.op", redacting the email first destroys the password's
    // only occurrence and leaks the "-2026!" remainder. Replacing the longest
    // needle first makes whole values win over their substrings, so overlapping
    // credentials can't shred each other.
    .sort((a, b) => b.length - a.length)
    .reduce((acc, v) => acc.split(v).join('[redacted]'), message);
}

/**
 * Every form a credential can take in aeval's output, so a scrub can match it.
 *
 * The mint scenario embeds credentials as `JSON.stringify(value)` (valid YAML
 * double-quoted scalars), so a password like `pa"ss\word` reaches aeval — and
 * can be echoed back in an ERROR line — as `pa\"ss\\word`. Scrubbing only the
 * raw value would miss that entirely, and the message is both logged and
 * returned to Core, where it is persisted as a user-visible job error.
 *
 * The escaped form is derived from the SAME `JSON.stringify` that writes the
 * YAML (minus its surrounding quotes) rather than a hand-rolled escaper, so the
 * two cannot drift: whatever the scenario emits is, by construction, what we
 * redact. The daemon solves this with a parallel `yamlEscape` list
 * (vox-agentd.ts `activeSecretValues`).
 */
export function credentialForms(values: string[]): string[] {
  return Array.from(
    new Set(
      values
        .filter((v) => v.length > 0)
        .flatMap((v) => [
          v,
          // YAML/JSON scalar, as the scenario writes it.
          JSON.stringify(v).slice(1, -1),
          // Percent-encoded, as an SSO redirect carries it. The whole point of
          // this PR is to report aeval's "current URL: <sso login page>" line,
          // and those URLs routinely carry the account in a query param
          // (login_hint=a%40b.com), so the raw form would never match.
          encodeURIComponent(v),
          // application/x-www-form-urlencoded differs from encodeURIComponent
          // only in spaces (+ vs %20) — cheap to cover, and passwords have
          // spaces.
          encodeURIComponent(v).replace(/%20/g, '+'),
        ]),
    ),
  );
}

/** Max characters retained per captured stream. See createBoundedCapture. */
export const CAPTURE_LIMIT = 64 * 1024;

/**
 * Bounded, line-aligned capture of one child stream.
 *
 * /mint is a long-running authenticated endpoint driving a browser, so an
 * unbounded buffer is an OOM waiting for a stuck or noisy run. Keeps the TAIL
 * rather than the head — that is where aeval's diagnosis lives, and
 * summarizeAevalFailure reads the LAST error lines anyway.
 *
 * The retained text NEVER begins mid-line, which is a redaction property, not
 * cosmetics: `scrubCredentials` matches whole credential forms, so a buffer
 * that began inside `password=<secret>` would leave an unmatchable suffix in a
 * string that is logged, returned in the 502 body, and persisted by Core as a
 * user-visible job error.
 *
 * Enforcing that needs state, not a pure append: when the overlong tail has no
 * newline at all there is no safe place to cut, so the line is abandoned AND
 * its continuation must be dropped until the next newline arrives. A pure
 * "slice at cut" would reintroduce the partial-credential leak on the very next
 * chunk.
 */
export function createBoundedCapture(limit = CAPTURE_LIMIT) {
  let buf = '';
  // Inside an abandoned overlong line. Resumes on '\n' only, NOT on the wider
  // LINE_TERMINATORS this module uses elsewhere: a '\n' is a line boundary
  // under the wider set too, so the "never begins mid-line" property still
  // holds — \r-terminated output would just over-discard, which is safe.
  let dropping = false;

  return {
    push(chunk: string): void {
      let s = chunk;
      if (dropping) {
        const nl = s.indexOf('\n');
        if (nl === -1) return; // still inside the abandoned line
        s = s.slice(nl + 1);
        dropping = false;
      }
      buf += s;
      if (buf.length <= limit) return;
      const cut = buf.length - limit;
      const nl = buf.indexOf('\n', cut);
      if (nl !== -1) {
        buf = buf.slice(nl + 1);
        return;
      }
      // The tail we would retain is one overlong partial line. Abandon that
      // line — but KEEP the complete lines already captured. Discarding
      // everything would throw away a diagnosis we had in hand and report
      // "login failed with no output", the very failure this change removes.
      const lastNl = buf.lastIndexOf('\n');
      buf = lastNl === -1 ? '' : buf.slice(0, lastNl + 1);
      if (buf.length > limit) {
        // Those kept lines can themselves exceed the cap; trim them at a line
        // boundary too. buf ends in '\n' here, so a newline always exists at or
        // after the cut and indexOf cannot miss.
        buf = buf.slice(buf.indexOf('\n', buf.length - limit) + 1);
      }
      dropping = true;
    },
    get text(): string {
      return buf;
    },
    /**
     * Only the COMPLETE lines captured so far — everything up to the last
     * newline. `text` can end mid-line while the child is still writing, and a
     * half-written `password=<secret>` no longer matches its redaction needle.
     * Read this whenever the summary is taken before the child has exited.
     */
    get completeText(): string {
      const lastNl = buf.lastIndexOf('\n');
      return lastNl === -1 ? '' : buf.slice(0, lastNl + 1);
    },
  };
}

/**
 * Which stream to summarize. stderr is aeval's loguru sink in the build we run,
 * and stdout may echo step params in encodings the scrub does not model
 * (URL-encoded form bodies, HTML page dumps, Python reprs with \uXXXX escapes),
 * so stdout is consulted ONLY when it carries a diagnosis that stderr lacks —
 * the "a future aeval routed loguru to stdout" case this hedge exists for.
 *
 * Gating on "stderr has no diagnosis" alone was a strict superset: when NEITHER
 * stream has an ERROR line (segfault, PyInstaller bootstrap failure, Chromium
 * crash) summarizeAevalFailure falls through to its tail path over both
 * strings, putting raw stdout into the persisted error.
 */
// Returns '' for BOTH "stdout is empty" and "stdout is rejected". The caller
// treats them identically — neither may contribute to the message — so the
// overload is deliberate rather than a lost distinction.
export function selectDiagnosisSource(stdout: string, stderr: string): string {
  if (hasAevalDiagnosis(stderr)) return '';
  // Admission of the untrusted stream uses the STRICT loguru-shaped predicate:
  // a bare "| ERROR |" is trivially present in a page dump, which would hand
  // the quarantined stream a free pass into the persisted error.
  if (!hasLoguruDiagnosis(stdout)) return '';
  // Admitted — but hand over ONLY the loguru-shaped lines. The summarizer picks
  // lines with the LENIENT predicate and keeps the last three, so passing the
  // whole stream would let page-dump text containing a bare "| ERROR |" both
  // reach the persisted error and bury the real line that earned admission.
  // Selection is now as strict as admission.
  return stdout.split(LINE_TERMINATORS).filter((l) => hasLoguruDiagnosis(l)).join('\n');
}

/** Reported when aeval produced nothing usable. Exported so callers can gate on it. */
export const NO_OUTPUT_MESSAGE = 'login failed with no output';

/**
 * The full failure-message pipeline for a non-zero aeval exit: pick the stream,
 * summarize it, scrub it. Pure, so the security-relevant selection is testable
 * without spawning aeval.
 */
export function describeMintFailure(stdout: string, stderr: string, forms: string[]): string {
  const source = selectDiagnosisSource(stdout, stderr);
  // Short-circuit rather than concatenating up to 2×CAPTURE_LIMIT just to test
  // for emptiness.
  if (!source.trim() && !stderr.trim()) return NO_OUTPUT_MESSAGE;
  // Pass minNeedleLength 0 rather than pre-scrubbing the inputs. The summarizer
  // redacts AFTER choosing lines and BEFORE truncating, so dropping its 4-char
  // floor covers a short password without the truncation gap — and, unlike an
  // input pre-scrub, cannot rewrite the very tokens classification depends on
  // (a password of "E" would turn every "ERROR" into "[redacted]RROR", so no
  // line matches and the artifacts banner wins again). The outer scrub stays as
  // defense in depth.
  return scrubCredentials(summarizeAevalFailure(source, stderr, forms, 0), forms);
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
      // BOTH streams are buffered, never logged. aeval's loguru sink is stderr
      // in the build we run (the original bug was its trailing INFO banner
      // winning a stderr tail), but that is a property of a version and a TTY,
      // not a guarantee: if a future aeval routes loguru to stdout, discarding
      // stdout would silently put us back to an uninformative error — the exact
      // failure this change exists to remove. stdout is only ever CONSULTED
      // when stderr carried no diagnosis (see hasAevalDiagnosis below), so in
      // the normal case it never reaches the reported text.
      //
      // A StringDecoder per stream, not d.toString(): a UTF-8 sequence split
      // across two pipe reads decodes to U+FFFD independently, and a mangled
      // non-ASCII password no longer matches its redaction needle — a scrub
      // bypass. The decoder holds the partial sequence across chunks.
      //
      // Each stream is capped and line-aligned — see createBoundedCapture.
      const outDec = new StringDecoder('utf8');
      const errDec = new StringDecoder('utf8');
      const outCap = createBoundedCapture();
      const errCap = createBoundedCapture();
      proc.stdout!.on('data', (d) => outCap.push(outDec.write(d)));
      proc.stderr!.on('data', (d) => errCap.push(errDec.write(d)));
      let settled = false;
      const finish = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
      const killTree = (signal: NodeJS.Signals) => {
        try { if (proc.pid) { process.kill(-proc.pid, signal); return; } } catch { /* fall through */ }
        try { proc.kill(signal); } catch { /* already gone */ }
      };
      // Summarize for the close path. `cleanExit` is false when the child was
      // KILLED by a signal (code === null: OOM killer, external SIGKILL,
      // Chromium taking the process down). That child died mid-write, so its
      // last line can be half-emitted — the same hazard completeText exists for
      // on the timeout path — and outDec.end() would flush an incomplete UTF-8
      // sequence as U+FFFD, breaking needle matching on exactly that line.
      // Prefer complete lines always; fall back to the raw text only when there
      // are none AND the exit was clean. loguru terminates its lines, so that
      // fallback should effectively never fire.
      const capturedFailure = (cleanExit: boolean): string => {
        outCap.push(outDec.end());
        errCap.push(errDec.end());
        const out = outCap.completeText || (cleanExit ? outCap.text : '');
        const err = errCap.completeText || (cleanExit ? errCap.text : '');
        return describeMintFailure(out, err, credentialForms([req.email, req.password]));
      };
      const timer = setTimeout(() => {
        killTree('SIGTERM');
        setTimeout(() => killTree('SIGKILL'), 5000);
        finish(() => {
          // A hung login was the one path still telling the operator nothing —
          // the same complaint this module exists to fix, one branch over. If
          // aeval logged anything before it hung (which step it reached, which
          // selector it was waiting on), say so.
          //
          // COMPLETE lines only, and no decoder flush: we are reporting while
          // the child is still mid-write, so its last line can be half-emitted.
          // A half-written `password=<secret>` matches no needle and would ride
          // out in the 502 body. The close path below has no such hazard.
          const summary = describeMintFailure(
            outCap.completeText, errCap.completeText, credentialForms([req.email, req.password]));
          // Gate on the summarizer's own verdict rather than re-testing the raw
          // buffers: quarantined-but-non-empty stdout would otherwise append a
          // redundant ": login failed with no output".
          const detail = summary === NO_OUTPUT_MESSAGE ? '' : `: ${summary}`;
          reject(new Error(`login timed out after ${timeoutMs}ms${detail}`));
        });
      }, timeoutMs);
      proc.on('error', (err) => finish(() => reject(err)));
      proc.on('close', (code) => finish(() => {
        if (code === 0) resolve();
        else {
          // Last-line-of-stderr is the wrong line by construction: aeval's
          // final line is an INFO "Artifacts saved to: ..." banner printed
          // after the diagnosis, so a real failure ("Error waiting for URL
          // pattern ... current URL: <sso login page>" — i.e. wrong password)
          // was reported as a path. capturedFailure() prefers the loguru ERROR
          // lines and redacts them before truncation.
          const summary = capturedFailure(typeof code === 'number');
          reject(new Error(`aeval exited ${code}: ${summary}`));
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
        // through logs or the 502 response body. Uses credentialForms, not the
        // raw pair: a mint that forgot to scrub is precisely the case where the
        // ESCAPED form arrives here, so a raw-only backstop would miss the one
        // thing it exists to catch.
        const msg = scrubCredentials(raw, credentialForms([body.email ?? '', body.password ?? '']));
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
