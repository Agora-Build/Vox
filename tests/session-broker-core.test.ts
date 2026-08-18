import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { parsePlatformSetup, workflowNeedsSession, sessionScopeForWorkflow } from "../server/session-broker";

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

describe("workflowNeedsSession", () => {
  const setup = { platformId: "vapi", emailSecret: "E", passwordSecret: "P" };
  it("true only when a referenced secret is login-class", () => {
    expect(workflowNeedsSession(setup, new Set(["E"]))).toEqual({ platformId: "vapi", emailSecret: "E", passwordSecret: "P" });
    expect(workflowNeedsSession(setup, new Set(["OTHER"]))).toBeNull();
    expect(workflowNeedsSession(null, new Set(["E"]))).toBeNull();
    expect(workflowNeedsSession({ platformId: "x", emailSecret: null, passwordSecret: null }, new Set(["E"]))).toBeNull();
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
  let savedBrokerUrl: string | undefined;
  let savedBrokerSecret: string | undefined;

  beforeEach(() => {
    savedBrokerUrl = process.env.SESSION_BROKER_URL;
    savedBrokerSecret = process.env.SESSION_BROKER_SECRET;
    process.env.SESSION_BROKER_URL = "http://broker.test";
    process.env.SESSION_BROKER_SECRET = "s";
  });

  afterEach(() => {
    if (savedBrokerUrl === undefined) delete process.env.SESSION_BROKER_URL;
    else process.env.SESSION_BROKER_URL = savedBrokerUrl;
    if (savedBrokerSecret === undefined) delete process.env.SESSION_BROKER_SECRET;
    else process.env.SESSION_BROKER_SECRET = savedBrokerSecret;
  });

  afterAll(async () => {
    const { db } = await import("../server/storage");
    const { secrets, webSessions } = await import("../shared/schema");
    const { like } = await import("drizzle-orm");
    await db.delete(secrets).where(like(secrets.name, "TEST_SB_%"));
    await db.delete(webSessions).where(like(webSessions.platformId, "t-mint-%"));
  });

  it("happy path: mints, stores ready, encrypted storageState round-trips, mint request carries decrypted email", async () => {
    const { storage, encryptValue, decryptValue } = await import("../server/storage");
    const { ensureSession } = await import("../server/session-broker");
    const stamp = Date.now();
    const emailSecret = `TEST_SB_E_${stamp}`;
    const passwordSecret = `TEST_SB_P_${stamp}`;
    const email = `user-${stamp}@example.com`;
    const password = `pw-${stamp}`;
    await storage.createOrUpdateSecret(1, emailSecret, encryptValue(email), { class: "login" });
    await storage.createOrUpdateSecret(1, passwordSecret, encryptValue(password), { class: "login" });

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
    expect(capturedInit?.headers).toMatchObject({ Authorization: "Bearer s" });
    const body = JSON.parse(capturedInit!.body as string);
    expect(body.email).toBe(email);
    expect(body.password).toBe(password);

    const got = await storage.getWebSession({ userId: 1 }, platformId);
    expect(got?.status).toBe("ready");
    expect(JSON.parse(decryptValue(got!.encryptedStorageState!))).toEqual({ cookies: [] });
  });

  it("broker error: marks the row failed with the broker's error message", async () => {
    const { storage } = await import("../server/storage");
    const { ensureSession } = await import("../server/session-broker");
    const stamp = Date.now();
    const emailSecret = `TEST_SB_E2_${stamp}`;
    const passwordSecret = `TEST_SB_P2_${stamp}`;
    const { encryptValue } = await import("../server/storage");
    await storage.createOrUpdateSecret(1, emailSecret, encryptValue(`e2-${stamp}@example.com`), { class: "login" });
    await storage.createOrUpdateSecret(1, passwordSecret, encryptValue(`pw2-${stamp}`), { class: "login" });

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

    const got = await storage.getWebSession({ userId: 1 }, platformId);
    expect(got?.status).toBe("failed");
    expect(got?.lastError).toContain("login blew up");
  });

  it("fresh short-circuit: a ready, non-expiring-soon session skips the broker entirely", async () => {
    const { storage, encryptValue } = await import("../server/storage");
    const { ensureSession } = await import("../server/session-broker");
    const stamp = Date.now();
    const platformId = `t-mint-fresh-${stamp}`;
    const claimed = await storage.claimWebSessionMint({ userId: 1 }, platformId, 180, 300);
    expect(claimed).toBeDefined();
    const stored = await storage.storeWebSessionReady(claimed!.id, encryptValue(JSON.stringify({ cookies: [] })), 12, claimed!.mintStartedAt!);
    expect(stored).toBe(true);

    const mockFetch = (async () => {
      throw new Error("must not be called");
    }) as unknown as typeof fetch;

    await ensureSession(
      { userId: 1 },
      { platformId, emailSecret: "IRRELEVANT_E", passwordSecret: "IRRELEVANT_P" },
      mockFetch,
    );

    const got = await storage.getWebSession({ userId: 1 }, platformId);
    expect(got?.status).toBe("ready");
  });
});
