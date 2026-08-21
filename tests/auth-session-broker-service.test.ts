import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { createBrokerServer, scrubCredentials, secretMatches, heartbeat, type MintRequest } from "../vox_eval_agentd/auth-session-broker";

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
