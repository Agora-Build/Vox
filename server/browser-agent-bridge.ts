import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { storage, hashToken } from "./storage";
import { z } from "zod";
import { BROWSER_RESPONSE_LIMIT, browserOperationSchema, type BrowserOperation } from "@shared/browser-assistance";
import { coreRouting } from "./core-routing-runtime";

type Peer = {
  ws: WebSocket; leaseId: string;
  pending: Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>;
};

export class BrowserAgentRegistry {
  private peers = new Map<number, Peer>();
  attach(agentId: number, leaseId: string, ws: WebSocket): void {
    this.peers.get(agentId)?.ws.close();
    const peer: Peer = { ws, leaseId, pending: new Map() };
    this.peers.set(agentId, peer);
    let alive = true;
    ws.on("pong", () => { alive = true; });
    const watchdog = setInterval(() => {
      if (!alive) { ws.terminate(); return; }
      alive = false; ws.ping();
    }, 20_000);
    watchdog.unref();
    ws.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString());
        const pending = peer.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer); peer.pending.delete(message.id);
        if (message.ok === true) pending.resolve(message.result);
        else pending.reject(new Error("Browser connection unavailable; an input outcome may be unknown"));
      } catch { ws.close(1008); }
    });
    ws.on("error", () => undefined);
    ws.on("close", () => {
      clearInterval(watchdog);
      if (this.peers.get(agentId) === peer) this.peers.delete(agentId);
      for (const item of Array.from(peer.pending.values())) { clearTimeout(item.timer); item.reject(new Error("Browser agent disconnected")); }
      peer.pending.clear();
    });
  }
  available(agentId: number, leaseId: string): boolean {
    const peer = this.peers.get(agentId);
    return peer?.leaseId === leaseId && peer.ws.readyState === WebSocket.OPEN;
  }
  async request(agentId: number, leaseId: string, execution: { jobId: number; startedAt: string }, operation: BrowserOperation | { action: "cancel" }): Promise<unknown> {
    const peer = this.peers.get(agentId);
    if (!peer || peer.leaseId !== leaseId || peer.ws.readyState !== WebSocket.OPEN) throw new Error("Browser agent is not connected to this Core instance");
    if (peer.pending.size >= 12 || peer.ws.bufferedAmount > BROWSER_RESPONSE_LIMIT) throw new Error("Browser agent is busy");
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { peer.pending.delete(id); reject(new Error("Browser command outcome unknown; inspect before taking another action")); }, 12_000);
      peer.pending.set(id, { resolve, reject, timer });
      peer.ws.send(JSON.stringify({ id, execution, operation }), (error) => {
        if (error) { clearTimeout(timer); peer.pending.delete(id); reject(new Error("Browser agent disconnected")); }
      });
    });
  }
}

const localAgents = new BrowserAgentRegistry();
const executionSchema = z.object({ jobId: z.number().int().positive(), startedAt: z.string().datetime() }).strict();
const routedOperationSchema = z.object({
  execution: executionSchema,
  operation: z.union([browserOperationSchema, z.object({ action: z.literal("cancel") }).strict()]),
}).strict();
coreRouting.handle("agent", async (payload, owner) => {
  const { execution, operation } = routedOperationSchema.parse(payload);
  const agent = await storage.getEvalAgent(owner.resourceId);
  const token = agent && await storage.getEvalAgentToken(agent.tokenId);
  const job = await storage.getEvalJob(execution.jobId);
  if (!agent || !token || token.isRevoked || agent.currentLeaseId !== owner.leaseId
    || !job || job.evalAgentId !== agent.id || job.startedAt?.toISOString() !== execution.startedAt
    || (operation.action !== "cancel" && operation.action !== "close" && job.status !== "running")
    || (operation.action === "cancel" && !job.cancelledAt)) throw new Error("Browser execution changed");
  return localAgents.request(agent.id, owner.leaseId, execution, operation);
});

export const browserAgents = {
  async owner(agentId: number, leaseId: string) {
    const owner = await coreRouting.find("agent", agentId);
    return owner?.leaseId === leaseId ? owner : null;
  },
  async request(agentId: number, leaseId: string, execution: { jobId: number; startedAt: string }, operation: BrowserOperation | { action: "cancel" }, generation?: string) {
    const owner = await this.owner(agentId, leaseId);
    if (!owner || (generation && owner.generation !== generation)) throw new Error("Browser connection changed; reopen the viewer");
    return coreRouting.request(owner, { execution, operation });
  },
};

export function setupBrowserAgentBridge(server: Server): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: BROWSER_RESPONSE_LIMIT });
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/ws/eval-browser") return;
    const timer = setTimeout(() => socket.destroy(), 5000);
    void (async () => {
      try {
        const authorization = request.headers.authorization;
        const leaseId = request.headers["x-vox-agent-lease"];
        if (!authorization?.startsWith("Bearer ") || typeof leaseId !== "string") throw new Error("unauthorized");
        const token = await storage.getEvalAgentTokenByHash(hashToken(authorization.slice(7)));
        if (!token || token.isRevoked) throw new Error("unauthorized");
        const agent = (await storage.getEvalAgentsByTokenId(token.id)).find((item) => item.currentLeaseId === leaseId);
        if (!agent || agent.currentLeaseId !== leaseId || !hasBrowserAssistance(agent.metadata)) throw new Error("unauthorized");
        if (socket.destroyed) return;
        clearTimeout(timer);
        wss.handleUpgrade(request, socket, head, (ws) => {
          void (async () => {
            const owner = await coreRouting.claim("agent", agent.id, leaseId, () => ws.close(1012));
            ws.once("close", () => { void coreRouting.release(owner).catch(() => undefined); });
            if (ws.readyState !== WebSocket.OPEN) { await coreRouting.release(owner); return; }
            localAgents.attach(agent.id, leaseId, ws);
          })().catch(() => ws.close(1012));
        });
      } catch { clearTimeout(timer); socket.destroy(); }
    })();
  });
  server.once("close", () => wss.close());
}

export function hasBrowserAssistance(metadata: unknown): boolean {
  return !!metadata && typeof metadata === "object" && (metadata as Record<string, unknown>).browserAssistance === "1";
}
