import { describe, it, expect, afterAll } from "vitest";
import { storage, db } from "../server/storage";
import { webSessions } from "../shared/schema";
import { eq, sql, like } from "drizzle-orm";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

// Each test uses a unique platformId so runs never collide.
const pid = (tag: string) => `test-${tag}-${Date.now()}`;

d("web_sessions store", () => {
  // Belt-and-suspenders: each test already deletes its own row(s), but a
  // failed assertion mid-test skips that cleanup and leaks a row. Sweep
  // everything matching our test-data naming convention so runs don't
  // accumulate orphans.
  afterAll(async () => {
    if (hasDb) await db.delete(webSessions).where(like(webSessions.platformId, "test-%"));
  });


  it("claim → ready → getWebSession round-trip", async () => {
    const platformId = pid("rt");
    const claimed = await storage.claimWebSessionMint({ userId: 1 }, platformId, 180, 300);
    expect(claimed).toBeDefined();
    expect(claimed!.status).toBe("minting");

    const stored = await storage.storeWebSessionReady(claimed!.id, "enc-blob", 12, claimed!.mintStartedAt!);
    expect(stored).toBe(true);
    const got = await storage.getWebSession({ userId: 1 }, platformId);
    expect(got?.status).toBe("ready");
    expect(got?.encryptedStorageState).toBe("enc-blob");
    expect(got!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 11 * 3600_000);
    await db.delete(webSessions).where(eq(webSessions.id, claimed!.id));
  });

  it("fractional TTL hours does not throw (make_interval secs)", async () => {
    const platformId = pid("frac-ttl");
    const claimed = await storage.claimWebSessionMint({ userId: 1 }, platformId, 180, 300);
    expect(claimed).toBeDefined();
    const stored = await storage.storeWebSessionReady(claimed!.id, "enc", 0.5, claimed!.mintStartedAt!);
    expect(stored).toBe(true);
    const got = await storage.getWebSession({ userId: 1 }, platformId);
    // 0.5h = 1800s, allow slack for test execution time.
    const deltaMs = got!.expiresAt!.getTime() - Date.now();
    expect(deltaMs).toBeGreaterThan(1700 * 1000);
    expect(deltaMs).toBeLessThan(1900 * 1000);
    await db.delete(webSessions).where(eq(webSessions.id, claimed!.id));
  });

  it("single-flight: second concurrent claim loses; failed is reclaimable; fresh-ready blocks re-claim", async () => {
    const platformId = pid("sf");
    const first = await storage.claimWebSessionMint({ userId: 1 }, platformId, 180, 300);
    expect(first).toBeDefined();
    // Second claim while first is minting (not stale) → loses.
    const second = await storage.claimWebSessionMint({ userId: 1 }, platformId, 180, 300);
    expect(second).toBeUndefined();
    // Failed (with correct fence) is immediately reclaimable.
    const failed = await storage.markWebSessionFailed(first!.id, "boom", first!.mintStartedAt!);
    expect(failed).toBe(true);
    const third = await storage.claimWebSessionMint({ userId: 1 }, platformId, 180, 300);
    expect(third).toBeDefined();
    // Fresh-ready blocks a re-claim.
    const readied = await storage.storeWebSessionReady(third!.id, "enc", 12, third!.mintStartedAt!);
    expect(readied).toBe(true);
    const fourth = await storage.claimWebSessionMint({ userId: 1 }, platformId, 180, 300);
    expect(fourth).toBeUndefined();
    await db.delete(webSessions).where(eq(webSessions.id, first!.id));
  });

  it("stale mint is reclaimable (dead-Core recovery)", async () => {
    const platformId = pid("stale");
    const first = await storage.claimWebSessionMint({ userId: 1 }, platformId, 180, 300);
    // staleMintSeconds=0 → the just-started mint is already 'stale'
    const reclaim = await storage.claimWebSessionMint({ userId: 1 }, platformId, 0, 300);
    expect(reclaim).toBeDefined();
    await db.delete(webSessions).where(eq(webSessions.id, first!.id));
  });

  it("org scope and user scope with same platformId are distinct rows", async () => {
    const platformId = pid("scope");
    const u = await storage.claimWebSessionMint({ userId: 1 }, platformId, 180, 300);
    const o = await storage.claimWebSessionMint({ organizationId: 1 }, platformId, 180, 300);
    expect(u).toBeDefined();
    expect(o).toBeDefined();
    expect(u!.id).not.toBe(o!.id);
    await db.delete(webSessions).where(eq(webSessions.id, u!.id));
    await db.delete(webSessions).where(eq(webSessions.id, o!.id));
  });

  it("concurrent contention: exactly one of 8 simultaneous claims wins", async () => {
    const platformId = pid("contend");
    const results = await Promise.all(
      Array.from({ length: 8 }, () => storage.claimWebSessionMint({ userId: 1 }, platformId, 180, 300)),
    );
    const defined = results.filter((r) => r !== undefined);
    const undef = results.filter((r) => r === undefined);
    expect(defined.length).toBe(1);
    expect(undef.length).toBe(7);
    await db.delete(webSessions).where(eq(webSessions.id, defined[0]!.id));
  });

  it("fencing token: a superseded minter's late write is a no-op; the reclaiming winner's write sticks", async () => {
    const platformId = pid("fence");
    // A claims.
    const aRow = await storage.claimWebSessionMint({ userId: 1 }, platformId, 180, 300);
    expect(aRow).toBeDefined();
    // The two read paths (raw-query claim result vs. typed getWebSession)
    // must agree on the exact instant — this is what breaks under a non-UTC
    // node TZ if rowToWebSession's raw-string parsing isn't forced to UTC.
    const aViaGet = await storage.getWebSession({ userId: 1 }, platformId);
    expect(aViaGet!.mintStartedAt!.getTime()).toBe(aRow!.mintStartedAt!.getTime());
    // B stale-reclaims (staleMintSeconds=0 makes A's mint immediately stale).
    // Same row (same scope+platformId), but mint_started_at is bumped to NOW().
    const bRow = await storage.claimWebSessionMint({ userId: 1 }, platformId, 0, 300);
    expect(bRow).toBeDefined();
    expect(bRow!.id).toBe(aRow!.id);
    expect(bRow!.mintStartedAt!.getTime()).not.toBe(aRow!.mintStartedAt!.getTime());

    // A's late failure report, using A's ORIGINAL fence, must be a no-op:
    // B's claim (status='minting', mint_started_at=B's fence) must survive.
    const aLateFail = await storage.markWebSessionFailed(aRow!.id, "late loser", aRow!.mintStartedAt!);
    expect(aLateFail).toBe(false);
    const stillMinting = await storage.getWebSession({ userId: 1 }, platformId);
    expect(stillMinting?.status).toBe("minting");

    // B's own completion, using B's fence, succeeds normally.
    const bReady = await storage.storeWebSessionReady(bRow!.id, "enc", 12, bRow!.mintStartedAt!);
    expect(bReady).toBe(true);
    const readyRow = await storage.getWebSession({ userId: 1 }, platformId);
    expect(readyRow?.status).toBe("ready");

    await db.delete(webSessions).where(eq(webSessions.id, aRow!.id));
  });

  it("markWebSessionFailed clears expires_at (no stale future expiry on a failed row)", async () => {
    const platformId = pid("failed-expiry");
    const claimed = await storage.claimWebSessionMint({ userId: 1 }, platformId, 180, 300);
    expect(claimed).toBeDefined();
    const failed = await storage.markWebSessionFailed(claimed!.id, "boom", claimed!.mintStartedAt!);
    expect(failed).toBe(true);
    const got = await storage.getWebSession({ userId: 1 }, platformId);
    expect(got?.status).toBe("failed");
    expect(got?.expiresAt).toBeNull();
    await db.delete(webSessions).where(eq(webSessions.id, claimed!.id));
  });

  it("DB-level XOR: a row with both user_id and organization_id set is rejected", async () => {
    const platformId = pid("xor");
    await expect(
      db.execute(sql`
        INSERT INTO web_sessions (user_id, organization_id, platform_id, status, mint_started_at)
        VALUES (1, 1, ${platformId}, 'minting', NOW())`),
    ).rejects.toThrow();
  });

  it("DB-level XOR: a row with neither user_id nor organization_id set is rejected", async () => {
    const platformId = pid("xor-neither");
    await expect(
      db.execute(sql`
        INSERT INTO web_sessions (user_id, organization_id, platform_id, status, mint_started_at)
        VALUES (NULL, NULL, ${platformId}, 'minting', NOW())`),
    ).rejects.toThrow();
  });
});
