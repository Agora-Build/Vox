import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { createBrokerServer, scrubCredentials, credentialForms, secretMatches, heartbeat, type MintRequest } from "../vox_eval_agentd/auth-session-broker";
import { summarizeAevalFailure } from "../vox_eval_agentd/aeval-output";

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
