// Why a call from this agent to Vox failed, in words.
//
// undici (Node's fetch) throws a bare TypeError "fetch failed" and keeps the
// real reason in `cause` — so the agent used to log "Error fetching jobs:
// fetch failed" with no hint of who failed or why. These helpers name the
// request, the server, and the reason; for an HTTP error, the status and the
// error text Vox sent back.
//
// This text goes to the agent's own log only (its operator's), so the full
// detail — hostnames, addresses — is fine here.

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

/** "METHOD scheme://host/path" for a log line — never the query (it carries the lease id). */
export function describeRequest(method: string | undefined, url: string): string {
  return `${(method ?? 'GET').toUpperCase()} ${url.split('?')[0]}`;
}

/**
 * "HTTP 503 Service Unavailable: <Vox's error>" for a failed response. Reads a
 * clone, so the caller can still read the body. Vox answers errors as
 * { error: "…" }; anything else is quoted, whitespace-collapsed and capped.
 */
export async function describeHttpFailure(res: Response): Promise<string> {
  let said = '';
  try {
    const text = await res.clone().text();
    try {
      const body = JSON.parse(text) as { error?: unknown };
      said = typeof body?.error === 'string' ? body.error : text;
    } catch {
      said = text;
    }
  } catch { /* body unreadable — the status alone */ }
  said = said.replace(/\s+/g, ' ').trim().slice(0, 300);
  return `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}${said ? `: ${said}` : ''}`;
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
