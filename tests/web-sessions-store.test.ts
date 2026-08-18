import { describe, it, expect } from "vitest";
import { storage, db } from "../server/storage";
import { webSessions } from "../shared/schema";
import { eq } from "drizzle-orm";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

// Each test uses a unique platformId so runs never collide.
const pid = (tag: string) => `test-${tag}-${Date.now()}`;

d("web_sessions store", () => {
  it("claim → ready → getWebSession round-trip", async () => {
    const platformId = pid("rt");
    const claimed = await storage.claimWebSessionMint({ userId: 1 }, platformId, 180, 300);
    expect(claimed).toBeDefined();
    expect(claimed!.status).toBe("minting");

    await storage.storeWebSessionReady(claimed!.id, "enc-blob", 12);
    const got = await storage.getWebSession({ userId: 1 }, platformId);
    expect(got?.status).toBe("ready");
    expect(got?.encryptedStorageState).toBe("enc-blob");
    expect(got!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 11 * 3600_000);
    await db.delete(webSessions).where(eq(webSessions.id, claimed!.id));
  });

  it("single-flight: second concurrent claim loses; fresh-ready blocks re-claim; failed is reclaimable", async () => {
    const platformId = pid("sf");
    const first = await storage.claimWebSessionMint({ userId: 1 }, platformId, 180, 300);
    expect(first).toBeDefined();
    // Second claim while first is minting (not stale) → loses.
    const second = await storage.claimWebSessionMint({ userId: 1 }, platformId, 180, 300);
    expect(second).toBeUndefined();
    // Fresh-ready blocks a re-claim.
    await storage.storeWebSessionReady(first!.id, "enc", 12);
    const third = await storage.claimWebSessionMint({ userId: 1 }, platformId, 180, 300);
    expect(third).toBeUndefined();
    // Failed is immediately reclaimable.
    await storage.markWebSessionFailed(first!.id, "boom");
    const fourth = await storage.claimWebSessionMint({ userId: 1 }, platformId, 180, 300);
    expect(fourth).toBeDefined();
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
});
