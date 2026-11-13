import { Agent } from "undici";

// Node's default 300s headers timeout is shorter than a supported login mint.
// The mandatory per-request AbortSignal bounds headers and body instead.
const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

export function internalFetch(
  url: string, init: RequestInit, timeoutMs: number, fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  return fetchImpl(url, {
    ...init, dispatcher, signal: AbortSignal.timeout(timeoutMs),
  } as RequestInit);
}
