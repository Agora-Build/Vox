import { describe, it, expect, afterAll } from "vitest";
import { deriveApiKeyStatus } from "../server/api-key-status";

// DB-backed coverage for the reaper + api-key lifecycle storage methods.
// Guarded like tests/session-broker-core.test.ts — skips without DATABASE_URL.
const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

d("markStaleBrokersOffline (DB)", () => {
  const created: number[] = [];
  let tokenId: number;

  afterAll(async () => {
    const { db } = await import("../server/storage");
    const { brokers, brokerRegistrationTokens } = await import("../shared/schema");
    const { inArray, eq } = await import("drizzle-orm");
    if (created.length) await db.delete(brokers).where(inArray(brokers.id, created));
    if (tokenId) await db.delete(brokerRegistrationTokens).where(eq(brokerRegistrationTokens.id, tokenId));
  });

  it("marks silent + null-lastSeen idle brokers offline, keeps fresh ones and the rows", async () => {
    const { storage } = await import("../server/storage");
    const stamp = Date.now();
    const tok = await storage.createBrokerRegistrationToken({
      name: `reap-tok-${stamp}`, tokenHash: `reap-hash-${stamp}`, createdBy: 1, isRevoked: false, expiresAt: null,
    });
    tokenId = tok.id;

    const stale = await storage.createBroker({
      name: `reap-stale-${stamp}`, tokenId, brokerType: "auth-session",
      url: "http://broker.test", state: "idle", lastSeenAt: new Date(stamp - 60 * 60 * 1000), // 60m ago
    });
    const nullSeen = await storage.createBroker({
      name: `reap-null-${stamp}`, tokenId, brokerType: "auth-session",
      url: "http://broker.test", state: "idle", lastSeenAt: null,
    });
    const fresh = await storage.createBroker({
      name: `reap-fresh-${stamp}`, tokenId, brokerType: "auth-session",
      url: "http://broker.test", state: "idle", lastSeenAt: new Date(stamp),
    });
    created.push(stale.id, nullSeen.id, fresh.id);

    const count = await storage.markStaleBrokersOffline(5);
    expect(count).toBeGreaterThanOrEqual(2);

    expect((await storage.getBroker(stale.id))?.state).toBe("offline");
    expect((await storage.getBroker(nullSeen.id))?.state).toBe("offline");
    expect((await storage.getBroker(fresh.id))?.state).toBe("idle");
    // Rows are kept — never deleted.
    expect(await storage.getBroker(stale.id)).toBeDefined();
  });
});

d("getLiveBrokerTypes (DB)", () => {
  const created: number[] = [];
  let tokenId: number;

  afterAll(async () => {
    const { db } = await import("../server/storage");
    const { brokers, brokerRegistrationTokens } = await import("../shared/schema");
    const { inArray, eq } = await import("drizzle-orm");
    if (created.length) await db.delete(brokers).where(inArray(brokers.id, created));
    if (tokenId) await db.delete(brokerRegistrationTokens).where(eq(brokerRegistrationTokens.id, tokenId));
  });

  it("lists distinct types of live brokers, excludes offline ones", async () => {
    const { storage } = await import("../server/storage");
    const stamp = Date.now();
    const tok = await storage.createBrokerRegistrationToken({
      name: `lt-tok-${stamp}`, tokenHash: `lt-hash-${stamp}`, createdBy: 1, isRevoked: false, expiresAt: null,
    });
    tokenId = tok.id;

    const live = await storage.createBroker({
      name: `lt-live-${stamp}`, tokenId, brokerType: "auth-session",
      url: "http://broker.test", state: "idle", lastSeenAt: new Date(stamp),
    });
    const off = await storage.createBroker({
      name: `lt-off-${stamp}`, tokenId, brokerType: "auth-session",
      url: "http://broker.test", state: "offline", lastSeenAt: new Date(stamp),
    });
    created.push(live.id, off.id);

    const types = await storage.getLiveBrokerTypes();
    expect(types).toContain("auth-session");
  });
});

d("api-key lifecycle (DB)", () => {
  const created: number[] = [];

  afterAll(async () => {
    const { db } = await import("../server/storage");
    const { apiKeys } = await import("../shared/schema");
    const { inArray } = await import("drizzle-orm");
    if (created.length) await db.delete(apiKeys).where(inArray(apiKeys.id, created));
  });

  it("create stamps last_operation=create; revoke stamps revoked_at + operator; status=revoked", async () => {
    const { storage } = await import("../server/storage");
    const stamp = Date.now();
    const key = await storage.createApiKey({
      name: `ak-${stamp}`, keyHash: `ak-hash-${stamp}`, keyPrefix: "vox_live_x", createdBy: 1,
      isRevoked: false, expiresAt: null,
    });
    created.push(key.id);
    expect(key.lastOperation).toBe("create");
    expect(key.lastOperationBy).toBe(1);
    expect(deriveApiKeyStatus(key)).toBe("active");

    await storage.revokeApiKey(key.id, 1);
    const revoked = await storage.getApiKey(key.id);
    expect(revoked?.isRevoked).toBe(true);
    expect(revoked?.revokedAt).toBeTruthy();
    expect(revoked?.lastOperation).toBe("revoke");
    expect(revoked?.lastOperationBy).toBe(1);
    expect(deriveApiKeyStatus(revoked!)).toBe("revoked");
  });

  it("expired key (past expiresAt, not revoked) derives status=expired", async () => {
    const { storage } = await import("../server/storage");
    const stamp = Date.now();
    const key = await storage.createApiKey({
      name: `ak-exp-${stamp}`, keyHash: `ak-exp-hash-${stamp}`, keyPrefix: "vox_live_e", createdBy: 1,
      isRevoked: false, expiresAt: new Date(stamp - 1000),
    });
    created.push(key.id);
    expect(deriveApiKeyStatus(key)).toBe("expired");
  });

  it("delete is soft: is_deleted + deleted_at set, hidden from list, row retained", async () => {
    const { storage } = await import("../server/storage");
    const stamp = Date.now();
    const key = await storage.createApiKey({
      name: `ak-del-${stamp}`, keyHash: `ak-del-hash-${stamp}`, keyPrefix: "vox_live_d", createdBy: 1,
      isRevoked: false, expiresAt: null,
    });
    created.push(key.id);

    await storage.deleteApiKey(key.id, 1);
    const row = await storage.getApiKey(key.id);
    expect(row).toBeDefined();          // row retained (never hard-deleted)
    expect(row?.isDeleted).toBe(true);
    expect(row?.deletedAt).toBeTruthy();
    expect(row?.lastOperation).toBe("delete");
    expect(row?.lastOperationBy).toBe(1);

    const listed = await storage.getApiKeysByUser(1);
    expect(listed.some((k) => k.id === key.id)).toBe(false); // hidden from list
  });
});
