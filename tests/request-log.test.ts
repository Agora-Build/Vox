import { describe, it, expect } from "vitest";
import { requestLogLine, MAX_LOGGED_BODY_CHARS } from "../server/request-log";

// #208: the request log recorded every JSON response body in full — job
// configs, transcripts, and pre-signed artifact download links valid an hour.

const signed = "https://acct.r2.cloudflarestorage.com/vox-artifacts/jobs/34688/recordings/recording.wav" +
  "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=abc%2F20260929&X-Amz-Signature=deadbeef";

describe("requestLogLine", () => {
  it("never logs a success body — the job detail with its download links is just a status line", () => {
    const body = { job: { id: 34688, config: { scenario: "steps: []" } }, result: { artifactFiles: [{ url: signed }] } };
    expect(requestLogLine("GET", "/api/eval-jobs/34688/detail", 200, 63, body))
      .toBe("GET /api/eval-jobs/34688/detail 200 in 63ms");
  });

  it("logs an error body, which is what helps diagnosis", () => {
    expect(requestLogLine("POST", "/api/eval-flows/7/run", 400, 12, { error: "Eval set required" }))
      .toBe('POST /api/eval-flows/7/run 400 in 12ms :: {"error":"Eval set required"}');
  });

  it("strips the query string (signatures, tokens) from any URL in an error body", () => {
    const line = requestLogLine("GET", "/api/x", 500, 5, { error: "fetch failed", url: signed });
    expect(line).not.toContain("X-Amz-Signature");
    expect(line).not.toContain("deadbeef");
    expect(line).toContain("recordings/recording.wav?…");
  });

  it("caps a long error body", () => {
    const line = requestLogLine("GET", "/api/x", 500, 5, { error: "x".repeat(5000) });
    const body = line.split(" :: ")[1];
    expect(body.length).toBe(MAX_LOGGED_BODY_CHARS + 1); // + the ellipsis
    expect(body.endsWith("…")).toBe(true);
  });

  it("still never logs a body for a sensitive route, even on error", () => {
    expect(requestLogLine("POST", "/api/secrets", 400, 3, { error: "Secret value must be at least 4 characters" }))
      .toBe("POST /api/secrets 400 in 3ms");
  });

  it("no captured body (e.g. a redirect or res.send): just the status line", () => {
    expect(requestLogLine("GET", "/api/x", 404, 1, undefined)).toBe("GET /api/x 404 in 1ms");
  });
});
