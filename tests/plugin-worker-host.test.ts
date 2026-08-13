import { describe, it, expect, vi } from "vitest";
import { WorkerHost, advisoryKey } from "../server/plugins/hosts/worker";

describe("advisoryKey", () => {
  it("is deterministic and 32-bit", () => {
    expect(advisoryKey("sample:prune")).toBe(advisoryKey("sample:prune"));
    expect(Number.isInteger(advisoryKey("x"))).toBe(true);
  });
});

describe("WorkerHost", () => {
  it("runs a non-singleton worker on its interval and stops it", async () => {
    vi.useFakeTimers();
    const run = vi.fn().mockResolvedValue(undefined);
    const onShutdown = vi.fn().mockResolvedValue(undefined);
    const host = new WorkerHost();
    host.register("sample", { id: "w", intervalMs: 1000, run, onShutdown });
    const fakePool = { query: vi.fn() } as any;
    host.startAll(fakePool);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    await host.stopAll();
    await vi.advanceTimersByTimeAsync(2000);
    expect(run).toHaveBeenCalledTimes(1);       // no more ticks after stop
    expect(onShutdown).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("skips a singleton tick when the advisory lock is not acquired, and always releases the client", async () => {
    vi.useFakeTimers();
    const run = vi.fn().mockResolvedValue(undefined);
    const host = new WorkerHost();
    host.register("sample", { id: "s", intervalMs: 1000, singleton: true, run });
    const fakeClient = { query: vi.fn().mockResolvedValue({ rows: [{ ok: false }] }), release: vi.fn() };
    const fakePool = { connect: vi.fn().mockResolvedValue(fakeClient) } as any;
    host.startAll(fakePool);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).not.toHaveBeenCalled();
    expect(fakeClient.release).toHaveBeenCalledTimes(1);
    await host.stopAll();
    vi.useRealTimers();
  });

  it("runs a singleton tick and unlocks on the SAME dedicated client when the lock is acquired", async () => {
    vi.useFakeTimers();
    const run = vi.fn().mockResolvedValue(undefined);
    const host = new WorkerHost();
    host.register("sample", { id: "s2", intervalMs: 1000, singleton: true, run });
    const fakeClient = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ ok: true }] })  // pg_try_advisory_lock
        .mockResolvedValueOnce({ rows: [] }),             // pg_advisory_unlock
      release: vi.fn(),
    };
    const fakePool = { connect: vi.fn().mockResolvedValue(fakeClient) } as any;
    host.startAll(fakePool);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(fakeClient.query).toHaveBeenCalledWith(expect.stringContaining("pg_try_advisory_lock"), expect.any(Array));
    expect(fakeClient.query).toHaveBeenCalledWith(expect.stringContaining("pg_advisory_unlock"), expect.any(Array));
    expect(fakeClient.release).toHaveBeenCalledTimes(1);
    await host.stopAll();
    vi.useRealTimers();
  });
});
