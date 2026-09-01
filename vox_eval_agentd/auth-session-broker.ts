/**
 * Vox Auth Session Broker — trusted sidecar that performs headless target logins.
 *
 * Runs aeval's own per-platform `setup:account` flow (config/platforms/<id>.yaml
 * in aeval-data) and returns the captured Playwright storageState. Stateless:
 * every request gets a fresh temp dir and nothing is persisted. A FAILED mint
 * does log a summarized, scrubbed message (and returns it in the 502 body) —
 * see the boundary note below for what that can and cannot contain.
 * Shipped as its own image (vox-auth-session-broker, the Dockerfile's `broker` target).
 * Internal network ONLY. Registers itself with Core on startup and heartbeats;
 * `/mint` auth is the per-broker mint secret handed back at registration.
 *
 * BOUNDARY, so the next reader does not over-trust it: a failed mint's reported
 * message is scrubbed of the login pair in every encoding we model (see
 * credentialForms) and has URL queries removed (stripUrlQueries), and stdout is
 * quarantined behind a strict loguru-shaped predicate. stderr is NOT held to
 * that bar — it is admitted whenever it carries a diagnosis, because that is
 * the whole point. Playwright's errors quote page state, so a DOM snapshot or
 * an `<input value="...">` carrying a CSRF token or a hidden id_token can reach
 * the 502 body, Core's log, and webSessions.lastError. Those are modelled by no
 * needle and are not URLs. Core serves that detail onward only to an
 * owner-tier (private/team) agent — a marketplace agent gets the status alone —
 * so the exposure stays with the job's owner. Accepted rather than solved; see
 * GitHub #138.
 */
import http from 'http';
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { StringDecoder } from 'string_decoder';
import { summarizeAevalFailure, hasAevalDiagnosis, hasLoguruDiagnosis, reduceUrlsSafely, createBoundedCapture, LINE_TERMINATORS } from './aeval-output';
import { credentialForms, redactValues, fingerprintForLog, formatLastFailedHttpStatus } from '../shared/credentials';
import { mintTimeoutSeconds } from '../shared/mint-timeout';
export { credentialForms } from '../shared/credentials';

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
 * Strip credential values out of a message before it can reach a log line, the
 * 502 body, or Core's durable `web_sessions.last_error`. aeval's output is
 * third-party text and the scenario params carry the raw pair, so anything
 * derived from it is untrusted until scrubbed. Thin alias over the shared
 * primitive, kept because it names the intent at these call sites.
 */
export const scrubCredentials = redactValues;

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
  // .trim() before testing, because LOGURU_DIAGNOSIS_LINE is anchored at ^\d{4}
  // and summarizeAevalFailure trims before it tests. Without this a loguru line
  // arriving with a leading space is dropped by the hedge even though the
  // summarizer would have accepted it — the same predicate disagreement this
  // module spends its length eliminating.
  return stdout.split(LINE_TERMINATORS).filter((l) => hasLoguruDiagnosis(l.trim())).join('\n');
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
  // Strip URLs BEFORE summarizing, not after. summarizeAevalFailure joins the
  // last three ERROR lines and truncates to 500 chars, and a real SSO redirect
  // with redirectUri/state/PKCE runs 300-800 chars — so stripping afterwards
  // let the query consume the budget, truncate away the SECOND ERROR line (the
  // actual "Step 1 failed" diagnosis), and only then delete the material that
  // displaced it. Unlike pre-SCRUBBING, this is safe for classification: it
  // only rewrites text after `https?://...[?#]`, and a loguru timestamp/level
  // prefix never lives inside a URL. It also shortens the window in which a
  // ?code= is present at all.
  return scrubCredentials(
    summarizeAevalFailure(reduceUrlsSafely(source, forms), reduceUrlsSafely(stderr, forms), forms, 0),
    forms,
  );
}

/**
 * The HTTP status of the LAST FAILED REQUEST in an aeval run, or null.
 *
 * Named for what it measures, not what we hope it is. A browser console log
 * for an SSO flow routinely carries resource failures unrelated to the sign-in
 * — a favicon 404, a blocked analytics beacon, a CSP-refused script — and any
 * of them can be emitted after the auth POST. It is also page-influenceable: a
 * target page can print the same sentence itself. Reported honestly, it points
 * an operator at the right question; reported as "the login status" it could
 * point them at the wrong diagnosis, which is worse than no status at all.
 *
 * In practice it is usually the one that matters, and it is the field that
 * separates "the password is wrong" (server rejects the sign-in) from "this
 * browser is being challenged" (refused before credentials matter). Both look
 * identical otherwise: same timeout, same screenshot, same message — which is
 * why diagnosing it has meant reading the browser console inside the container
 * by hand.
 *
 * Located via aeval's own "Artifacts saved to: <dir>" line — the banner that
 * used to be reported AS the error. It is relative to aeval's cwd.
 *
 * Takes the banner from STDERR ONLY, and the LAST one. This module treats
 * aeval's stdout as untrusted — that is the entire reason selectDiagnosisSource
 * and hasLoguruDiagnosis exist — and this function turns a matched string into
 * a FILE READ, so honouring stdout here would let target-page text echoed by
 * the browser choose which path the broker opens. The banner is a loguru line,
 * so stderr is where it genuinely is.
 *
 * The resolved path is then confined under one of the permitted roots, so a
 * crafted `../../..` cannot escape even if the trusted stream is somehow
 * influenced. Lexical containment only — it does not resolve symlinks, so a
 * link planted INSIDE a permitted root would still be followed. That needs the
 * trusted stream to be compromised first, which is why it is left as
 * defence-in-depth rather than a guarantee. Two roots are accepted deliberately: against aeval 0.3.0 the
 * banner is RELATIVE and resolves under the data root — verified in production,
 * `Artifacts saved to: output/mint/20260831_230019_7219` landing at
 * `/app/aeval-data/output/mint/...` — but the mint scenario configures an
 * absolute `output_dir` under its own temp workdir, so a future aeval that
 * honours that setting would report an absolute path there instead. Accepting
 * both means such a change degrades to nothing rather than silently killing
 * this feature.
 *
 * Returns only the digits. Nothing else from console.log is propagated, so no
 * credential can ride along and no scrubbing is required — which is what makes
 * it safe to append after the redaction pipeline has already run.
 */
export function readLastFailedHttpStatus(aevalStderr: string, ...roots: string[]): number | null {
  const banners = [...aevalStderr.matchAll(/Artifacts saved to:[^\S\r\n]*(\S+)/g)];
  const dir = banners.length > 0 ? banners[banners.length - 1][1] : undefined;
  if (!dir) return null;
  if (roots.length === 0) return null; // every other failure mode here is soft
  const permitted = roots.map((r) => path.resolve(r));
  const consoleLog = path.resolve(permitted[0], dir, 'logs', 'console.log');
  const contained = permitted.some((r) => consoleLog === r || consoleLog.startsWith(r + path.sep));
  if (!contained) return null; // escaped every permitted artifacts root
  let text: string;
  try {
    // Tail only: the console log of a browser session is unbounded, and the
    // failing request is at the end.
    const { size } = fs.statSync(consoleLog);
    const start = Math.max(0, size - 256 * 1024);
    const fd = fs.openSync(consoleLog, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      // subarray: if the file shrank between statSync and the read, the tail of
      // buf is still zero-filled and would land in `text`.
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null; // no artifacts (e.g. killed before they were written)
  }
  const codes = [...text.matchAll(/responded with a status of (\d{3})/g)].map((m) => Number(m[1]));
  return codes.length > 0 ? codes[codes.length - 1] : null;
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
        // On a clean exit the stream is finished, so an unterminated tail is a
        // WHOLE line — take .text. Only a signal-killed child needs its
        // mid-write last line dropped.
        const out = cleanExit ? outCap.text : outCap.completeText;
        const err = cleanExit ? errCap.text : errCap.completeText;
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
          // redundant ": login failed with no output". NOTE the coupling — this
          // holds because describeMintFailure early-returns the constant before
          // any scrub can touch it. Keep it that way.
          const detail = summary === NO_OUTPUT_MESSAGE ? '' : `: ${summary}`;
          // Also try here. The motivating production failure is aeval's OWN 60s
          // wait_for_url timeout, which exits non-zero and lands in the close
          // handler below — but a broker-level hang that nonetheless wrote
          // artifacts should not lose the status for free. Fails soft to null.
          const status = readLastFailedHttpStatus(errCap.completeText, AEVAL_DATA_PATH, workDir);
          const httpNote = status === null ? '' : formatLastFailedHttpStatus(status);
          reject(new Error(`login timed out after ${timeoutMs}ms${httpNote}${detail}`));
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
          // completeText when the child was KILLED: its last line can be
          // half-emitted, and the banner IS the last line. Same rule
          // capturedFailure applies two lines up.
          const status = readLastFailedHttpStatus(
            code === null ? errCap.completeText : errCap.text, AEVAL_DATA_PATH, workDir);
          reject(new Error(`aeval exited ${code}${status === null ? '' : formatLastFailedHttpStatus(status)}: ${summary}`));
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
      // Fingerprint, never the values: lengths plus a hash of the IDENTIFIER
      // only. See fingerprintForLog for why the secret gets its length alone.
      // Logged on the REQUEST rather than only on failure, so a mint that hangs
      // still records which identifier was attempted.
      console.log(
        `[Broker] Mint request for platform ${body.platformId} (${fingerprintForLog(body.email, body.password)})`,
      );
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
  const timeoutMs = mintTimeoutSeconds() * 1000;
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
