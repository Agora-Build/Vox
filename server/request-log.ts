import { isSensitiveResponsePath } from "./sensitive-paths";

/** Longest response body kept in a log line. */
export const MAX_LOGGED_BODY_CHARS = 500;

/**
 * The one-line request log. The response body is appended only when the
 * request FAILED (status >= 400) — that is where it helps diagnosis. A success
 * body is data: job configs, transcripts, metrics, and pre-signed artifact
 * download links (valid an hour — anyone reading the log could fetch a call
 * recording). None of that belongs in operational logs (#208).
 *
 * Even an error body is capped, has the query string stripped from any URL
 * (where signatures and tokens live), and is never logged for the routes in
 * sensitive-paths.ts.
 */
export function requestLogLine(
  method: string,
  path: string,
  status: number,
  durationMs: number,
  body: unknown,
): string {
  const line = `${method} ${path} ${status} in ${durationMs}ms`;
  if (status < 400 || body === undefined || isSensitiveResponsePath(path)) return line;
  let text = JSON.stringify(body).replace(/(https?:\/\/[^\s"?]+)\?[^\s"]*/g, "$1?…");
  if (text.length > MAX_LOGGED_BODY_CHARS) text = `${text.slice(0, MAX_LOGGED_BODY_CHARS)}…`;
  return `${line} :: ${text}`;
}
