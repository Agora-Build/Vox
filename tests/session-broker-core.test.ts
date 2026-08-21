import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { parsePlatformSetup, evaluateSessionRequirement, sessionScopeForWorkflow, credentialKeyFor } from "../server/auth-session";

describe("parsePlatformSetup", () => {
  it("extracts platformId and secret refs from a stepsPrefix", () => {
    const yaml = `- type: platform.setup
  platform_id: vapi
  mode: account
  params:
    email: \${secrets.VAPI_EMAIL}
    password: \${secrets.VAPI_PASSWORD}
- type: audio.start_recording`;
    expect(parsePlatformSetup(yaml)).toEqual({
      platformId: "vapi", emailSecret: "VAPI_EMAIL", passwordSecret: "VAPI_PASSWORD",
    });
  });
  it("handles params.mode shape and missing email/password", () => {
    const yaml = `- type: platform.setup
  platform_id: livekit
  params:
    mode: public`;
    expect(parsePlatformSetup(yaml)).toEqual({ platformId: "livekit", emailSecret: null, passwordSecret: null });
  });
  it("returns null for no platform.setup, invalid YAML, or empty input", () => {
    expect(parsePlatformSetup("- type: audio.play")).toBeNull();
    expect(parsePlatformSetup(": not yaml [")).toBeNull();
    expect(parsePlatformSetup(undefined)).toBeNull();
  });
  it("literal (non-placeholder) email/password params yield null refs", () => {
    const yaml = `- type: platform.setup
  platform_id: vapi
  params:
    email: someone@example.com
    password: literal`;
    expect(parsePlatformSetup(yaml)).toEqual({ platformId: "vapi", emailSecret: null, passwordSecret: null });
  });
});

describe("evaluateSessionRequirement", () => {
  const setup = { platformId: "vapi", emailSecret: "E", passwordSecret: "P" };

  it("need: BOTH email and password are login-class", () => {
    expect(evaluateSessionRequirement(setup, new Set(["E", "P"]))).toEqual({
      kind: "need",
      need: { platformId: "vapi", emailSecret: "E", passwordSecret: "P" },
    });
  });

  it("none: neither referenced secret is login-class (runtime path)", () => {
    expect(evaluateSessionRequirement(setup, new Set(["OTHER"]))).toEqual({ kind: "none" });
    expect(evaluateSessionRequirement(setup, new Set())).toEqual({ kind: "none" });
  });

  it("none: no platform.setup at all", () => {
    expect(evaluateSessionRequirement(null, new Set(["E", "P"]))).toEqual({ kind: "none" });
  });

  it("none: setup references no secrets even if some login-class secrets exist", () => {
    expect(
      evaluateSessionRequirement({ platformId: "x", emailSecret: null, passwordSecret: null }, new Set(["E", "P"])),
    ).toEqual({ kind: "none" });
  });

  it("misconfigured: split-class pair (only email is login-class) is rejected, not downgraded", () => {
    const req = evaluateSessionRequirement(setup, new Set(["E"]));
    expect(req.kind).toBe("misconfigured");
  });

  it("misconfigured: only password login-class", () => {
    const req = evaluateSessionRequirement(setup, new Set(["P"]));
    expect(req.kind).toBe("misconfigured");
  });

  it("misconfigured: password ref missing but email is login-class", () => {
    const req = evaluateSessionRequirement(
      { platformId: "vapi", emailSecret: "E", passwordSecret: null },
      new Set(["E"]),
    );
    expect(req.kind).toBe("misconfigured");
  });
});

describe("sessionScopeForWorkflow", () => {
  it("org workflow → org scope; personal → owner scope", () => {
    expect(sessionScopeForWorkflow({ ownerId: 7, organizationId: 3 })).toEqual({ organizationId: 3 });
    expect(sessionScopeForWorkflow({ ownerId: 7, organizationId: null })).toEqual({ userId: 7 });
  });
});

// ==================== ensureSession (DB + mock fetch) ====================

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

d("ensureSession (DB + mock fetch)", () => {
  // ensureSession now routes through broker-registry (routeToBroker/mintViaBroker)
  // instead of reading SESSION_BROKER_URL/SECRET directly — register a live,
  // routable "auth-session" broker + cache its mint secret so the mock-fetch
  // mint path below actually gets dispatched to it.
  let tokenId: number;
  let brokerId: number;

  beforeAll(async () => {
    const { storage } = await import("../server/storage");
    const { cacheBrokerMintSecret, clearBrokerMintSecret } = await import("../server/broker-registry");
    const token = await storage.createBrokerRegistrationToken({
      name: "test-auth-session-broker-token",
      tokenHash: `test-hash-${Date.now()}`,
      brokerType: "auth-session",
      createdBy: 1,
      isRevoked: false,
      expiresAt: null,
    });
    tokenId = token.id;
    const broker = await storage.createBroker({
      name: "test-auth-session-broker",
      tokenId,
      brokerType: "auth-session",
      url: "http://broker.test",
      state: "idle",
      lastSeenAt: new Date(),
    });
    brokerId = broker.id;
    cacheBrokerMintSecret(brokerId, "s");
  });

  afterAll(async () => {
    const { db } = await import("../server/storage");
    const { secrets, webSessions, brokers, brokerRegistrationTokens } = await import("../shared/schema");
    const { like, eq } = await import("drizzle-orm");
    const { clearBrokerMintSecret } = await import("../server/broker-registry");
    await db.delete(secrets).where(like(secrets.name, "TEST_SB_%"));
    await db.delete(webSessions).where(like(webSessions.platformId, "t-mint-%"));
    clearBrokerMintSecret(brokerId);
    await db.delete(brokers).where(eq(brokers.id, brokerId));
    await db.delete(brokerRegistrationTokens).where(eq(brokerRegistrationTokens.id, tokenId));
  });

  it("happy path: mints, stores ready, encrypted storageState round-trips, mint request carries decrypted email", async () => {
    const { storage, encryptValue, decryptValue } = await import("../server/storage");
    const { ensureSession } = await import("../server/auth-session");
    const stamp = Date.now();
    const emailSecret = `TEST_SB_E_${stamp}`;
    const passwordSecret = `TEST_SB_P_${stamp}`;
    const email = `user-${stamp}@example.com`;
    const password = `pw-${stamp}`;
    await storage.createOrUpdateSecret(1, emailSecret, encryptValue(email), { brokerType: "auth-session" });
    await storage.createOrUpdateSecret(1, passwordSecret, encryptValue(password), { brokerType: "auth-session" });

    const platformId = `t-mint-${stamp}`;
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const mockFetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return {
        ok: true,
        status: 200,
        json: async () => ({ storageState: { cookies: [] } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await ensureSession(
      { userId: 1 },
      { platformId, emailSecret, passwordSecret },
      mockFetch,
    );

    expect(capturedUrl).toBe("http://broker.test/mint");
    expect(capturedInit?.headers).toMatchObject({ authorization: "Bearer s" });
    const body = JSON.parse(capturedInit!.body as string);
    expect(body.email).toBe(email);
    expect(body.password).toBe(password);

    const got = await storage.getWebSession({ userId: 1 }, platformId, credentialKeyFor({ platformId, emailSecret, passwordSecret }));
    expect(got?.status).toBe("ready");
    expect(JSON.parse(decryptValue(got!.encryptedStorageState!))).toEqual({ cookies: [] });
  });

  it("broker error: marks the row failed with the broker's error status", async () => {
    const { storage } = await import("../server/storage");
    const { ensureSession } = await import("../server/auth-session");
    const stamp = Date.now();
    const emailSecret = `TEST_SB_E2_${stamp}`;
    const passwordSecret = `TEST_SB_P2_${stamp}`;
    const { encryptValue } = await import("../server/storage");
    await storage.createOrUpdateSecret(1, emailSecret, encryptValue(`e2-${stamp}@example.com`), { brokerType: "auth-session" });
    await storage.createOrUpdateSecret(1, passwordSecret, encryptValue(`pw2-${stamp}`), { brokerType: "auth-session" });

    const platformId = `t-mint-err-${stamp}`;
    const mockFetch = (async () => ({
      ok: false,
      status: 502,
      json: async () => ({ error: "login blew up" }),
    })) as unknown as typeof fetch;

    await ensureSession(
      { userId: 1 },
      { platformId, emailSecret, passwordSecret },
      mockFetch,
    );

    const got = await storage.getWebSession({ userId: 1 }, platformId, credentialKeyFor({ platformId, emailSecret, passwordSecret }));
    expect(got?.status).toBe("failed");
    expect(got?.lastError).toContain("502");
  });

  it("broker response with a non-object storageState (e.g. null) is rejected, not stored as ready", async () => {
    const { storage } = await import("../server/storage");
    const { ensureSession } = await import("../server/auth-session");
    const stamp = Date.now();
    const emailSecret = `TEST_SB_E3_${stamp}`;
    const passwordSecret = `TEST_SB_P3_${stamp}`;
    const { encryptValue } = await import("../server/storage");
    await storage.createOrUpdateSecret(1, emailSecret, encryptValue(`e3-${stamp}@example.com`), { brokerType: "auth-session" });
    await storage.createOrUpdateSecret(1, passwordSecret, encryptValue(`pw3-${stamp}`), { brokerType: "auth-session" });

    const platformId = `t-mint-badshape-${stamp}`;
    const mockFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ storageState: null }),
    })) as unknown as typeof fetch;

    await ensureSession(
      { userId: 1 },
      { platformId, emailSecret, passwordSecret },
      mockFetch,
    );

    const got = await storage.getWebSession({ userId: 1 }, platformId, credentialKeyFor({ platformId, emailSecret, passwordSecret }));
    expect(got?.status).toBe("failed");
    expect(got?.lastError).toContain("missing or invalid storageState");
  });

  it("fresh short-circuit: a ready session for the SAME credential pair skips the broker entirely", async () => {
    const { storage, encryptValue } = await import("../server/storage");
    const { ensureSession, credentialKeyFor } = await import("../server/auth-session");
    const stamp = Date.now();
    const platformId = `t-mint-fresh-${stamp}`;
    const need = { platformId, emailSecret: `TEST_SB_FE_${stamp}`, passwordSecret: `TEST_SB_FP_${stamp}` };
    // Seed a ready row keyed by the SAME credential pair ensureSession derives.
    // The short-circuit reads the row before touching secrets, so the login
    // secrets need not even exist for this path.
    const claimed = await storage.claimWebSessionMint({ userId: 1 }, platformId, credentialKeyFor(need), 180, 300);
    expect(claimed).toBeDefined();
    const stored = await storage.storeWebSessionReady(claimed!.id, encryptValue(JSON.stringify({ cookies: [] })), 12, claimed!.mintStartedAt!);
    expect(stored).toBe(true);

    const mockFetch = (async () => {
      throw new Error("must not be called");
    }) as unknown as typeof fetch;

    await ensureSession({ userId: 1 }, need, mockFetch);

    const got = await storage.getWebSession({ userId: 1 }, platformId, credentialKeyFor(need));
    expect(got?.status).toBe("ready");
  });

  it("no cross-credential short-circuit: a ready session for a DIFFERENT credential pair does NOT satisfy the need (HIGH-2)", async () => {
    const { storage, encryptValue, decryptValue } = await import("../server/storage");
    const { ensureSession, credentialKeyFor } = await import("../server/auth-session");
    const stamp = Date.now();
    const platformId = `t-mint-xcred-${stamp}`;
    // Account A already has a fresh, ready session on this platform.
    const needA = { platformId, emailSecret: `TEST_SB_XAE_${stamp}`, passwordSecret: `TEST_SB_XAP_${stamp}` };
    const claimedA = await storage.claimWebSessionMint({ userId: 1 }, platformId, credentialKeyFor(needA), 180, 300);
    expect(claimedA).toBeDefined();
    await storage.storeWebSessionReady(claimedA!.id, encryptValue(JSON.stringify({ cookies: ["A"] })), 12, claimedA!.mintStartedAt!);

    // Account B (different secret pair, same platform+owner) must mint its OWN
    // session, not be handed A's cookies. Its login secrets exist and the mock
    // broker returns B's distinct storageState.
    const needB = { platformId, emailSecret: `TEST_SB_XBE_${stamp}`, passwordSecret: `TEST_SB_XBP_${stamp}` };
    await storage.createOrUpdateSecret(1, needB.emailSecret, encryptValue(`b-${stamp}@example.com`), { brokerType: "auth-session" });
    await storage.createOrUpdateSecret(1, needB.passwordSecret, encryptValue(`bpw-${stamp}`), { brokerType: "auth-session" });
    let brokerCalled = false;
    const mockFetch = (async () => {
      brokerCalled = true;
      return { ok: true, status: 200, json: async () => ({ storageState: { cookies: ["B"] } }) } as unknown as Response;
    }) as unknown as typeof fetch;

    await ensureSession({ userId: 1 }, needB, mockFetch);

    expect(brokerCalled).toBe(true); // A's fresh row did NOT short-circuit B
    const gotA = await storage.getWebSession({ userId: 1 }, platformId, credentialKeyFor(needA));
    const gotB = await storage.getWebSession({ userId: 1 }, platformId, credentialKeyFor(needB));
    expect(gotA!.id).not.toBe(gotB!.id);
    expect(JSON.parse(decryptValue(gotA!.encryptedStorageState!))).toEqual({ cookies: ["A"] });
    expect(JSON.parse(decryptValue(gotB!.encryptedStorageState!))).toEqual({ cookies: ["B"] });
  });
});
