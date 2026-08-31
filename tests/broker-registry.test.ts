import { describe, it, expect } from "vitest";
import { isKnownBrokerType, isInternalBrokerUrl, KNOWN_BROKER_TYPES, isBrokerFresh, cacheBrokerMintSecret, clearBrokerMintSecret, routeToBrokerWith, validateRegisterPayload, mintViaBroker } from "../server/broker-registry";

describe("isKnownBrokerType", () => {
  it("accepts auth-session", () => expect(isKnownBrokerType("auth-session")).toBe(true));
  it("rejects unknown", () => expect(isKnownBrokerType("openai-key")).toBe(false));
  it("rejects null/number", () => {
    expect(isKnownBrokerType(null)).toBe(false);
    expect(isKnownBrokerType(1)).toBe(false);
  });
  it("KNOWN_BROKER_TYPES is exactly [auth-session]", () =>
    expect([...KNOWN_BROKER_TYPES]).toEqual(["auth-session"]));
});

describe("isInternalBrokerUrl", () => {
  it("accepts loopback http", () => expect(isInternalBrokerUrl("http://127.0.0.1:8200")).toBe(true));
  it("accepts RFC1918", () => {
    expect(isInternalBrokerUrl("http://10.1.2.3:8200")).toBe(true);
    expect(isInternalBrokerUrl("http://192.168.0.5:8200")).toBe(true);
    expect(isInternalBrokerUrl("http://172.16.4.4:8200")).toBe(true);
  });
  it("accepts single-label DNS and .internal/.local", () => {
    expect(isInternalBrokerUrl("http://vox-auth-session-broker:8200")).toBe(true);
    expect(isInternalBrokerUrl("http://broker.internal:8200")).toBe(true);
    expect(isInternalBrokerUrl("http://broker.local:8200")).toBe(true);
  });
  it("rejects public host", () => expect(isInternalBrokerUrl("http://broker.example.com:8200")).toBe(false));
  it("rejects https and non-http schemes", () => {
    expect(isInternalBrokerUrl("https://10.1.2.3:8200")).toBe(false);
    expect(isInternalBrokerUrl("ftp://10.1.2.3")).toBe(false);
  });
  it("rejects public RFC1918-lookalike (172.32)", () => expect(isInternalBrokerUrl("http://172.32.0.1")).toBe(false));
  it("rejects garbage", () => expect(isInternalBrokerUrl("not a url")).toBe(false));
  it("rejects public IPv6 literal", () =>
    expect(isInternalBrokerUrl("http://[2001:4860:4860::8888]:8200")).toBe(false));
  it("rejects IPv6 loopback literal (use localhost/IPv4 instead)", () =>
    expect(isInternalBrokerUrl("http://[::1]:8200")).toBe(false));
  it("rejects IPv6 ULA literal", () =>
    expect(isInternalBrokerUrl("http://[fc00::1]:8200")).toBe(false));
});

describe("isBrokerFresh", () => {
  const now = new Date("2026-08-21T12:00:00Z");
  it("fresh when within threshold", () =>
    expect(isBrokerFresh(new Date("2026-08-21T11:59:30Z"), 90, now)).toBe(true));
  it("stale when past threshold", () =>
    expect(isBrokerFresh(new Date("2026-08-21T11:58:00Z"), 90, now)).toBe(false));
  it("stale when never seen", () =>
    expect(isBrokerFresh(null, 90, now)).toBe(false));
});

describe("routeToBrokerWith", () => {
  const broker = (id: number, lastSeenAt: string) =>
    ({ id, name: `b${id}`, url: `http://10.0.0.${id}:8200`, brokerType: "auth-session", lastSeenAt: new Date(lastSeenAt) } as any);

  it("skips a routable broker with no cached mint secret", async () => {
    clearBrokerMintSecret(1);
    const t = await routeToBrokerWith("auth-session", async () => [broker(1, "2026-08-21T12:00:00Z")]);
    expect(t).toBeNull();
  });

  it("returns the freshest broker that has a cached secret", async () => {
    cacheBrokerMintSecret(2, "sekret");
    const t = await routeToBrokerWith(
      "auth-session",
      async () => [broker(1, "2026-08-21T11:00:00Z"), broker(2, "2026-08-21T12:00:00Z")],
    );
    expect(t).toEqual({ id: 2, url: "http://10.0.0.2:8200", mintSecret: "sekret" });
  });
});

describe("validateRegisterPayload", () => {
  it("rejects unknown type", () =>
    expect(validateRegisterPayload({ name: "b", brokerType: "x", url: "http://10.0.0.1:8200" }).ok).toBe(false));
  it("rejects public url", () =>
    expect(validateRegisterPayload({ name: "b", brokerType: "auth-session", url: "http://x.example.com" }).ok).toBe(false));
  it("accepts internal auth-session", () =>
    expect(validateRegisterPayload({ name: "b", brokerType: "auth-session", url: "http://vox-auth-session-broker:8200" }).ok).toBe(true));
});

describe("mintViaBroker error propagation", () => {
  const target = { url: "http://broker:8200", mintSecret: "s3" } as Parameters<typeof mintViaBroker>[0];
  const req = { platformId: "agora", email: "a@b.co", password: "pw" };
  const respond = (status: number, body: unknown, json = true) =>
    (async () =>
      ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => {
          if (!json) throw new SyntaxError("not json");
          return body;
        },
      })) as unknown as typeof fetch;

  it("folds the broker's diagnosis into the thrown message", async () => {
    // Without this the whole broker-side summarize/scrub pipeline reaches only
    // the sidecar's own container log: Core, webSessions.lastError and the
    // eval-agent 503 all said just "broker mint failed: 502".
    await expect(
      mintViaBroker(target, req, respond(502, { error: "aeval exited 1: Step 1 failed: platform.setup" })),
    ).rejects.toThrow("Step 1 failed: platform.setup");
  });

  it("still reports the status when the body is not JSON", async () => {
    await expect(mintViaBroker(target, req, respond(502, null, false))).rejects.toThrow("broker mint failed: 502");
  });

  it("re-redacts with Core's own credentials rather than trusting the broker", async () => {
    // Core holds the plaintext pair and persists this string to
    // webSessions.lastError, so a stale or buggy broker echoing a credential
    // must not become a durable leak here.
    await expect(
      mintViaBroker(target, { platformId: "agora", email: "a@b.co", password: "hunter2pw" },
        respond(502, { error: "login failed for a@b.co with hunter2pw" })),
    ).rejects.toThrow(/\[redacted\].*\[redacted\]/);
  });

  it("falls back to the default when the mint timeout env is unusable", async () => {
    // AbortSignal.timeout takes an unsigned long long, so a NaN would throw
    // synchronously and take the whole mint path down.
    const prev = process.env.WEB_SESSION_MINT_TIMEOUT_SECONDS;
    try {
      for (const bad of ["not-a-number", "0", "-5"]) {
        process.env.WEB_SESSION_MINT_TIMEOUT_SECONDS = bad;
        await expect(mintViaBroker(target, req, respond(200, { storageState: {} }))).resolves.toBeDefined();
      }
    } finally {
      if (prev === undefined) delete process.env.WEB_SESSION_MINT_TIMEOUT_SECONDS;
      else process.env.WEB_SESSION_MINT_TIMEOUT_SECONDS = prev;
    }
  });

  it("caps third-party detail before it reaches a durable field", async () => {
    const huge = "x".repeat(5000);
    await expect(mintViaBroker(target, req, respond(502, { error: huge }))).rejects.toThrow(
      /^broker mint failed: 502: x{500}$/,
    );
  });

  it("redacts BEFORE truncating, so a credential straddling the cap can't survive", async () => {
    // Slicing first leaves a partial value that matches no whole needle, and
    // this string is persisted to web_sessions.last_error. The credential is
    // placed so that offset 500 falls inside it.
    const password = "hunter2-and-a-long-tail-value";
    const filler = "y".repeat(500 - Math.floor(password.length / 2));
    const body = { error: `${filler}${password} trailing` };
    let thrown = "";
    await mintViaBroker(target, { platformId: "agora", email: "a@b.co", password },
      respond(502, body)).catch((e: Error) => { thrown = e.message; });
    expect(thrown).not.toContain(password);
    // ...and no prefix of it survives either.
    expect(thrown).not.toContain(password.slice(0, 12));
    expect(thrown).toContain("[redacted]");
  });
});
