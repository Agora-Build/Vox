import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { createBrokerServer, scrubCredentials, credentialForms, createBoundedCapture, selectDiagnosisSource, describeMintFailure, secretMatches, heartbeat, type MintRequest } from "../vox_eval_agentd/auth-session-broker";
import { summarizeAevalFailure, hasAevalDiagnosis, hasLoguruDiagnosis } from "../vox_eval_agentd/aeval-output";

describe("secretMatches (constant-time bearer check)", () => {
  it("true only on an exact match", () => {
    expect(secretMatches("s3cr3t", "s3cr3t")).toBe(true);
  });
  it("false on a wrong secret of the same length", () => {
    expect(secretMatches("s3cr3X", "s3cr3t")).toBe(false);
  });
  it("false on a correct prefix (no early-exit leak)", () => {
    expect(secretMatches("s3cr3", "s3cr3t")).toBe(false);
    expect(secretMatches("s3cr3t-and-more", "s3cr3t")).toBe(false);
  });
  it("false on undefined/empty presented secret", () => {
    expect(secretMatches(undefined, "s3cr3t")).toBe(false);
    expect(secretMatches("", "s3cr3t")).toBe(false);
  });
});

describe("scrubCredentials", () => {
  it("redacts all occurrences of every credential value", () => {
    const result = scrubCredentials("aeval: login failed for a@b.c / hunter2", ["a@b.c", "hunter2"]);
    expect(result).not.toContain("a@b.c");
    expect(result).not.toContain("hunter2");
    expect(result).toBe("aeval: login failed for [redacted] / [redacted]");
  });

  it("ignores empty values", () => {
    const result = scrubCredentials("aeval: login failed", ["", ""]);
    expect(result).toBe("aeval: login failed");
  });

  it("leaves a message without credentials unchanged", () => {
    const result = scrubCredentials("login timed out after 180000ms", ["a@b.c", "hunter2"]);
    expect(result).toBe("login timed out after 180000ms");
  });
});

// Verbatim tail of a real failed mint (job 31072): a rejected login leaves the
// browser sitting on the SSO page, and aeval's LAST line is an INFO banner. The
// broker used to report that banner as the failure, so an operator saw a
// directory path instead of "the login was rejected".
const REAL_FAILED_MINT_STDERR = [
  "2026-08-30 17:49:50.860 | ERROR | Error waiting for URL pattern: https://conversational-ai.agora.io/, current URL: https://sso2.agora.io/en/login?redirectUri=...",
  "2026-08-30 17:49:50.860 | ERROR | Step 1 failed: platform.setup - Timeout 60000ms exceeded.",
  "2026-08-30 17:49:51.010 | WARNING | Session finished with status: failed (not all tests passed)",
  "2026-08-30 17:49:51.109 | INFO     | Artifacts saved to: output/mint/20260830_174839_2119",
].join("\n");

describe("mint failure summary (what the broker reports)", () => {
  it("names the login failure rather than aeval's trailing artifacts banner", () => {
    const summary = summarizeAevalFailure("", REAL_FAILED_MINT_STDERR, ["brent@agora.op", "hunter2"]);
    expect(summary).toContain("Step 1 failed: platform.setup");
    expect(summary).toContain("Error waiting for URL pattern");
    expect(summary).not.toContain("Artifacts saved to");
  });

  it("redacts the YAML/JSON-escaped form aeval actually sees, not just the raw value", () => {
    // The scenario embeds the password as JSON.stringify(value), so a password
    // with a quote or backslash reaches aeval — and comes back in an ERROR
    // line — escaped. Scrubbing only the raw value leaks it into a persisted,
    // user-visible job error.
    const password = 'pa"ss\\word';
    const escaped = JSON.stringify(password).slice(1, -1); // pa\"ss\\word
    expect(escaped).not.toBe(password); // guard: the fixture must actually differ

    const stderr = `2026-08-30 17:49:50.860 | ERROR | Step 1 failed: platform.setup - bad params: password="${escaped}"`;
    const forms = credentialForms(["a@b.co", password]);
    const summary = scrubCredentials(summarizeAevalFailure("", stderr, forms), forms);

    expect(summary).not.toContain(escaped);
    expect(summary).not.toContain(password);
    expect(summary).toContain("[redacted]");
  });

  it("redacts a password that CONTAINS the email without leaking the remainder", () => {
    // Order is load-bearing: redacting the shorter email first would destroy
    // the password's only occurrence, leaving "-2026!" — a live fragment of the
    // password — in a logged, persisted, user-visible message.
    const email = "brent@agora.op";
    const password = "brent@agora.op-2026!";
    const scrubbed = scrubCredentials(
      `login rejected for ${email} with password ${password}`,
      credentialForms([email, password]),
    );
    expect(scrubbed).not.toContain("-2026!");
    expect(scrubbed).not.toContain(password);
    expect(scrubbed).toBe("login rejected for [redacted] with password [redacted]");
  });

  it("consults stdout ONLY when it has a diagnosis stderr lacks", () => {
    const errLine = "2026-08-30 17:49:50.860 | ERROR | Step 1 failed: platform.setup";
    expect(hasAevalDiagnosis(errLine)).toBe(true);
    expect(hasAevalDiagnosis("2026-08-30 | INFO | Artifacts saved to: out/x")).toBe(false);

    // Normal case: stderr has the diagnosis, so stdout is never consulted.
    expect(selectDiagnosisSource("secret page dump", errLine)).toBe("");

    // The hedge: loguru moved to stdout. stdout is used and the cause surfaces.
    expect(selectDiagnosisSource(errLine, "")).toBe(errLine);
    expect(describeMintFailure(errLine, "", [])).toContain("Step 1 failed: platform.setup");

    // NEITHER stream has a diagnosis (segfault, PyInstaller bootstrap failure,
    // Chromium crash). stdout must still stay out: the summarizer would
    // otherwise fall through to a tail over both strings and put raw stdout —
    // page dumps, cookie values, storage-state fragments, none of which any
    // needle models — into a persisted, user-visible error.
    expect(selectDiagnosisSource("cookie=abc123 storageState dump", "boom")).toBe("");
    expect(describeMintFailure("cookie=abc123 storageState dump", "boom", []))
      .not.toContain("cookie=abc123");
  });

  it("reports the broker's own wording when aeval exits silently", () => {
    expect(describeMintFailure("", "", [])).toBe("login failed with no output");
    expect(describeMintFailure("", "   \n  ", [])).toBe("login failed with no output");
  });

  it("bounded capture keeps the tail, stays line-aligned, and never exceeds the limit", () => {
    const cap = createBoundedCapture(30);
    cap.push(["line-one", "line-two", "line-three", "ERROR | the real cause"].join("\n"));
    expect(cap.text.length).toBeLessThanOrEqual(30);
    expect(cap.text).toContain("ERROR | the real cause");
    expect(cap.text).not.toContain("line-one");
    expect(cap.text.startsWith("line-") || cap.text.startsWith("ERROR")).toBe(true);

    const small = createBoundedCapture(100);
    small.push("abc");
    small.push("def");
    expect(small.text).toBe("abcdef");
  });

  it("abandons an overlong line rather than cutting inside a credential", () => {
    // A single line longer than the cap has no safe cut point: retaining its
    // tail could start in the middle of password=<secret>, leaving a suffix
    // that matches no needle and survives scrubbing into the persisted error.
    const cap = createBoundedCapture(40);
    cap.push(`x`.repeat(200) + "password=SUPERSECRETVALUE");
    expect(cap.text).toBe("");
    expect(cap.text).not.toContain("SECRETVALUE");

    // ...and the continuation of that abandoned line is dropped too, up to the
    // next newline — otherwise the very next chunk reintroduces the fragment.
    cap.push("STILL_THE_SAME_LINE_SECRET");
    expect(cap.text).toBe("");
    cap.push("_tail\nERROR | recovered");
    expect(cap.text).toBe("ERROR | recovered");
    expect(cap.text).not.toContain("_tail");
  });

  it("keeps an already-captured diagnosis when a later line is overlong", () => {
    // Dropping the unsafe partial line must not discard the complete lines
    // already in hand, or a real diagnosis becomes "login failed with no output".
    const cap = createBoundedCapture(64);
    cap.push("2026-08-30 17:49:50.860 | ERROR | the real cause\n");
    cap.push("X".repeat(100_000));
    expect(cap.text).toContain("ERROR | the real cause");
    expect(cap.text).not.toContain("XXXX");
    expect(describeMintFailure("", cap.text, [])).toContain("the real cause");
  });

  it("does not let a cross-newline match sneak stdout past the quarantine", () => {
    // \s matches newlines, so an unanchored /\|\s*(ERROR|CRITICAL)\s*\|/ matched
    // this whole-buffer while NO single line matched — the summarizer then fell
    // through to a raw tail over both streams, leaking stdout.
    const crossLine = "dump: foo |\nERROR |x| y";
    expect(hasAevalDiagnosis(crossLine)).toBe(false);
    expect(selectDiagnosisSource(crossLine, "")).toBe("");

    // A bare "| ERROR |" in untrusted output is not enough either: admission of
    // stdout requires loguru's full timestamped line shape.
    const bareError = "page text | ERROR | Something went wrong on the site";
    expect(hasAevalDiagnosis(bareError)).toBe(true);
    expect(hasLoguruDiagnosis(bareError)).toBe(false);
    expect(selectDiagnosisSource(bareError, "")).toBe("");

    const realLoguru = "2026-08-30 17:49:50.860 | ERROR | Step 1 failed: platform.setup";
    expect(hasLoguruDiagnosis(realLoguru)).toBe(true);
    expect(selectDiagnosisSource(realLoguru, "")).toBe(realLoguru);
  });

  it("redacts a credential shorter than the summarizer's default floor", () => {
    const pw = "ab1";
    const stderr = `2026-08-30 17:49:50.860 | ERROR | login failed with password=${pw} end`;
    const summary = describeMintFailure("", stderr, credentialForms(["a@b.co", pw]));
    expect(summary).not.toContain("password=ab1");
    expect(summary).toContain("[redacted]");
  });

  it("still finds the ERROR line when the password is a substring of 'ERROR'", () => {
    // Pre-scrubbing the INPUT would rewrite the word ERROR itself, so no line
    // would classify and the artifacts banner would win again — the exact
    // regression this PR exists to prevent. Redaction must happen after
    // classification, never before it.
    for (const pw of ["E", "R", "|", "ERROR"]) {
      const summary = describeMintFailure("", REAL_FAILED_MINT_STDERR, credentialForms(["a@b.co", pw]));
      expect(summary).not.toContain("Artifacts saved to");
      expect(summary.toLowerCase()).toContain("platform.setup");
    }
  });

  it("never lets an empty needle shred the message", () => {
    // A floor of 0 admits "" unless guarded, and "".split("") splits between
    // every character.
    const summary = describeMintFailure("", REAL_FAILED_MINT_STDERR, ["", "  "]);
    expect(summary).toContain("Step 1 failed: platform.setup");
    expect(summary).not.toContain("[redacted][redacted]");
  });

  it("hands the summarizer only loguru-shaped lines from admitted stdout", () => {
    // Once stdout is admitted, page-dump text with a bare "| ERROR |" must not
    // be selectable — it would both reach the persisted error and bury the real
    // loguru line that earned admission (the summarizer keeps the LAST three).
    const stdout = [
      "2026-08-30 17:49:50.860 | ERROR | Step 1 failed: platform.setup",
      "page dump | ERROR | cookie=SESSIONVALUE123",
      "more page text | ERROR | storageState fragment",
    ].join("\n");
    const summary = describeMintFailure(stdout, "", []);
    expect(summary).toContain("Step 1 failed: platform.setup");
    expect(summary).not.toContain("SESSIONVALUE123");
    expect(summary).not.toContain("storageState fragment");
  });

  it("credentialForms derives the escaped form from the same stringify the scenario uses", () => {
    expect(credentialForms(['a"b'])).toEqual(['a"b', 'a\\"b']);
    expect(credentialForms(["plain"])).toEqual(["plain"]); // no duplicate when escaping is a no-op
    expect(credentialForms([""])).toEqual([]);
  });

  it("keeps the credential out of the reported message", () => {
    const summary = summarizeAevalFailure(
      "",
      `${REAL_FAILED_MINT_STDERR}\n2026-08-30 17:49:51.010 | ERROR | login rejected for brent@agora.op`,
      ["brent@agora.op", "hunter2"],
    );
    expect(summary).not.toContain("brent@agora.op");
    expect(summary).toContain("[redacted]");
  });
});

describe("auth-session-broker HTTP service", () => {
  let server: Server;
  let baseUrl: string;
  let received: MintRequest[] = [];
  let mintImpl: (req: MintRequest) => Promise<unknown> = async () => ({ cookies: [] });

  beforeAll(async () => {
    server = createBrokerServer({
      getSecret: () => "s3",
      mint: async (req) => {
        received.push(req);
        return mintImpl(req);
      },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it("GET /health returns 200 with no auth required", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("POST /mint with no auth header returns 401", async () => {
    const res = await fetch(`${baseUrl}/mint`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platformId: "vapi", email: "a@b.com", password: "pw" }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /mint with wrong bearer returns 401", async () => {
    const res = await fetch(`${baseUrl}/mint`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer nope" },
      body: JSON.stringify({ platformId: "vapi", email: "a@b.com", password: "pw" }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /mint with good auth but missing password returns 400", async () => {
    const res = await fetch(`${baseUrl}/mint`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer s3" },
      body: JSON.stringify({ platformId: "vapi", email: "a@b.com" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  it("POST /mint with good auth and full body returns 200 with storageState, and mint receives exact request", async () => {
    received = [];
    mintImpl = async () => ({ cookies: [{ name: "session", value: "xyz" }] });
    const reqBody = { platformId: "vapi", email: "a@b.com", password: "pw123" };
    const res = await fetch(`${baseUrl}/mint`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer s3" },
      body: JSON.stringify(reqBody),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ storageState: { cookies: [{ name: "session", value: "xyz" }] } });
    expect(received).toEqual([reqBody]);
  });

  it("mint throwing an error returns 502 with the error message", async () => {
    mintImpl = async () => {
      throw new Error("captcha wall");
    };
    const res = await fetch(`${baseUrl}/mint`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer s3" },
      body: JSON.stringify({ platformId: "vapi", email: "a@b.com", password: "pw123" }),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain("captcha wall");
  });

  it("mint throwing an error that echoes credentials is scrubbed before it reaches the response", async () => {
    mintImpl = async () => {
      throw new Error("Login failed for user secret-email@x.com with password hunter2-pass");
    };
    const res = await fetch(`${baseUrl}/mint`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer s3" },
      body: JSON.stringify({ platformId: "vapi", email: "secret-email@x.com", password: "hunter2-pass" }),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain("[redacted]");
    expect(body.error).not.toContain("secret-email@x.com");
    expect(body.error).not.toContain("hunter2-pass");
  });

  it("the defense-in-depth scrub catches the ESCAPED credential a forgetful mint would leak", async () => {
    // This layer exists for a mint that failed to scrub — and that is exactly
    // the case where the JSON/YAML-escaped form arrives, since the scenario
    // embeds credentials via JSON.stringify. A raw-only backstop would miss it.
    const password = 'pa"ss\\word';
    const escaped = JSON.stringify(password).slice(1, -1);
    expect(escaped).not.toBe(password); // guard: fixture must actually differ

    mintImpl = async () => {
      throw new Error(`aeval exited 1: bad params: password="${escaped}"`);
    };
    const res = await fetch(`${baseUrl}/mint`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer s3" },
      body: JSON.stringify({ platformId: "vapi", email: "a@b.com", password }),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).not.toContain(escaped);
    expect(body.error).not.toContain(password);
    expect(body.error).toContain("[redacted]");
  });
});

describe("auth-session-broker HTTP service (no mint secret registered yet)", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createBrokerServer({
      getSecret: () => undefined,
      mint: async () => ({ cookies: [] }),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it("POST /mint returns 401 when getSecret() returns undefined (not yet registered)", async () => {
    const res = await fetch(`${baseUrl}/mint`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer anything" },
      body: JSON.stringify({ platformId: "vapi", email: "a@b.com", password: "pw" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("heartbeat resilience", () => {
  it("does not reject when register() fails (no unhandled rejection -> no process crash)", async () => {
    // Under vitest the entrypoint guard is false, so register() never ran and the
    // module's `state` is still null. heartbeat() therefore takes the register() path;
    // we make the underlying fetch reject to simulate Core being briefly unreachable.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch;
    try {
      await expect(heartbeat()).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
