// Why a call from this agent to Vox failed, in words.
//
// undici (Node's fetch) throws a bare TypeError "fetch failed" and keeps the
// real reason in `cause` — so the agent used to log "Error fetching jobs:
// fetch failed" with no hint of who failed or why. These helpers name the
// request, the server, and the reason; for an HTTP error, the status and the
// error text Vox sent back.
//
// The detail names the server the agent talks to — its configured Vox URL,
// which its operator chose and which is public for a hosted Vox. A failure
// inside a job (e.g. its session or REST step) also lands in that job's error,
// seen by whoever ran it.

/** The reason a fetch threw, from undici's `cause` when it has one. */
export function describeFetchError(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string; cause?: { code?: string } } };
  if (e?.name === 'TimeoutError') return 'no answer in time (request timed out)';
  if (e?.name === 'AbortError') return 'request aborted';
  // TLS failures sometimes keep their code one level deeper.
  const code = e?.cause?.code ?? e?.cause?.cause?.code;
  const detail = e?.cause?.message;
  const said = (what: string) => `${what}${detail ? ` — ${detail}` : ''} (${code})`;
  switch (code) {
    case 'ENOTFOUND':
      return said("the server's hostname doesn't resolve");
    case 'EAI_AGAIN':
      return said('DNS lookup failed (temporary — no DNS answer)');
    case 'ECONNREFUSED':
      return said('connection refused (the server is down or restarting)');
    case 'ECONNRESET':
    case 'UND_ERR_SOCKET':
      return said('the connection was dropped mid-request (server restarted, or a proxy cut it)');
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return said("couldn't connect in time");
    case 'UND_ERR_HEADERS_TIMEOUT':
    case 'UND_ERR_BODY_TIMEOUT':
      return said('connected, but the server stopped answering');
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return said('network unreachable from this host');
  }
  if (code && /CERT|TLS|SSL/i.test(code)) return said('TLS/certificate problem');
  if (code) return said('network error');
  if (detail) return detail;
  return e?.message ?? String(err);
}

/**
 * "METHOD scheme://host/path" for a log line — never the query (it carries the
 * lease id), nor any user:password in the URL.
 */
export function describeRequest(method: string | undefined, url: string): string {
  let shown = url.split('?')[0];
  try {
    const u = new URL(url);
    shown = `${u.origin}${u.pathname}`;
  } catch { /* not a full URL: the query is already cut */ }
  return `${(method ?? 'GET').toUpperCase()} ${shown}`;
}

const BODY_READ_LIMIT = 4096;

/**
 * Text from Vox or a proxy, made safe for a log line: control characters —
 * ANSI/OSC escape sequences included, which could rewrite a terminal or a log
 * viewer — removed, whitespace collapsed, capped.
 */
export function sanitizeRemoteText(text: string, cap = 300): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-_])/g, '') // CSI / OSC / short escapes
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, cap);
}

/** At most `limit` bytes of a body, then the rest is cancelled — never buffered whole. */
async function readBounded(res: Response, limit = BODY_READ_LIMIT): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let got = 0;
  try {
    while (got < limit) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      got += value.length;
    }
  } catch {
    // The request's timeout (or a dropped connection) ended the read: keep
    // what arrived — a partial reason beats none.
  } finally {
    reader.cancel().catch(() => {});
  }
  const all = new Uint8Array(Math.min(got, limit));
  let at = 0;
  for (const c of chunks) {
    const part = c.subarray(0, Math.min(c.length, all.length - at));
    all.set(part, at);
    at += part.length;
    if (at >= all.length) break;
  }
  return new TextDecoder().decode(all);
}

/**
 * "HTTP 503 Service Unavailable: <Vox's error>" for a failed response.
 * CONSUMES the body — its first 4 KB, then cancels the rest so the connection
 * is released (#246 review: a clone left the original branch holding it);
 * every caller is done with the response by then. Vox answers errors as
 * { error: "…" }; anything else is quoted. Sanitized.
 */
export async function describeHttpFailure(res: Response): Promise<string> {
  let said = '';
  try {
    const text = await readBounded(res);
    try {
      const body = JSON.parse(text) as { error?: unknown };
      said = typeof body?.error === 'string' ? body.error : text;
    } catch {
      said = text;
    }
  } catch { /* body unreadable — the status alone */ }
  said = sanitizeRemoteText(said);
  return `HTTP ${res.status}${res.statusText ? ` ${sanitizeRemoteText(res.statusText, 80)}` : ''}${said ? `: ${said}` : ''}`;
}

/**
 * Send a request, retrying only what can succeed on a retry: a failed
 * connection or a 5xx. A 4xx is final (a refused lease or job won't change),
 * and so is a timeout (see below).
 * Returns null on success, else why it failed.
 */
export async function sendWithRetry(
  send: () => Promise<Response>,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<string | null> {
  const attempts = opts.attempts ?? 3;
  let last = '';
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await send();
      if (res.ok) return null;
      last = await describeHttpFailure(res);
      if (res.status < 500) return last;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
      // Not after a timeout (#246 review): the server may still be handling
      // the first attempt, and a second one running alongside it could do
      // the work twice (e.g. two result rows). A refused or dropped
      // connection never got that far.
      const cause = (e as { cause?: { name?: string } })?.cause;
      if (cause?.name === 'TimeoutError' || (e as { name?: string })?.name === 'TimeoutError') return `${last} (not retried: the server may still be handling it)`;
    }
    if (i < attempts) await new Promise((r) => setTimeout(r, (opts.delayMs ?? 2000) * i));
  }
  return `${last} (after ${attempts} attempts)`;
}

/**
 * Failure logging for a call made on a timer (the 10 s job poll): says so when
 * it starts failing and whenever the reason changes, then once on recovery
 * with how many attempts failed — not one line per attempt through an outage.
 */
export function createFailureLog(
  what: string,
  log: { error: (line: string) => void; info: (line: string) => void } = {
    error: (l) => console.error(l),
    info: (l) => console.log(l),
  },
) {
  let reason: string | null = null;
  let failures = 0;
  return (problem: string | null): void => {
    if (problem) {
      failures++;
      if (problem !== reason) log.error(`[Daemon] ${what} failing: ${problem}`);
      reason = problem;
    } else if (reason) {
      log.info(`[Daemon] ${what} recovered after ${failures} failed attempt${failures === 1 ? '' : 's'}`);
      reason = null;
      failures = 0;
    }
  };
}
