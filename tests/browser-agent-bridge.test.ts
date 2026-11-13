import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import { ReverseBrowserBridge } from "../vox_eval_agentd/browser-bridge";
vi.mock("../server/storage", () => ({ storage: { getEvalAgentTokenByHash: vi.fn(), getEvalAgentsByTokenId: vi.fn() }, hashToken: (value: string) => value }));
vi.mock("../server/core-routing-runtime", () => ({ coreRouting: {
  handle: vi.fn(), claim: vi.fn(async () => ({ generation: randomUUID() })), release: vi.fn(async () => {}),
} }));
import { storage } from "../server/storage";
import { BrowserAgentRegistry, setupBrowserAgentBridge } from "../server/browser-agent-bridge";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function listening(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe("outbound eval browser bridge", () => {
  it("Core upgrade rejects missing/revoked tokens and stale leases, accepting only an explicitly capable current process", async () => {
    const server = createServer(); setupBrowserAgentBridge(server); const url = (await listening(server)).replace("http:", "ws:") + "/ws/eval-browser";
    vi.mocked(storage.getEvalAgentTokenByHash).mockResolvedValue({ id: 7, isRevoked: false } as never);
    vi.mocked(storage.getEvalAgentsByTokenId).mockResolvedValue([{ id: 30, currentLeaseId: "current", metadata: { browserAssistance: "1" } }] as never);
    const open = (headers?: Record<string, string>) => new Promise<boolean>((resolve) => {
      const ws = new WebSocket(url, { headers }); cleanups.push(() => ws.terminate());
      ws.once("open", () => resolve(true)); ws.once("error", () => resolve(false));
    });
    expect(await open()).toBe(false);
    expect(await open({ authorization: "Bearer token", "x-vox-agent-lease": "old" })).toBe(false);
    vi.mocked(storage.getEvalAgentTokenByHash).mockResolvedValue({ id: 7, isRevoked: true } as never);
    expect(await open({ authorization: "Bearer token", "x-vox-agent-lease": "current" })).toBe(false);
    vi.mocked(storage.getEvalAgentTokenByHash).mockResolvedValue({ id: 7, isRevoked: false } as never);
    expect(await open({ authorization: "Bearer token", "x-vox-agent-lease": "current" })).toBe(true);
  });

  it("authenticates outbound with the agent lease and delegates only validated execution operations", async () => {
    const server = createServer(); const url = await listening(server);
    const wss = new WebSocketServer({ server, path: "/ws/eval-browser" });
    cleanups.push(() => { for (const ws of wss.clients) ws.terminate(); wss.close(); });
    const connected = new Promise<WebSocket>((resolve) => wss.once("connection", (ws, req) => {
      expect(req.headers.authorization).toBe("Bearer token"); expect(req.headers["x-vox-agent-lease"]).toBe("lease"); resolve(ws);
    }));
    const handle = vi.fn().mockResolvedValue({ closed: true });
    const bridge = new ReverseBrowserBridge({ serverUrl: url, token: "token", leaseId: () => "lease", handle });
    cleanups.push(() => bridge.stop()); bridge.connect();
    const ws = await connected;
    const message = new Promise((resolve) => ws.once("message", (data) => resolve(JSON.parse(data.toString()))));
    ws.send(JSON.stringify({ id: "request", execution: { jobId: 4, startedAt: "2026-11-13T00:00:00Z" }, operation: { action: "close", viewerId: randomUUID() } }));
    expect(await message).toMatchObject({ id: "request", ok: true, result: { closed: true } });
    expect(handle.mock.calls[0][0]).toEqual({ jobId: 4, startedAt: "2026-11-13T00:00:00Z" });
    const closed = new Promise((resolve) => ws.once("close", resolve));
    ws.send(JSON.stringify({ id: "invalid", execution: { jobId: 4, startedAt: "now" }, operation: { action: "command", viewerId: "not-a-grant" } }));
    await closed; expect(handle).toHaveBeenCalledTimes(1);
  });

  it("does not expose daemon error details or replay an input after a failed outcome", async () => {
    const server = createServer(); const url = await listening(server);
    const wss = new WebSocketServer({ server }); cleanups.push(() => { for (const ws of wss.clients) ws.terminate(); wss.close(); });
    const connected = new Promise<WebSocket>((resolve) => wss.once("connection", resolve));
    const handle = vi.fn().mockRejectedValue(new Error("SECRET-PAGE-CONTENT"));
    const bridge = new ReverseBrowserBridge({ serverUrl: url, token: "token", leaseId: () => "lease", handle }); cleanups.push(() => bridge.stop()); bridge.connect();
    const ws = await connected;
    const message = new Promise((resolve) => ws.once("message", (data) => resolve(JSON.parse(data.toString()))));
    ws.send(JSON.stringify({ id: "request", execution: { jobId: 4, startedAt: "time" }, operation: { action: "cancel" } }));
    expect(await message).toEqual({ id: "request", ok: false }); expect(handle).toHaveBeenCalledTimes(1);
  });

  it("a replaced connection cannot delete its successor's registry entry or resolve its pending commands", async () => {
    const server = createServer(); const url = await listening(server);
    const wss = new WebSocketServer({ server }); cleanups.push(() => { for (const ws of wss.clients) ws.terminate(); wss.close(); });
    const registry = new BrowserAgentRegistry();
    const connect = async (lease: string) => {
      const attached = new Promise<void>((resolve) => wss.once("connection", (ws) => { registry.attach(3, lease, ws); resolve(); }));
      const client = new WebSocket(url.replace("http:", "ws:")); cleanups.push(() => client.terminate());
      await attached; await new Promise<void>((resolve) => client.readyState === WebSocket.OPEN ? resolve() : client.once("open", resolve));
      client.on("message", (data) => { const value = JSON.parse(data.toString()); client.send(JSON.stringify({ id: value.id, ok: true, result: lease })); });
      return client;
    };
    const old = await connect("old"); const closed = new Promise((resolve) => old.once("close", resolve));
    await connect("new"); await closed;
    expect(registry.available(3, "new")).toBe(true); expect(registry.available(3, "old")).toBe(false);
    const execution = { jobId: 7, startedAt: "time" };
    await expect(registry.request(3, "old", execution, { action: "cancel" })).rejects.toThrow(/not connected/);
    expect(await registry.request(3, "new", execution, { action: "status", viewerId: randomUUID() })).toBe("new");
  });
});
