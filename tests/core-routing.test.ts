import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer } from "node:http";
import { createHmac, randomUUID } from "node:crypto";
import { CoreRouting, CORE_RPC_PATH, coreOrigin, type CoreDirectory, type CoreOwner, type CoreResourceKind } from "../server/core-routing";

const secret = "core-routing-test-secret-at-least-32-characters";
class Directory implements CoreDirectory {
  owners = new Map<string, CoreOwner>(); nonces = new Set<string>(); leases = new Map<string, string>();
  key(kind: string, id: number) { return `${kind}:${id}`; }
  async claim(owner: CoreOwner) {
    const key = this.key(owner.kind, owner.resourceId);
    if (this.leases.has(key) && this.leases.get(key) !== owner.leaseId) return false;
    this.owners.set(key, owner); return true;
  }
  async find(kind: CoreResourceKind, id: number) { return this.owners.get(this.key(kind, id)) ?? null; }
  async renew(owner: CoreOwner) {
    const key = this.key(owner.kind, owner.resourceId);
    return this.owners.get(key)?.generation === owner.generation && (!this.leases.has(key) || this.leases.get(key) === owner.leaseId);
  }
  async release(owner: CoreOwner) {
    const key = this.key(owner.kind, owner.resourceId);
    if (this.owners.get(key)?.generation === owner.generation) this.owners.delete(key);
  }
  async acceptNonce(nonce: string) { if (this.nonces.has(nonce)) return false; this.nonces.add(nonce); return true; }
  async prune() {}
}
const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
async function core(directory: Directory, fetchImpl = fetch) {
  const app = express(); const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const router = new CoreRouting(directory, origin, secret, fetchImpl); router.register(app);
  app.use(express.json());
  cleanups.push(async () => { await router.stop(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  return router;
}

describe("Core owner routing", () => {
  it("one Core executes locally without an internal URL, secret, or network hop", async () => {
    const directory = new Directory(), network = vi.fn();
    const router = new CoreRouting(directory, null, null, network); const run = vi.fn(async () => ({ frame: "jpeg" }));
    router.handle("agent", run);
    const owner = await router.claim("agent", 1, "lease");
    expect(await router.request(owner, { action: "frame" })).toEqual({ frame: "jpeg" });
    expect(network).not.toHaveBeenCalled(); expect(run).toHaveBeenCalledOnce();
    await router.stop(); expect(await router.find("agent", 1)).toBeNull();
  });

  it("forwards agent and broker operations from any Core to their actual owner", async () => {
    const directory = new Directory(); const a = await core(directory), b = await core(directory), c = await core(directory);
    const agent = vi.fn(async (value) => ({ agentResult: value })), broker = vi.fn(async (value) => ({ brokerResult: value }));
    a.handle("agent", agent); b.handle("broker", broker);
    const agentOwner = await a.claim("agent", 11, "agent-lease"), brokerOwner = await b.claim("broker", 12, "broker-lease");
    expect(await c.request(agentOwner, { viewer: "viewer-1", sequence: 7 })).toEqual({ agentResult: { viewer: "viewer-1", sequence: 7 } });
    expect(await a.request(brokerOwner, { action: "browser" })).toEqual({ brokerResult: { action: "browser" } });
    expect(agent).toHaveBeenCalledOnce(); expect(broker).toHaveBeenCalledOnce();
  });

  it("old release/renew cannot erase a replacement on another Core, even with the same agent lease", async () => {
    const directory = new Directory(); const a = await core(directory), b = await core(directory);
    const lost = vi.fn(); const stale = await a.claim("agent", 8, "same-lease", lost);
    const current = await b.claim("agent", 8, "same-lease"); b.handle("agent", async () => "new");
    await a.maintain(); expect(lost).toHaveBeenCalledOnce();
    await a.release(stale); expect(await a.find("agent", 8)).toEqual(current);
    await expect(a.request(stale, { input: "must not execute" })).rejects.toThrow(/owner changed/);
    expect(await a.request(current, { action: "status" })).toBe("new");
  });

  it("rejects stale business leases before publication and closes lost local ownership", async () => {
    const directory = new Directory(), a = await core(directory);
    directory.leases.set("broker:3", "new");
    await expect(a.claim("broker", 3, "old")).rejects.toThrow(/superseded/);
    const lost = vi.fn(); await a.claim("broker", 3, "new", lost);
    directory.leases.set("broker:3", "newer"); await a.maintain();
    expect(lost).toHaveBeenCalledOnce();
  });

  it("does not revive an expired owner: reopening needs a fresh generation", async () => {
    const directory = new Directory(), a = await core(directory), b = await core(directory);
    const run = vi.fn(async () => "frame"); a.handle("agent", run);
    const old = await a.claim("agent", 2, "lease"); directory.owners.delete("agent:2");
    await expect(b.request(old, {})).rejects.toThrow(/unavailable/);
    const fresh = await a.claim("agent", 2, "lease"); expect(fresh.generation).not.toBe(old.generation);
    await expect(b.request(old, {})).rejects.toThrow(/unavailable/);
    expect(await b.request(fresh, {})).toBe("frame"); expect(run).toHaveBeenCalledOnce();
  });

  it("does not retry inputs when a response is lost after execution", async () => {
    const directory = new Directory(), ownerCore = await core(directory), run = vi.fn(async () => "accepted");
    ownerCore.handle("agent", run); const owner = await ownerCore.claim("agent", 5, "lease");
    const network = vi.fn(async (url, init) => { await fetch(url, init); throw new Error("response lost"); });
    const caller = await core(directory, network as typeof fetch);
    await expect(caller.request(owner, { click: true })).rejects.toThrow(/response lost/);
    expect(network).toHaveBeenCalledOnce(); expect(run).toHaveBeenCalledOnce();
  });

  it("fails closed and releases connections when the shared directory is unavailable", async () => {
    const directory = new Directory(), router = await core(directory), lost = vi.fn();
    const owner = await router.claim("agent", 1, "lease", lost); router.handle("agent", async () => "unexpected");
    vi.spyOn(directory, "renew").mockRejectedValue(new Error("DB unavailable")); await router.maintain();
    expect(lost).toHaveBeenCalledOnce(); await expect(router.request(owner, {})).rejects.toThrow(/owner changed/);
  });
});

describe("internal routing authentication", () => {
  it("rejects unsigned, tampered, expired and replayed requests without executing them", async () => {
    const directory = new Directory(), router = await core(directory), run = vi.fn(async () => "ok");
    router.handle("agent", run); const owner = await router.claim("agent", 1, "lease");
    const url = `${router.origin}${CORE_RPC_PATH}`;
    const signed = (body: string, timestamp = Date.now()) => {
      const time = String(timestamp), nonce = randomUUID();
      return { "content-type": "application/json", "x-vox-core-time": time, "x-vox-core-nonce": nonce,
        "x-vox-core-signature": createHmac("sha256", secret).update(`vox-core-routing-v1\n${time}\n${nonce}\n${body}`).digest("hex") };
    };
    const body = JSON.stringify({ owner, payload: { action: "frame" } });
    expect((await fetch(url, { method: "POST", headers: { "content-type": "application/json", cookie: "session=not-authority" }, body })).status).toBe(403);
    expect((await fetch(url, { method: "POST", headers: signed(body), body: body.replace("frame", "click") })).status).toBe(403);
    for (const skew of [-31000, 31000]) expect((await fetch(url, { method: "POST", headers: signed(body, Date.now() + skew), body })).status).toBe(403);
    const headers = signed(body);
    expect((await fetch(url, { method: "POST", headers, body })).status).toBe(200);
    expect((await fetch(url, { method: "POST", headers, body })).status).toBe(403);
    expect(run).toHaveBeenCalledOnce();
    const other = JSON.stringify({ owner: { ...owner, coreId: randomUUID() }, payload: {} });
    expect((await fetch(url, { method: "POST", headers: signed(other), body: other })).status).toBe(403);
  });

  it("never follows redirects, retries, or forwards to a public address", async () => {
    const directory = new Directory(), network = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://public.example" } }));
    const a = await core(directory, network as typeof fetch), b = await core(directory);
    const owner = await b.claim("agent", 1, "lease");
    await expect(a.request(owner, {})).rejects.toThrow(/unavailable/);
    expect(network).toHaveBeenCalledOnce(); expect(network.mock.calls[0][1].redirect).toBe("manual");
    await expect(a.request({ ...owner, origin: "https://public.example" }, {})).rejects.toThrow(/private/);
    expect(network).toHaveBeenCalledOnce();
  });

  it("caps envelopes/responses and scrubs owner exception details", async () => {
    const directory = new Directory(), a = await core(directory), b = await core(directory);
    const owner = await b.claim("agent", 1, "lease");
    await expect(a.request(owner, { body: "x".repeat(270000) })).rejects.toThrow(/limit/);
    b.handle("agent", async () => { throw new Error("SECRET-COOKIE-AND-PAGE"); });
    await expect(a.request(owner, {})).rejects.toThrow(/^Core owner unavailable; command outcome may be unknown$/);
    b.handle("agent", async () => "x".repeat(4 * 1024 * 1024));
    await expect(a.request(owner, {})).rejects.toThrow(/unavailable/);
  });

  it("validates each replica's private origin and shared key at startup", () => {
    for (const value of ["http://core-a:5000", "https://core-a.internal:5000", "http://10.0.0.1:5000", "http://127.0.0.1:5000"]) expect(coreOrigin(value)).toBe(value);
    for (const value of ["http://user:password@core", "http://core/path", "http://core?token=x", "https://public.example", "file:///tmp/core"]) expect(() => coreOrigin(value)).toThrow();
    expect(() => new CoreRouting(new Directory(), "http://core-a:5000", "short")).toThrow(/32 characters/);
  });
});
