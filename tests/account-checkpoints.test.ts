import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { AccountCheckpointConsumer, newAccountExecutionId, type CheckpointDelivery } from "../vox_eval_agentd/account-checkpoints";
import { ACCOUNT_CHECKPOINT_LIMITS, ACCOUNT_STATE_FORMAT, acceptsAccountStorage, type AccountCheckpointRecord } from "../shared/account-session-protocol";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const linux = process.platform === "linux" ? describe : describe.skip;
const state = JSON.stringify({ cookies: [], origins: [{ origin: "https://fixture.test", localStorage: [{ name: "session", value: "private-canary-\u00e9" }] }] });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vox-checkpoints-test-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const sessionId = newAccountExecutionId(40112);
  const storageFile = join(root, "storage.json");
  const sidecar = `${storageFile}.checkpoints`;
  const snapshotDir = join(sidecar, "snapshots", sessionId);
  const readyDir = join(sidecar, "ready", sessionId);
  await mkdir(snapshotDir, { recursive: true, mode: 0o700 });
  await mkdir(readyDir, { recursive: true, mode: 0o700 });
  const lockFile = join(sidecar, ".writer.lock");
  await writeFile(lockFile, "", { mode: 0o600 });
  await writeFile(storageFile, "not-the-checkpoint", { mode: 0o600 });
  let now = 0;
  let permitted = true;
  const controller = new AbortController();
  const deliver = vi.fn(async (record: AccountCheckpointRecord, _state: string, _signal: AbortSignal): Promise<CheckpointDelivery> =>
    ({ status: "persisted", sessionId: record.session_id, snapshotId: record.snapshot_id }));
  const consumer = (duringValidation?: () => void) => new AccountCheckpointConsumer({ storageFile, sessionId, signal: controller.signal,
    authorized: async () => permitted, clock: () => now,
    acceptsState: value => { duringValidation?.(); return acceptsAccountStorage(value, { cookieDomains: [], storageOrigins: ["https://fixture.test"] }); }, deliver });
  async function publish(sequence = 1, text = state, patch: Record<string, unknown> = {}) {
    const id = randomBytes(16).toString("hex");
    const snapshot = join(snapshotDir, `${id}.json`);
    const filename = `${String(sequence).padStart(10, "0")}-${id}.json`;
    const ready = join(readyDir, filename);
    const record = { schema: "auth.checkpoint.v3", session_id: sessionId, snapshot_id: id, sequence,
      snapshot: `snapshots/${sessionId}/${id}.json`, storage_format: ACCOUNT_STATE_FORMAT,
      byte_length: Buffer.byteLength(text), ...patch };
    await writeFile(snapshot, text, { flag: "wx", mode: 0o600 });
    await writeFile(ready, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    return { id, snapshot, ready, record };
  }
  async function holdWriter() {
    const child = spawn("flock", ["--exclusive", lockFile, process.execPath, "-e",
      'process.stdout.write("locked");process.stdin.resume();process.stdin.on("end",()=>process.exit(0))'], { stdio: ["pipe", "pipe", "pipe"] });
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    const release = async () => { child.stdin.end(); await exited; };
    cleanups.push(release);
    await new Promise<void>((resolve, reject) => {
      child.stdout.once("data", () => resolve()); child.once("error", reject);
      child.once("exit", code => { if (code) reject(new Error("Could not hold test writer lock")); });
    });
    return release;
  }
  return { root, storageFile, sidecar, snapshotDir, readyDir, sessionId, lockFile, deliver, consumer, publish, holdWriter,
    controller, advance: (ms: number) => { now += ms; }, revoke: () => { permitted = false; } };
}

linux("private immutable checkpoint consumer", () => {
  it("copies exact snapshot bytes, releases the shared lock before upload, and retains ready records", async () => {
    const f = await fixture(); const cp = await f.publish(); const consumer = f.consumer();
    f.deliver.mockImplementation(async record => {
      expect(spawnSync("flock", ["--exclusive", "--nonblock", f.lockFile, "true"]).status).toBe(0);
      return { status: "persisted", sessionId: record.session_id, snapshotId: record.snapshot_id };
    });
    expect(await consumer.poll()).toEqual({ status: "scanned", outcomes: [{ snapshotId: cp.id, status: "persisted" }] });
    expect(f.deliver.mock.calls[0][1]).toBe(state);
    await expect(stat(cp.snapshot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(cp.ready, "utf8")).toBe(JSON.stringify(cp.record));
    expect(await readFile(f.storageFile, "utf8")).toBe("not-the-checkpoint");
    expect(await consumer.poll()).toEqual({ status: "scanned", outcomes: [] });
    expect(f.deliver).toHaveBeenCalledTimes(1);
  });

  it("defers without reading two-link publication intermediates while the writer holds its lock", async () => {
    const f = await fixture(); const cp = await f.publish(); const release = await f.holdWriter();
    await link(cp.snapshot, join(f.root, "publication-temporary"));
    expect(await f.consumer().poll()).toEqual({ status: "busy", outcomes: [] });
    expect(f.deliver).not.toHaveBeenCalled(); await release();
  });

  it("holds an actual shared lock throughout validation/copy, excluding a concurrent writer", async () => {
    const f = await fixture(); await f.publish();
    const checked = vi.fn(() => {
      expect(spawnSync("flock", ["--exclusive", "--nonblock", "--conflict-exit-code", "75", f.lockFile, "true"]).status).toBe(75);
    });
    expect((await f.consumer(checked).poll()).outcomes[0].status).toBe("persisted"); expect(checked).toHaveBeenCalledTimes(1);
  });

  it("does not fall back to unlocked reads when the lock helper is unavailable", async () => {
    const f = await fixture(); await f.publish(); vi.stubEnv("PATH", "/nonexistent-vox-test-path");
    expect((await f.consumer().poll()).status).toBe("unavailable"); expect(f.deliver).not.toHaveBeenCalled();
  });

  it("handles a missing sidecar without creating directories or guessing a default auth path", async () => {
    const f = await fixture(); await rm(f.sidecar, { recursive: true });
    expect(await f.consumer().poll()).toEqual({ status: "scanned", outcomes: [] });
    await expect(stat(f.sidecar)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("ignores orphans and does not substitute the mutable working file for a missing snapshot", async () => {
    const f = await fixture(); await writeFile(join(f.snapshotDir, "orphan.json"), state, { mode: 0o600 });
    await writeFile(join(f.readyDir, ".publication-temporary"), "partial-record", { mode: 0o600 });
    expect(await f.consumer().poll()).toEqual({ status: "scanned", outcomes: [] });
    const cp = await f.publish(); await rm(cp.snapshot);
    expect((await f.consumer().poll()).status).toBe("unavailable"); expect(f.deliver).not.toHaveBeenCalled();
  });

  it.each(["snapshot-symlink", "snapshot-hardlink", "snapshot-mode", "snapshot-directory", "ready-symlink", "sidecar-symlink", "root-mode"])("rejects unsafe filesystem authority: %s", async attack => {
    const f = await fixture(); const cp = await f.publish();
    if (attack === "snapshot-symlink") { await rm(cp.snapshot); await symlink(f.storageFile, cp.snapshot); }
    if (attack === "snapshot-hardlink") await link(cp.snapshot, join(f.root, "extra-link"));
    if (attack === "snapshot-mode") await chmod(cp.snapshot, 0o644);
    if (attack === "snapshot-directory") { await rm(cp.snapshot); await mkdir(cp.snapshot, { mode: 0o700 }); }
    if (attack === "ready-symlink") { await rm(cp.ready); await symlink(f.storageFile, cp.ready); }
    if (attack === "sidecar-symlink") { await rm(f.sidecar, { recursive: true }); await symlink(f.root, f.sidecar); }
    if (attack === "root-mode") await chmod(f.root, 0o755);
    expect((await f.consumer().poll()).status).toBe("unavailable"); expect(f.deliver).not.toHaveBeenCalled();
  });

  it.each([
    { session_id: "stale-session" }, { setup_id: "removed" }, { snapshot: "../../storage.json" }, { byte_length: 1 },
  ])("rejects malformed records before upload: %j", async patch => {
    const f = await fixture(); await f.publish(1, state, patch);
    expect((await f.consumer().poll()).status).toBe("unavailable"); expect(f.deliver).not.toHaveBeenCalled();
  });

  it("rejects malformed UTF-8, duplicate state keys, unsupported storage and scope escapes", async () => {
    for (const text of ['{"cookies":[],"cookies":[],"origins":[]}', '{"cookies":[],"origins":[],"indexedDB":[]}',
      state.replace("https://fixture.test", "https://unapproved.test")]) {
      const f = await fixture(); await f.publish(1, text);
      expect((await f.consumer().poll()).status).toBe("unavailable"); expect(f.deliver).not.toHaveBeenCalled();
    }
    const f = await fixture(); const cp = await f.publish();
    await writeFile(cp.snapshot, Buffer.from([0xff]));
    expect((await f.consumer().poll()).status).toBe("unavailable"); expect(f.deliver).not.toHaveBeenCalled();
  });

  it.each(["snapshot-count", "snapshot-bytes", "ready-count", "record-bytes"])("enforces the %s bound before any upload", async limit => {
    const f = await fixture();
    if (limit === "snapshot-count") for (let i = 1; i <= 33; i++) await f.publish(i);
    if (limit === "snapshot-bytes") {
      const large = state.replace("private-canary-\u00e9", "x".repeat(1_900_000));
      for (let i = 1; i <= 9; i++) await f.publish(i, large);
    }
    if (limit === "ready-count") {
      for (let i = 0; i <= ACCOUNT_CHECKPOINT_LIMITS.readyRecords; i++) {
        await writeFile(join(f.readyDir, `orphan-${i}`), "", { mode: 0o600 });
      }
    }
    if (limit === "record-bytes") {
      const cp = await f.publish(); await writeFile(cp.ready, " ".repeat(ACCOUNT_CHECKPOINT_LIMITS.recordBytes + 1));
    }
    expect((await f.consumer().poll()).status).toBe("unavailable"); expect(f.deliver).not.toHaveBeenCalled();
  });

  it("retries snapshot cleanup after a writer temporarily blocks reclamation", async () => {
    const f = await fixture(); const cp = await f.publish(); const consumer = f.consumer();
    let release: (() => Promise<void>) | undefined;
    f.deliver.mockImplementation(async record => {
      release = await f.holdWriter();
      return { status: "persisted", sessionId: record.session_id, snapshotId: record.snapshot_id };
    });
    expect((await consumer.poll()).outcomes).toEqual([{ snapshotId: cp.id, status: "persisted" }]);
    expect(await readFile(cp.snapshot, "utf8")).toBe(state);
    await release!(); await consumer.poll();
    await expect(stat(cp.snapshot)).rejects.toMatchObject({ code: "ENOENT" }); expect(f.deliver).toHaveBeenCalledTimes(1);
  });

  it("retries an unknown commit outcome using the same immutable identity", async () => {
    const f = await fixture(); const cp = await f.publish(); const consumer = f.consumer();
    f.deliver.mockRejectedValueOnce(new Error("lost commit response with private-canary"));
    expect(await consumer.poll()).toEqual({ status: "scanned", outcomes: [] });
    expect(await readFile(cp.snapshot, "utf8")).toBe(state);
    expect((await consumer.poll()).outcomes).toEqual([{ snapshotId: cp.id, status: "persisted" }]);
    expect(f.deliver.mock.calls[0][0]).toEqual(f.deliver.mock.calls[1][0]);
  });

  it.each(["rejected", "superseded"] as const)("reclaims terminal %s snapshots without claiming persistence", async status => {
    const f = await fixture(); const cp = await f.publish(); const consumer = f.consumer();
    f.deliver.mockResolvedValue({ status });
    expect((await consumer.poll()).outcomes).toEqual([{ snapshotId: cp.id, status }]);
    await expect(stat(cp.snapshot)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await consumer.poll()).outcomes).toEqual([]);
  });

  it("does not treat a mint response or mismatched receipt as a Core commit", async () => {
    const f = await fixture(); const cp = await f.publish();
    f.deliver.mockResolvedValue({ status: "persisted", sessionId: "another-execution", snapshotId: cp.id });
    expect((await f.consumer().poll()).outcomes).toEqual([]);
    expect(await readFile(cp.snapshot, "utf8")).toBe(state);
  });

  it("rejects changed retained manifests rather than replaying a handled save", async () => {
    const f = await fixture(); const cp = await f.publish(); const consumer = f.consumer(); await consumer.poll();
    await writeFile(cp.ready, JSON.stringify({ ...cp.record, byte_length: cp.record.byte_length + 1 }));
    expect((await consumer.poll()).status).toBe("unavailable"); expect(f.deliver).toHaveBeenCalledTimes(1);
  });

  it("sorts saves, shares overlapping polls, and rejects duplicate sequence identities", async () => {
    const f = await fixture(); await f.publish(2); await f.publish(1); const consumer = f.consumer();
    const first = consumer.poll(); expect(consumer.poll()).toBe(first); await first;
    expect(f.deliver.mock.calls.map(call => call[0].sequence)).toEqual([1, 2]);
    const bad = await fixture(); await bad.publish(1); await bad.publish(1);
    expect((await bad.consumer().poll()).status).toBe("unavailable"); expect(bad.deliver).not.toHaveBeenCalled();
  });

  it("expires pending plaintext from local discovery, not caller timestamps", async () => {
    const f = await fixture(); const cp = await f.publish(); const consumer = f.consumer();
    f.deliver.mockResolvedValue({ status: "retryable" }); await consumer.poll();
    f.advance(ACCOUNT_CHECKPOINT_LIMITS.pendingMs);
    expect((await consumer.poll()).outcomes).toEqual([{ snapshotId: cp.id, status: "expired" }]);
    expect(f.deliver).toHaveBeenCalledTimes(1); await expect(stat(cp.snapshot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not read or upload after authority is lost or the operation is aborted", async () => {
    const f = await fixture(); await f.publish(); f.revoke();
    expect((await f.consumer().poll()).status).toBe("unauthorized"); expect(f.deliver).not.toHaveBeenCalled();
    const aborted = await fixture(); await aborted.publish(); aborted.controller.abort();
    expect((await aborted.consumer().poll()).status).toBe("unauthorized"); expect(aborted.deliver).not.toHaveBeenCalled();
  });

  it("bounds a hanging upload and never throws a secondary persistence failure at evaluation completion", async () => {
    const f = await fixture(); await f.publish(); f.deliver.mockImplementation(() => new Promise(() => {}));
    expect(await f.consumer().poll(30)).toEqual({ status: "scanned", outcomes: [] });
  });

  it("performs a final scan even when the engine failed after authentication", async () => {
    const f = await fixture(); const consumer = f.consumer(); await consumer.poll(); const cp = await f.publish();
    expect((await consumer.finish()).outcomes).toEqual([{ snapshotId: cp.id, status: "persisted" }]);
  });
});

describe("engine execution identities", () => {
  it("uses distinct safe IDs for repeated executions of the same job", () => {
    const ids = Array.from({ length: 100 }, () => newAccountExecutionId(40112));
    expect(new Set(ids).size).toBe(100);
    expect(ids.every(id => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id))).toBe(true);
    expect(() => newAccountExecutionId(-1)).toThrow("invalid-record");
  });
});

