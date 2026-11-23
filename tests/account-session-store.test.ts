import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
await vi.hoisted(async () => {
  if (process.env.DATABASE_URL) {
    const { prepareIsolatedCoreDb } = await import("./helpers/isolated-core-db");
    process.env.DATABASE_URL = await prepareIsolatedCoreDb(process.env.DATABASE_URL, `vox_test_account_sessions_${process.pid}`);
    process.env.CREDENTIAL_ENCRYPTION_KEY = "ab".repeat(32);
  }
});
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Pool, type PoolClient } from "pg";
import { z } from "zod";
import { pool, decryptValue } from "../server/storage";
import { accountSessionBinding, type AccountSessionSource } from "../server/account-session-binding";
import { AccountSessionStore, type AccountSessionAuthority, type AccountSessionCheckpoint, type AuthorizeAccountSession } from "../server/account-session-store";
import { ACCOUNT_STATE_FORMAT, acceptsAccountStorage } from "../shared/account-session-protocol";
import { AccountCheckpointConsumer, newAccountExecutionId } from "../vox_eval_agentd/account-checkpoints";

const d = process.env.DATABASE_URL ? describe : describe.skip;
const stateShape = z.object({
  cookies: z.array(z.object({ name: z.string(), value: z.string(), domain: z.literal(".elevenlabs.io") }).strict()),
  origins: z.array(z.object({ origin: z.literal("https://elevenlabs.io"), localStorage: z.array(z.object({ name: z.string(), value: z.string() }).strict()) }).strict()),
}).strict();
const options = { maxStateBytes: 16_384, maxCheckpointsPerRefresh: 8,
  acceptsState: (_binding: unknown, format: string, state: unknown) => format === "fixture-state-v1" && stateShape.safeParse(state).success };
const store = new AccountSessionStore(pool, options);

function authority(input: { userId?: number; orgId?: number; source?: AccountSessionSource; revision?: string; tenant?: string; execution?: string } = {}): AccountSessionAuthority {
  const scope = input.orgId ? { organizationId: input.orgId } : { userId: input.userId ?? 1 };
  const source = input.source ?? "runtime";
  const row = { ...scope, brokerType: source === "runtime" ? null : "auth-session" };
  return {
    binding: accountSessionBinding({ scope, source, platformId: "elevenlabs", tenantBinding: input.tenant ?? "fixture-tenant",
      email: { ...row, id: 1, name: "EMAIL", encryptedValue: "v1:fixture-email-ciphertext" },
      password: { ...row, id: 2, name: "PASSWORD", encryptedValue: `v1:fixture-password-${input.revision ?? "original"}` } }),
    executionKey: input.execution ?? randomUUID(), validUntil: new Date(Date.now() + 60_000),
  };
}
const allow = (value: AccountSessionAuthority): AuthorizeAccountSession => async () => value;
const checkpoint = (sequence = 1, value = "session-canary-private", checkpointId = `save_${sequence}`): AccountSessionCheckpoint => ({
  checkpointId, sequence, format: "fixture-state-v1",
  state: JSON.stringify({ cookies: [{ name: "session", value, domain: ".elevenlabs.io" }], origins: [] }),
});
const raw = async (key: string) => (await pool.query("SELECT * FROM account_sessions WHERE session_key = $1", [key])).rows[0];
const receipts = async () => (await pool.query("SELECT * FROM account_session_checkpoints ORDER BY committed_at")).rows;

d("account-session foundation: isolated PostgreSQL, two Core stores", () => {
  let otherPool: Pool;
  let otherStore: AccountSessionStore;
  beforeAll(async () => {
    await pool.query("INSERT INTO users(id, username, email) VALUES (1, 'session-owner', 'session-owner@test.local'), (2, 'session-other', 'session-other@test.local')");
    otherPool = new Pool({ connectionString: process.env.DATABASE_URL });
    otherStore = new AccountSessionStore(otherPool, options);
  });
  beforeEach(async () => { await pool.query("TRUNCATE account_sessions CASCADE"); });
  afterEach(() => { vi.unstubAllEnvs(); });
  afterAll(async () => { await otherPool?.end(); await pool.end(); });

  it("round-trips confirmed state encrypted at rest and commits a matching receipt", async () => {
    const auth = authority();
    expect(await store.read(allow(auth))).toBeNull();
    const ticket = (await store.claim(allow(auth), 30))!;
    const cp = checkpoint();
    const saved = await store.save(allow(auth), ticket, cp);
    expect(saved).toMatchObject({ status: "persisted", checkpointId: cp.checkpointId, committedAt: expect.any(Date) });
    const row = await raw(ticket.sessionKey);
    expect(row.encrypted_storage_state).toMatch(/^v1:/);
    expect(JSON.stringify([row, await receipts()])).not.toContain("session-canary-private");
    expect(JSON.parse(decryptValue(row.encrypted_storage_state))).toEqual({ version: 1, sessionKey: ticket.sessionKey, format: cp.format, state: cp.state });
    expect(await otherStore.read(allow(auth))).toEqual({ format: cp.format, state: cp.state });
    expect(await receipts()).toHaveLength(1);
  });

  it.each([
    { userId: 2 }, { orgId: 1 }, { source: "brokered" as const }, { tenant: "another-tenant" }, { revision: "rotated" },
  ])("does not restore a different owner/org/source/tenant/revision: %j", async (patch) => {
    const auth = authority();
    const ticket = (await store.claim(allow(auth), 30))!;
    await store.save(allow(auth), ticket, checkpoint());
    const other = authority(patch);
    expect(await otherStore.read(allow(other))).toBeNull();
    await expect(otherStore.save(allow(other), ticket, checkpoint())).rejects.toMatchObject({ code: "unauthorized" });
    expect(Number((await raw(ticket.sessionKey)).last_sequence)).toBe(1);
  });

  it("reuses state across authorized executions without confusing their refresh ownership", async () => {
    const a = authority();
    const ticket = (await store.claim(allow(a), 30))!;
    await store.save(allow(a), ticket, checkpoint());
    const b = authority();
    expect(await otherStore.read(allow(b))).toEqual({ format: checkpoint().format, state: checkpoint().state });
    expect(await otherStore.claim(allow(b), 30)).toBeNull();
    expect(await otherStore.claim(allow(a), 30)).toEqual(ticket);
  });

  it("returns the state current at the claimed generation after an interleaved newer checkpoint", async () => {
    const a = authority(), b = authority(), c = authority();
    const initial = (await store.claim(allow(a), 30))!;
    await store.save(allow(a), initial, checkpoint(1, "old-token")); await store.release(allow(a), initial);
    let resume!: () => void, entered!: () => void, first = true;
    const paused = new Promise<void>(resolve => { resume = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const waiting = store.claimAndRead(async () => {
      if (first) { first = false; entered(); await paused; }
      return b;
    }, 30);
    await ready;
    try {
      const newer = (await otherStore.claim(allow(c), 30))!;
      await otherStore.save(allow(c), newer, checkpoint(1, "rotated-token")); await otherStore.release(allow(c), newer);
    } finally { resume(); }
    const result = await waiting;
    expect(result.ticket?.generation).toBe(initial.generation + 2);
    expect(result.state?.state).toBe(checkpoint(1, "rotated-token").state);
    expect(await otherStore.claimAndRead(allow(c), 30)).toEqual({ ticket: null, state: result.state });
  });

  it("allows exactly one refresh owner across simultaneous Core stores", async () => {
    const attempts = Array.from({ length: 12 }, (_, i) => (i % 2 ? store : otherStore).claim(allow(authority()), 30));
    const results = await Promise.all(attempts);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await pool.query("SELECT generation FROM account_sessions")).rows).toEqual([{ generation: 1 }]);
  });

  it("fences an expired refresh and its late success/release after a newer claim", async () => {
    const a = authority();
    const first = (await store.claim(allow(a), 30))!;
    await pool.query("UPDATE account_sessions SET refresh_expires_at = clock_timestamp() - interval '1 second'");
    const b = authority();
    const second = (await otherStore.claim(allow(b), 30))!;
    expect(second.generation).toBe(first.generation + 1);
    expect(await otherStore.save(allow(b), second, checkpoint(1, "newer-session"))).toMatchObject({ status: "persisted" });
    expect(await store.save(allow(a), first, checkpoint(1, "stale-session"))).toEqual({ status: "superseded" });
    expect(await store.release(allow(a), first)).toBe(false);
    expect(await store.read(allow(a))).toEqual({ format: checkpoint().format, state: checkpoint(1, "newer-session").state });
  });

  it("never persists an older sequence after a newer one, even if it arrives last", async () => {
    const auth = authority();
    const ticket = (await store.claim(allow(auth), 30))!;
    await otherStore.save(allow(auth), ticket, checkpoint(2, "newer"));
    expect(await store.save(allow(auth), ticket, checkpoint(1, "older"))).toEqual({ status: "superseded" });
    expect(Number((await raw(ticket.sessionKey)).last_sequence)).toBe(2);
    expect(await receipts()).toHaveLength(1);
  });

  it("recovers a lost commit response idempotently without updating the ciphertext again", async () => {
    const auth = authority();
    const ticket = (await store.claim(allow(auth), 30))!;
    const first = await store.save(allow(auth), ticket, checkpoint());
    const ciphertext = (await raw(ticket.sessionKey)).encrypted_storage_state;
    const retry = await otherStore.save(allow(auth), ticket, checkpoint());
    expect(retry).toEqual(first);
    expect((await raw(ticket.sessionKey)).encrypted_storage_state).toBe(ciphertext);
    expect(await receipts()).toHaveLength(1);
  });

  it("persists and retries the full ten-digit engine sequence range", async () => {
    const auth = authority();
    const ticket = (await store.claim(allow(auth), 30))!;
    const cp = checkpoint(9_999_999_999);
    const first = await store.save(allow(auth), ticket, cp);
    expect(first.status).toBe("persisted");
    expect(await otherStore.save(allow(auth), ticket, cp)).toEqual(first);
    expect(Number((await raw(ticket.sessionKey)).last_sequence)).toBe(9_999_999_999);
    await expect(store.save(allow(auth), ticket, checkpoint(10_000_000_000))).rejects.toMatchObject({ code: "invalid-checkpoint" });
  });

  it.skipIf(process.platform !== "linux")("recovers a lost Core receipt through the real locked file consumer without rewriting state", async () => {
    const root = await mkdtemp(join(tmpdir(), "vox-checkpoint-core-test-"));
    try {
      const sessionId = newAccountExecutionId(40112);
      const auth = authority({ execution: sessionId });
      const currentStore = new AccountSessionStore(pool, { ...options,
        acceptsState: (_binding, format, state) => format === ACCOUNT_STATE_FORMAT && acceptsAccountStorage(state,
          { cookieDomains: [".elevenlabs.io"], storageOrigins: ["https://elevenlabs.io"] }) });
      const ticket = (await currentStore.claim(allow(auth), 30))!;
      const storageFile = join(root, "storage.json");
      const sidecar = `${storageFile}.checkpoints`;
      const ready = join(sidecar, "ready", sessionId);
      const snapshots = join(sidecar, "snapshots", sessionId);
      await mkdir(ready, { recursive: true, mode: 0o700 });
      await mkdir(snapshots, { recursive: true, mode: 0o700 });
      await writeFile(join(sidecar, ".writer.lock"), "", { mode: 0o600 });
      const id = "b".repeat(32);
      const state = JSON.stringify({ cookies: [], origins: [{ origin: "https://elevenlabs.io",
        localStorage: [{ name: "session", value: "checkpoint-private-canary" }] }] });
      const snapshotPath = join(snapshots, `${id}.json`);
      const readyPath = join(ready, `0000000001-${id}.json`);
      await writeFile(snapshotPath, state, { mode: 0o600 });
      await writeFile(readyPath, JSON.stringify({ schema: "auth.checkpoint.v3", session_id: sessionId,
        snapshot_id: id, sequence: 1, snapshot: `snapshots/${sessionId}/${id}.json`,
        storage_format: ACCOUNT_STATE_FORMAT, byte_length: Buffer.byteLength(state) }), { mode: 0o600 });
      let calls = 0;
      const consumer = new AccountCheckpointConsumer({ storageFile, sessionId, signal: new AbortController().signal,
        authorized: async () => true,
        acceptsState: value => acceptsAccountStorage(value, { cookieDomains: [".elevenlabs.io"], storageOrigins: ["https://elevenlabs.io"] }),
        deliver: async (record, bytes) => {
          const result = await currentStore.save(allow(auth), ticket, { checkpointId: record.snapshot_id,
            sequence: record.sequence, format: record.storage_format, state: bytes });
          if (++calls === 1) throw new Error("simulated-lost-core-receipt");
          return result.status === "persisted" ? { status: "persisted", sessionId, snapshotId: result.checkpointId } : result;
        } });
      expect((await consumer.poll()).outcomes).toEqual([]);
      const ciphertext = (await raw(ticket.sessionKey)).encrypted_storage_state;
      expect(ciphertext).not.toContain("checkpoint-private-canary");
      expect(await readFile(snapshotPath, "utf8")).toBe(state);
      expect((await consumer.poll()).outcomes).toEqual([{ snapshotId: id, status: "persisted" }]);
      expect((await raw(ticket.sessionKey)).encrypted_storage_state).toBe(ciphertext);
      expect(await receipts()).toHaveLength(1);
      expect(await currentStore.read(allow(auth))).toEqual({ format: ACCOUNT_STATE_FORMAT, state });
      await expect(stat(snapshotPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await stat(readyPath)).isFile()).toBe(true);
      expect((await consumer.poll()).outcomes).toEqual([]); expect(calls).toBe(2);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("recovers when COMMIT succeeds but the Core connection loses its response", async () => {
    const auth = authority();
    const ticket = (await store.claim(allow(auth), 30))!;
    const disconnected = new AccountSessionStore({ connect: async () => {
      const client = await pool.connect();
      return new Proxy(client, { get(target, property) {
        if (property === "query") return async (sql: string, values?: unknown[]) => {
          const result = await target.query(sql, values);
          if (sql === "COMMIT") throw new Error("simulated-lost-commit-response");
          return result;
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      } }) as PoolClient;
    } } as Pick<Pool, "connect">, options);
    await expect(disconnected.save(allow(auth), ticket, checkpoint())).rejects.toThrow("simulated-lost-commit-response");
    expect(await otherStore.save(allow(auth), ticket, checkpoint())).toMatchObject({ status: "persisted" });
    expect(await receipts()).toHaveLength(1);
    expect((await store.read(allow(auth)))?.state).toBe(checkpoint().state);
  });

  it("serializes duplicate uploads from both Core stores into one persisted receipt", async () => {
    const auth = authority();
    const ticket = (await store.claim(allow(auth), 30))!;
    const saved = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      (i % 2 ? store : otherStore).save(allow(auth), ticket, checkpoint())));
    for (const result of saved) expect(result).toEqual(saved[0]);
    expect(saved[0]).toMatchObject({ status: "persisted" });
    expect(await receipts()).toHaveLength(1);
  });

  it("keeps the highest sequence under concurrently reordered deliveries", async () => {
    const auth = authority();
    const ticket = (await store.claim(allow(auth), 30))!;
    await Promise.all([3, 1, 7, 2, 8, 5, 6, 4].map((n, i) =>
      (i % 2 ? store : otherStore).save(allow(auth), ticket, checkpoint(n, `state-${n}`))));
    expect(Number((await raw(ticket.sessionKey)).last_sequence)).toBe(8);
    expect((await store.read(allow(auth)))?.state).toBe(checkpoint(8, "state-8").state);
  });

  it("keeps an old committed receipt without replaying its state over a newer session", async () => {
    const auth = authority();
    const ticket = (await store.claim(allow(auth), 30))!;
    const first = await store.save(allow(auth), ticket, checkpoint(1, "first"));
    await otherStore.save(allow(auth), ticket, checkpoint(2, "second"));
    expect(await store.save(allow(auth), ticket, checkpoint(1, "first"))).toEqual(first);
    expect((await store.read(allow(auth)))?.state).toBe(checkpoint(2, "second").state);
    expect(await receipts()).toHaveLength(2);
  });

  it("rejects changed contents or sequence under a committed ID and reused sequence under another ID", async () => {
    const auth = authority();
    const ticket = (await store.claim(allow(auth), 30))!;
    await store.save(allow(auth), ticket, checkpoint());
    for (const cp of [checkpoint(1, "different"), checkpoint(2, "session-canary-private", "save_1"), checkpoint(1, "different", "another_id")]) {
      expect(await store.save(allow(auth), ticket, cp)).toEqual({ status: "rejected", reason: "conflicting-checkpoint" });
    }
    expect(await receipts()).toHaveLength(1);
  });

  it("rolls back the session update when receipt insertion fails", async () => {
    const auth = authority();
    const ticket = (await store.claim(allow(auth), 30))!;
    await store.save(allow(auth), ticket, checkpoint(1, "last-good"));
    const before = await raw(ticket.sessionKey);
    await pool.query("ALTER TABLE account_session_checkpoints ADD CONSTRAINT account_session_test_failure CHECK (checkpoint_id <> 'fail_receipt')");
    try {
      await expect(store.save(allow(auth), ticket, checkpoint(2, "must-not-commit", "fail_receipt"))).rejects.toThrow();
      expect((await raw(ticket.sessionKey)).encrypted_storage_state).toBe(before.encrypted_storage_state);
      expect(Number((await raw(ticket.sessionKey)).last_sequence)).toBe(1);
      expect(await receipts()).toHaveLength(1);
    } finally { await pool.query("ALTER TABLE account_session_checkpoints DROP CONSTRAINT account_session_test_failure"); }
  });

  it("rolls back state and receipt if authority is revoked before commit", async () => {
    const auth = authority();
    const ticket = (await store.claim(allow(auth), 30))!;
    const revoked = vi.fn<AuthorizeAccountSession>().mockResolvedValueOnce(auth).mockResolvedValueOnce(null);
    await expect(store.save(revoked, ticket, checkpoint())).rejects.toMatchObject({ code: "unauthorized" });
    expect((await raw(ticket.sessionKey)).encrypted_storage_state).toBeNull();
    expect(await receipts()).toHaveLength(0);
  });

  it("rejects a credential revision changed before commit", async () => {
    const auth = authority();
    const ticket = (await store.claim(allow(auth), 30))!;
    const changed = vi.fn<AuthorizeAccountSession>().mockResolvedValueOnce(auth)
      .mockResolvedValueOnce(authority({ revision: "rotated", execution: auth.executionKey }));
    await expect(store.save(changed, ticket, checkpoint())).rejects.toMatchObject({ code: "unauthorized" });
    expect(await receipts()).toHaveLength(0);
  });

  it("requires live authorization for every operation, including reads and receipt retries", async () => {
    const auth = authority();
    const ticket = (await store.claim(allow(auth), 30))!;
    await store.save(allow(auth), ticket, checkpoint());
    const denied: AuthorizeAccountSession = async () => null;
    for (const operation of [() => store.read(denied), () => store.claim(denied, 30),
      () => store.save(denied, ticket, checkpoint()), () => store.release(denied, ticket)]) {
      await expect(operation()).rejects.toMatchObject({ code: "unauthorized" });
    }
    expect(await receipts()).toHaveLength(1);
  });

  it("bounds refresh expiry by operation authority and rejects expired operations", async () => {
    const auth = authority();
    auth.validUntil = new Date(Date.now() + 20_000);
    const ticket = (await store.claim(allow(auth), 60))!;
    expect(ticket.expiresAt.getTime()).toBeLessThanOrEqual(auth.validUntil.getTime());
    const expired = { ...auth, validUntil: new Date(0) };
    await expect(store.save(allow(expired), ticket, checkpoint())).rejects.toMatchObject({ code: "unauthorized" });
    await pool.query("UPDATE account_sessions SET refresh_expires_at = clock_timestamp() - interval '1 second'");
    expect(await store.save(allow(auth), ticket, checkpoint())).toEqual({ status: "rejected", reason: "refresh-expired" });
  });

  it("preserves last good state when a later refresh fails or is released", async () => {
    const auth = authority();
    const first = (await store.claim(allow(auth), 30))!;
    await store.save(allow(auth), first, checkpoint());
    await store.release(allow(auth), first);
    const next = authority();
    const second = (await otherStore.claim(allow(next), 30))!;
    await expect(otherStore.save(allow(next), second, { ...checkpoint(), state: "{invalid" })).rejects.toMatchObject({ code: "invalid-state" });
    expect(await otherStore.release(allow(next), second)).toBe(true);
    expect((await store.read(allow(auth)))?.state).toBe(checkpoint().state);
  });

  it("fails safely on ciphertext corruption/transplant without erasing either cached row", async () => {
    const a = authority();
    const ticket = (await store.claim(allow(a), 30))!;
    await store.save(allow(a), ticket, checkpoint());
    const ciphertext = (await raw(ticket.sessionKey)).encrypted_storage_state;
    const b = authority({ userId: 2 });
    const other = (await store.claim(allow(b), 30))!;
    await pool.query("UPDATE account_sessions SET encrypted_storage_state = $2, storage_format = $3 WHERE session_key = $1", [other.sessionKey, ciphertext, checkpoint().format]);
    await expect(store.read(allow(b))).rejects.toMatchObject({ code: "state-unavailable" });
    expect((await raw(other.sessionKey)).encrypted_storage_state).toBe(ciphertext);
    await pool.query("UPDATE account_sessions SET encrypted_storage_state = 'v1:corrupt' WHERE session_key = $1", [ticket.sessionKey]);
    await expect(store.read(allow(a))).rejects.toMatchObject({ code: "state-unavailable" });
    expect((await raw(ticket.sessionKey)).encrypted_storage_state).toBe("v1:corrupt");
  });

  it("enforces size, format and provider policy without persisting arbitrary Runtime data", async () => {
    const auth = authority();
    const ticket = (await store.claim(allow(auth), 30))!;
    const invalid = [
      { ...checkpoint(), state: "[]" }, { ...checkpoint(), state: "null" },
      { ...checkpoint(), state: '{"cookies":[],"cookies":[],"origins":[]}' },
      { ...checkpoint(), state: JSON.stringify({ API_KEY: "must-not-persist" }) },
      { ...checkpoint(), state: checkpoint().state.replace(".elevenlabs.io", ".unapproved.test") },
      { ...checkpoint(), format: "unqualified-format" }, checkpoint(1, "x".repeat(options.maxStateBytes)),
    ];
    for (const cp of invalid) await expect(store.save(allow(auth), ticket, cp)).rejects.toMatchObject({ code: "invalid-state" });
    expect(await receipts()).toHaveLength(0);
    expect((await raw(ticket.sessionKey)).encrypted_storage_state).toBeNull();
  });

  it("caps new checkpoint receipts without rejecting a duplicate persisted acknowledgment", async () => {
    const limited = new AccountSessionStore(pool, { ...options, maxCheckpointsPerRefresh: 2 });
    const auth = authority();
    const ticket = (await limited.claim(allow(auth), 30))!;
    const first = await limited.save(allow(auth), ticket, checkpoint(1));
    await limited.save(allow(auth), ticket, checkpoint(2));
    expect(await limited.save(allow(auth), ticket, checkpoint(3))).toEqual({ status: "rejected", reason: "capacity" });
    expect(await limited.save(allow(auth), ticket, checkpoint(1))).toEqual(first);
    expect(Number((await raw(ticket.sessionKey)).last_sequence)).toBe(2);
    expect(await receipts()).toHaveLength(2);
  });

  it("fails early without an encryption key, even if the process previously cached one", async () => {
    const auth = authority();
    const ticket = (await store.claim(allow(auth), 30))!;
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", "");
    await expect(store.save(allow(auth), ticket, checkpoint())).rejects.toMatchObject({ code: "state-unavailable" });
    expect(await receipts()).toHaveLength(0);
  });

  it("enforces database scope/source invariants independently of callers", async () => {
    const auth = authority();
    const ticket = (await store.claim(allow(auth), 30))!;
    await expect(pool.query("UPDATE account_sessions SET organization_id = 1 WHERE session_key = $1", [ticket.sessionKey])).rejects.toThrow();
    await expect(pool.query("UPDATE account_sessions SET source = 'arbitrary' WHERE session_key = $1", [ticket.sessionKey])).rejects.toThrow();
  });

  it("expires inactive personal and orphaned org revisions, cascading their receipts without a key", async () => {
    for (const auth of [authority(), authority({ orgId: 91 }), authority({ revision: "old" })]) {
      const ticket = (await store.claim(allow(auth), 30))!;
      await store.save(allow(auth), ticket, checkpoint());
      await store.release(allow(auth), ticket);
    }
    await pool.query("UPDATE account_sessions SET updated_at=clock_timestamp()-interval '31 days'");
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", "");
    expect(await store.pruneExpired()).toEqual({ sessions: 3, checkpoints: 0 });
    expect((await pool.query("SELECT * FROM account_sessions")).rows).toHaveLength(0);
    expect(await receipts()).toHaveLength(0);
  });

  it("refreshes inactivity only on an authorized, validated read", async () => {
    const auth = authority(), ticket = (await store.claim(allow(auth), 30))!;
    await store.save(allow(auth), ticket, checkpoint()); await store.release(allow(auth), ticket);
    await pool.query("UPDATE account_sessions SET updated_at=clock_timestamp()-interval '31 days'");
    const before = (await raw(ticket.sessionKey)).updated_at;
    await expect(store.read(async () => null)).rejects.toMatchObject({ code: "unauthorized" });
    expect((await raw(ticket.sessionKey)).updated_at).toEqual(before);
    expect(await store.read(allow(auth))).not.toBeNull();
    expect((await raw(ticket.sessionKey)).updated_at.getTime()).toBeGreaterThan(Date.now() - 5000);
    expect(await store.pruneExpired()).toEqual({ sessions: 0, checkpoints: 0 });
  });

  it("preserves recent sessions and active refreshes but expires an abandoned refresh", async () => {
    const recent = authority(), active = authority({ revision: "active" }), expired = authority({ revision: "expired" });
    for (const auth of [recent, active, expired]) await store.claim(allow(auth), 30);
    await pool.query("UPDATE account_sessions SET updated_at=clock_timestamp()-interval '31 days' WHERE session_key <> $1", [recent.binding.sessionKey]);
    await pool.query("UPDATE account_sessions SET refresh_expires_at=clock_timestamp()-interval '1 second' WHERE session_key=$1", [expired.binding.sessionKey]);
    expect(await store.pruneExpired()).toEqual({ sessions: 1, checkpoints: 0 });
    expect(await raw(recent.binding.sessionKey)).toBeDefined();
    expect(await raw(active.binding.sessionKey)).toBeDefined();
    expect(await raw(expired.binding.sessionKey)).toBeUndefined();
  });

  it("prunes old receipts independently of an actively used canonical session", async () => {
    const auth = authority(), ticket = (await store.claim(allow(auth), 30))!;
    await store.save(allow(auth), ticket, checkpoint(1)); await store.save(allow(auth), ticket, checkpoint(2));
    await pool.query("UPDATE account_session_checkpoints SET committed_at=clock_timestamp()-interval '31 days' WHERE sequence=1");
    expect(await store.pruneExpired()).toEqual({ sessions: 0, checkpoints: 1 });
    expect((await receipts()).map(row => Number(row.sequence))).toEqual([2]);
    expect(await store.read(allow(auth))).not.toBeNull();
  });

  it("bounds deletion batches and safely shares sweeping between two Core stores", async () => {
    for (let i = 0; i < 6; i++) {
      const auth = authority({ revision: String(i) }), ticket = (await store.claim(allow(auth), 30))!;
      await store.save(allow(auth), ticket, checkpoint()); await store.release(allow(auth), ticket);
    }
    await pool.query("UPDATE account_sessions SET updated_at=clock_timestamp()-interval '31 days'");
    await pool.query("UPDATE account_session_checkpoints SET committed_at=clock_timestamp()-interval '31 days'");
    const swept = await Promise.all([store.pruneExpired(2), otherStore.pruneExpired(2)]);
    expect(swept.every(result => result.sessions <= 2 && result.checkpoints <= 2)).toBe(true);
    expect(swept.reduce((n, result) => n + result.sessions, 0)).toBe(4);
    expect((await pool.query("SELECT * FROM account_sessions")).rows).toHaveLength(2);
    await store.pruneExpired(2);
    expect(await receipts()).toHaveLength(0);
  });

  it("skips a locked active session instead of blocking another Core's sweep", async () => {
    const auth = authority(), ticket = (await store.claim(allow(auth), 30))!;
    await store.release(allow(auth), ticket);
    await pool.query("UPDATE account_sessions SET updated_at=clock_timestamp()-interval '31 days'");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT session_key FROM account_sessions FOR UPDATE");
      expect(await otherStore.pruneExpired()).toEqual({ sessions: 0, checkpoints: 0 });
    } finally { await client.query("ROLLBACK"); client.release(); }
    expect(await store.pruneExpired()).toEqual({ sessions: 1, checkpoints: 0 });
  });

  it("protects a restored session from retention between its SELECT and inactivity touch", async () => {
    const auth = authority(), ticket = (await store.claim(allow(auth), 30))!;
    await store.save(allow(auth), ticket, checkpoint()); await store.release(allow(auth), ticket);
    await pool.query("UPDATE account_sessions SET updated_at=clock_timestamp()-interval '31 days'");
    const client = await pool.connect(), original = client.query.bind(client);
    let release!: () => void, selected!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { selected = resolve; });
    const query = vi.spyOn(client, "query").mockImplementation((...args: unknown[]) => {
      const result = Reflect.apply(original, client, args);
      if (typeof args[0] === "string" && args[0].startsWith("SELECT * FROM account_sessions")) {
        return result.then(async (rows: unknown) => { selected(); await blocked; return rows; });
      }
      return result;
    });
    const reading = new AccountSessionStore({ connect: async () => client } as Pick<Pool, "connect">, options).read(allow(auth));
    try {
      await ready;
      expect(await otherStore.pruneExpired()).toEqual({ sessions: 0, checkpoints: 0 });
    } finally { release(); await reading; query.mockRestore(); }
    expect(await raw(ticket.sessionKey)).toBeDefined();
    expect(await store.pruneExpired()).toEqual({ sessions: 0, checkpoints: 0 });
  });

  it.each([0, -1, 1001, 1.5, NaN])("rejects an invalid retention batch limit: %s", async limit => {
    await expect(store.pruneExpired(limit)).rejects.toMatchObject({ code: "invalid-checkpoint" });
  });
});
