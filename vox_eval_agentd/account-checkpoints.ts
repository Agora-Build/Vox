import { constants, type Stats } from "node:fs";
import { open, opendir, unlink, type FileHandle } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { TextDecoder } from "node:util";
import {
  ACCOUNT_CHECKPOINT_LIMITS as LIMITS, AccountCheckpointError,
  engineSessionIdSchema, parseAccountCheckpoint, parseAccountJson, type AccountCheckpointRecord,
} from "../shared/account-session-protocol";

const fdPath = (directory: FileHandle, name: string) => `/proc/self/fd/${directory.fd}/${name}`;
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

export function newAccountExecutionId(jobId: number): string {
  if (!Number.isSafeInteger(jobId) || jobId <= 0) throw new AccountCheckpointError("invalid-record");
  return `vox-${jobId}-${randomUUID()}`;
}

function checkPrivate(stat: Stats, directory: boolean): void {
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 ||
      (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o111) !== 0)) {
    throw new AccountCheckpointError("unsafe-path");
  }
}

async function directoryAt(parent: FileHandle, name: string): Promise<FileHandle> {
  const handle = await open(fdPath(parent, name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { checkPrivate(await handle.stat(), true); return handle; }
  catch (error) { await handle.close(); throw error; }
}

async function privateRoot(path: string): Promise<FileHandle> {
  // Anchor every traversal to an open directory, including non-private ancestors.
  // Linux /proc/self/fd supplies descriptor-relative operations without openat bindings.
  let current = await open("/", constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    for (const part of path.split("/").filter(Boolean)) {
      const next = await open(fdPath(current, part), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await current.close(); current = next;
    }
    checkPrivate(await current.stat(), true);
    return current;
  } catch (error) { await current.close(); throw error; }
}

async function privateFile(parent: FileHandle, name: string): Promise<FileHandle> {
  const file = await open(fdPath(parent, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { checkPrivate(await file.stat(), false); return file; }
  catch (error) { await file.close(); throw error; }
}

async function readPrivate(parent: FileHandle, name: string, maxBytes: number): Promise<{ text: string; stat: Stats }> {
  const file = await privateFile(parent, name);
  try {
    const stat = await file.stat();
    if (stat.size <= 0 || stat.size > maxBytes) throw new AccountCheckpointError("capacity");
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    for (;;) {
      const read = await file.read(buffer, length, buffer.length - length, length);
      length += read.bytesRead;
      if (!read.bytesRead || length === buffer.length) break;
    }
    const after = await file.stat(); checkPrivate(after, false);
    if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new AccountCheckpointError("unsafe-path");
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)), stat };
  } finally { await file.close(); }
}

async function lock(file: FileHandle, shared: boolean): Promise<boolean> {
  if (process.platform !== "linux") throw new AccountCheckpointError("lock-unavailable");
  // flock inherits the same open-file description. The lock survives child exit
  // until our descriptor closes; it is never held across a Core/network call.
  return new Promise((resolveLock, reject) => {
    const child = spawn("flock", [shared ? "--shared" : "--exclusive", "--nonblock", "--conflict-exit-code", "75", "3"],
      { stdio: ["ignore", "ignore", "ignore", file.fd], env: { PATH: process.env.PATH }, timeout: 1000 });
    child.once("error", () => reject(new AccountCheckpointError("lock-unavailable")));
    child.once("exit", code => {
      if (code === 0 || code === 75) resolveLock(code === 0);
      else reject(new AccountCheckpointError("lock-unavailable"));
    });
  });
}

async function names(directory: FileHandle, max: number): Promise<string[]> {
  const entries = await opendir(`/proc/self/fd/${directory.fd}`);
  const result: string[] = [];
  for await (const entry of entries) {
    if (!entry.isFile()) throw new AccountCheckpointError("unsafe-path");
    result.push(entry.name);
    if (result.length > max) throw new AccountCheckpointError("capacity");
  }
  return result.sort();
}

export type CheckpointDelivery =
  | { status: "persisted"; sessionId: string; snapshotId: string }
  | { status: "retryable" | "rejected" | "superseded" };
export function accountCheckpointReply(body: unknown): CheckpointDelivery {
  const value = body as Partial<CheckpointDelivery> | null;
  if (value?.status === "persisted" && "sessionId" in value && "snapshotId" in value &&
      typeof value.sessionId === "string" && typeof value.snapshotId === "string") return value as CheckpointDelivery;
  if (value?.status === "rejected" || value?.status === "superseded") return { status: value.status };
  return { status: "retryable" };
}
export type CheckpointOutcome = { snapshotId: string; status: "persisted" | "rejected" | "superseded" | "expired" };
interface CopiedCheckpoint {
  record: AccountCheckpointRecord; state: string; identity: string; stat: Stats;
}
interface TerminalCheckpoint { identity: string; stat: Stats; outcome: CheckpointOutcome }
interface ConsumerOptions {
  storageFile: string;
  sessionId: string;
  signal: AbortSignal;
  /** Must check current operation authority; Core independently reauthorizes every upload. */
  authorized: (signal: AbortSignal) => Promise<boolean>;
  acceptsState: (state: unknown) => boolean;
  deliver: (record: AccountCheckpointRecord, state: string, signal: AbortSignal) => Promise<CheckpointDelivery>;
  clock?: () => number;
}
export interface CheckpointPoll {
  status: "scanned" | "busy" | "unavailable" | "unauthorized";
  outcomes: CheckpointOutcome[];
}

/** Private v0.5.1 immutable-snapshot reader; Core independently reauthorizes uploads. */
export class AccountCheckpointConsumer {
  private readonly options: Readonly<ConsumerOptions>;
  private readonly firstSeen = new Map<string, number>();
  private readonly terminal = new Map<string, TerminalCheckpoint>();
  private active: Promise<CheckpointPoll> | null = null;

  constructor(options: ConsumerOptions) {
    engineSessionIdSchema.parse(options.sessionId);
    if (!isAbsolute(options.storageFile) || resolve(options.storageFile) !== options.storageFile ||
        dirname(options.storageFile) === "/" || !basename(options.storageFile)) throw new AccountCheckpointError("unsafe-path");
    this.options = Object.freeze({ ...options });
  }

  private now(): number { return this.options.clock?.() ?? performance.now(); }

  private async withSidecar<T>(shared: boolean, work: (sidecar: FileHandle) => Promise<T>): Promise<T | "busy" | "missing"> {
    const handles: FileHandle[] = [];
    try {
      const root = await privateRoot(dirname(this.options.storageFile)); handles.push(root);
      let sidecar: FileHandle;
      try { sidecar = await directoryAt(root, `${basename(this.options.storageFile)}.checkpoints`); }
      catch (error) { if (missing(error)) return "missing"; throw error; }
      handles.push(sidecar);
      const writerLock = await privateFile(sidecar, ".writer.lock"); handles.push(writerLock);
      if (!await lock(writerLock, shared)) return "busy";
      return await work(sidecar);
    } finally { for (const handle of handles.reverse()) await handle.close(); }
  }

  private async copy(): Promise<CopiedCheckpoint[] | "busy" | "missing"> {
    return this.withSidecar(true, async sidecar => {
      const handles: FileHandle[] = [];
      try {
        const ready = await directoryAt(sidecar, "ready"); handles.push(ready);
        let session: FileHandle;
        try { session = await directoryAt(ready, this.options.sessionId); }
        catch (error) { if (missing(error)) return []; throw error; }
        handles.push(session);
        const files = await names(session, LIMITS.readyRecords);
        const copies: CopiedCheckpoint[] = [];
        const seenIds = new Set<string>();
        const seenSequences = new Set<number>();
        let total = 0;
        let snapshots: FileHandle | undefined;
        for (const file of files) {
          if (!/^\d{10}-[a-f0-9]{32}\.json$/.test(file)) continue; // Publication leftovers are not ready records.
          const raw = await readPrivate(session, file, LIMITS.recordBytes);
          const record = parseAccountCheckpoint(raw.text, this.options.sessionId, file);
          if (seenIds.has(record.snapshot_id) || seenSequences.has(record.sequence)) throw new AccountCheckpointError("invalid-record");
          seenIds.add(record.snapshot_id); seenSequences.add(record.sequence);
          const identity = digest(raw.text);
          const handled = this.terminal.get(record.snapshot_id);
          if (handled) {
            if (handled.identity !== identity) throw new AccountCheckpointError("invalid-record");
            continue;
          }
          if (!this.firstSeen.has(record.snapshot_id)) {
            if (this.firstSeen.size + this.terminal.size >= LIMITS.readyRecords) throw new AccountCheckpointError("capacity");
            this.firstSeen.set(record.snapshot_id, this.now());
          }
          if (!snapshots) {
            const directory = await directoryAt(sidecar, "snapshots"); handles.push(directory);
            snapshots = await directoryAt(directory, this.options.sessionId); handles.push(snapshots);
          }
          const snapshot = await readPrivate(snapshots, `${record.snapshot_id}.json`, LIMITS.snapshotBytes);
          total += snapshot.stat.size;
          if (copies.length >= LIMITS.pendingSnapshots || total > LIMITS.pendingBytes) throw new AccountCheckpointError("capacity");
          if (snapshot.stat.size !== record.byte_length || !this.options.acceptsState(parseAccountJson(snapshot.text))) {
            throw new AccountCheckpointError("invalid-state");
          }
          copies.push({ record, state: snapshot.text, identity, stat: snapshot.stat });
        }
        return copies;
      } finally { for (const handle of handles.reverse()) await handle.close(); }
    });
  }

  private async reclaim(): Promise<void> {
    await this.withSidecar(false, async sidecar => {
      const handles: FileHandle[] = [];
      try {
        const snapshots = await directoryAt(sidecar, "snapshots"); handles.push(snapshots);
        const session = await directoryAt(snapshots, this.options.sessionId); handles.push(session);
        for (const [id, handled] of this.terminal) {
          let file: FileHandle;
          try { file = await privateFile(session, `${id}.json`); }
          catch (error) { if (missing(error)) continue; throw error; }
          try {
            const stat = await file.stat();
            if (stat.ino !== handled.stat.ino || stat.dev !== handled.stat.dev) throw new AccountCheckpointError("unsafe-path");
            await unlink(fdPath(session, `${id}.json`));
          } finally { await file.close(); }
        }
        // Ready records remain until caller-owned job-root cleanup.
      } finally { for (const handle of handles.reverse()) await handle.close(); }
    });
  }

  private settle(copy: CopiedCheckpoint, status: CheckpointOutcome["status"]): CheckpointOutcome {
    const outcome = { snapshotId: copy.record.snapshot_id, status };
    this.terminal.set(outcome.snapshotId, { identity: copy.identity, stat: copy.stat, outcome });
    this.firstSeen.delete(outcome.snapshotId);
    return outcome;
  }

  private async scan(budgetMs: number): Promise<CheckpointPoll> {
    const outcomes: CheckpointOutcome[] = [];
    const signal = AbortSignal.any([this.options.signal, AbortSignal.timeout(budgetMs)]);
    try {
      if (signal.aborted || !await this.withBudget(signal, () => this.options.authorized(signal))) return { status: "unauthorized", outcomes };
      const copies = await this.copy();
      if (copies === "busy") return { status: "busy", outcomes };
      if (copies === "missing") return { status: "scanned", outcomes };
      for (const copy of copies) {
        if (this.now() - this.firstSeen.get(copy.record.snapshot_id)! >= LIMITS.pendingMs) {
          outcomes.push(this.settle(copy, "expired")); continue;
        }
        if (signal.aborted) break;
        if (!await this.withBudget(signal, () => this.options.authorized(signal))) { outcomes.push(this.settle(copy, "rejected")); continue; }
        let reply: CheckpointDelivery;
        try {
          reply = await this.withBudget(signal, () => this.options.deliver(copy.record, copy.state, signal));
        } catch { continue; }
        if (reply.status === "persisted") {
          if (reply.sessionId !== this.options.sessionId || reply.snapshotId !== copy.record.snapshot_id) continue;
          outcomes.push(this.settle(copy, "persisted"));
        } else if (reply.status === "rejected" || reply.status === "superseded") outcomes.push(this.settle(copy, reply.status));
      }
      await this.reclaim();
      return { status: "scanned", outcomes };
    } catch { return { status: "unavailable", outcomes }; }
  }

  private async withBudget<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolveWork, reject) => {
      const aborted = () => reject(new Error("Checkpoint operation deadline"));
      if (signal.aborted) { aborted(); return; }
      signal.addEventListener("abort", aborted, { once: true });
      Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }).then(resolveWork, reject)
        .finally(() => signal.removeEventListener("abort", aborted));
    });
  }

  /** Caller polls about once a second; overlapping polls share one bounded scan. */
  poll(budgetMs = 1000): Promise<CheckpointPoll> {
    if (this.active) return this.active;
    if (!Number.isInteger(budgetMs) || budgetMs <= 0 || budgetMs > LIMITS.finalFlushMs) throw new AccountCheckpointError("capacity");
    this.active = this.scan(budgetMs).finally(() => { this.active = null; });
    return this.active;
  }

  /** Final caller cleanup must remove the private root even if flush cannot persist. */
  async finish(): Promise<CheckpointPoll> {
    const deadline = this.now() + LIMITS.finalFlushMs;
    const outcomes: CheckpointOutcome[] = [];
    if (this.active) {
      const previous = await this.active; outcomes.push(...previous.outcomes);
    }
    let status: CheckpointPoll["status"] = "scanned";
    while (this.now() < deadline && !this.options.signal.aborted) {
      const next = await this.poll(Math.max(1, Math.ceil(deadline - this.now())));
      status = next.status; outcomes.push(...next.outcomes);
      if (status === "unauthorized" || !this.firstSeen.size) break;
      await new Promise(resolveWait => setTimeout(resolveWait, Math.min(50, Math.max(0, deadline - this.now()))));
    }
    return { status, outcomes };
  }
}

