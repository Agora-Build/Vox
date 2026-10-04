export function previewRetryDelay(retryAfter: string | null, attempt: number, now = Date.now()) {
  const seconds = retryAfter == null ? NaN : Number(retryAfter);
  const requested = Number.isFinite(seconds) ? seconds * 1000 : retryAfter ? Date.parse(retryAfter) - now : 0;
  return Math.min(5000, Math.max(500 * 2 ** attempt, Number.isFinite(requested) ? requested : 0));
}

function waitForRetry(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); signal.removeEventListener("abort", aborted); reject(new DOMException("Preview cancelled", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, milliseconds);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

export async function fetchPreview(src: string, signal: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) throw new DOMException("Preview cancelled", "AbortError");
    const response = await fetch(src, { signal });
    if (response.status !== 429) return response;
    await response.body?.cancel();
    if (attempt === 3) throw new Error("Preview busy");
    await waitForRetry(previewRetryDelay(response.headers.get("Retry-After"), attempt), signal);
  }
}
