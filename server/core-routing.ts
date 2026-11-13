import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Express } from "express";
import express from "express";
import { z } from "zod";

export type CoreResourceKind = "agent" | "broker";
export type CoreOwner = {
  kind: CoreResourceKind; resourceId: number; coreId: string; origin: string | null;
  generation: string; leaseId: string;
};
export interface CoreDirectory {
  claim(owner: CoreOwner): Promise<boolean>;
  find(kind: CoreResourceKind, id: number): Promise<CoreOwner | null>;
  renew(owner: CoreOwner): Promise<boolean>;
  release(owner: CoreOwner): Promise<void>;
  acceptNonce(nonce: string): Promise<boolean>;
  prune(): Promise<void>;
}
type Handler = (payload: unknown, owner: CoreOwner) => Promise<unknown>;
const ownerSchema = z.object({
  kind: z.enum(["agent", "broker"]), resourceId: z.number().int().positive(),
  coreId: z.string().uuid(), origin: z.string().nullable(), generation: z.string().uuid(), leaseId: z.string().min(1).max(256),
}).strict();
const envelopeSchema = z.object({ owner: ownerSchema, payload: z.unknown() }).strict();
export const CORE_RPC_PATH = "/internal/core-routing";
const REQUEST_LIMIT = 256 * 1024;
const RESPONSE_LIMIT = 4 * 1024 * 1024;

export function coreOrigin(raw: string): string {
  const url = new URL(raw);
  const host = url.hostname;
  const octets = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host.split(".").map(Number) : null;
  const privateIp = octets && (octets[0] === 10 || octets[0] === 127 || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31));
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/"
    || !(privateIp || host === "[::1]" || host === "localhost" || (!host.includes(".") && !host.includes(":")) || host.endsWith(".internal") || host.endsWith(".local"))) {
    throw new Error("VOX_CORE_INTERNAL_URL must be this replica's private HTTP(S) origin, not a load balancer");
  }
  return url.origin;
}

export class CoreRouting {
  readonly id = randomUUID();
  private local = new Map<string, { owner: CoreOwner; lost?: () => void }>();
  private handlers = new Map<CoreResourceKind, Handler>();
  private channels = new Map<string, Handler>();
  private timer?: ReturnType<typeof setInterval>;
  private renewing = false;
  constructor(readonly directory: CoreDirectory, readonly origin: string | null, private secret: string | null, private fetchImpl: typeof fetch = fetch) {
    if (origin) {
      coreOrigin(origin);
      if (!secret || secret.length < 32) throw new Error("VOX_CORE_ROUTING_SECRET must contain at least 32 characters for cross-Core routing");
    }
  }
  handle(kind: CoreResourceKind, handler: Handler): void { this.handlers.set(kind, handler); }
  handleChannel(channel: string, handler: Handler): void { this.channels.set(channel, handler); }
  private key(kind: CoreResourceKind, id: number): string { return `${kind}:${id}`; }
  async claim(kind: CoreResourceKind, resourceId: number, leaseId: string, lost?: () => void): Promise<CoreOwner> {
    const owner: CoreOwner = { kind, resourceId, leaseId, coreId: this.id, origin: this.origin, generation: randomUUID() };
    if (!await this.directory.claim(owner)) throw new Error("Connection lease was superseded");
    if ((await this.directory.find(kind, resourceId))?.generation !== owner.generation) throw new Error("Connection owner was superseded");
    const key = this.key(kind, resourceId);
    this.local.get(key)?.lost?.();
    this.local.set(key, { owner, lost });
    return owner;
  }
  find(kind: CoreResourceKind, id: number): Promise<CoreOwner | null> { return this.directory.find(kind, id); }
  async release(owner: CoreOwner): Promise<void> {
    const key = this.key(owner.kind, owner.resourceId);
    if (this.local.get(key)?.owner.generation === owner.generation) this.local.delete(key);
    await this.directory.release(owner);
  }
  async maintain(): Promise<void> {
    if (this.renewing) return;
    this.renewing = true;
    try {
      for (const [key, resource] of Array.from(this.local)) {
        if (!await this.directory.renew(resource.owner) && this.local.get(key) === resource) {
          this.local.delete(key); resource.lost?.();
        }
      }
      await this.directory.prune();
    } catch {
      // A directory outage must not leave locally cached authority usable.
      for (const resource of Array.from(this.local.values())) resource.lost?.();
      this.local.clear();
    } finally { this.renewing = false; }
  }
  start(): void {
    this.timer ??= setInterval(() => { void this.maintain(); }, 5000);
    this.timer.unref();
  }
  async stop(): Promise<void> {
    clearInterval(this.timer); this.timer = undefined;
    const resources = Array.from(this.local.values()); this.local.clear();
    await Promise.allSettled(resources.map(async ({ owner, lost }) => { lost?.(); await this.directory.release(owner); }));
  }
  private async execute(owner: CoreOwner, payload: unknown): Promise<unknown> {
    const local = this.local.get(this.key(owner.kind, owner.resourceId));
    const current = await this.find(owner.kind, owner.resourceId);
    if (owner.coreId !== this.id || !current || current.coreId !== this.id || current.generation !== owner.generation
      || current.leaseId !== owner.leaseId || local?.owner.generation !== owner.generation) throw new Error("Connection owner changed; reopen the viewer");
    const channel = payload && typeof payload === "object" ? (payload as { channel?: unknown }).channel : undefined;
    const handler = typeof channel === "string" ? this.channels.get(channel) : this.handlers.get(owner.kind);
    if (!handler) throw new Error("Connection handler unavailable");
    return handler(payload, owner);
  }
  private signature(time: string, nonce: string, body: string): string {
    return createHmac("sha256", this.secret!).update(`vox-core-routing-v1\n${time}\n${nonce}\n${body}`).digest("hex");
  }
  async request(owner: CoreOwner, payload: unknown, timeoutMs = 15_000): Promise<unknown> {
    if (owner.coreId === this.id) return this.execute(owner, payload);
    if (!owner.origin || !this.origin || !this.secret) throw new Error("Cross-Core routing is not configured on every replica");
    const origin = coreOrigin(owner.origin);
    const body = JSON.stringify({ owner, payload });
    if (Buffer.byteLength(body) > REQUEST_LIMIT) throw new Error("Internal command exceeds routing limit");
    const time = String(Date.now()), nonce = randomUUID();
    // Never retry: the remote action may have executed before a transport failure.
    const response = await this.fetchImpl(`${origin}${CORE_RPC_PATH}`, {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
      headers: { "content-type": "application/json", "x-vox-core-time": time, "x-vox-core-nonce": nonce, "x-vox-core-signature": this.signature(time, nonce, body) }, body,
    });
    if (!response.ok || !response.body) throw new Error("Core owner unavailable; command outcome may be unknown");
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length;
        if (size > RESPONSE_LIMIT) throw new Error("Internal response exceeds routing limit");
        chunks.push(value);
      }
    } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
    const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (result?.ok !== true) throw new Error("Core owner unavailable; command outcome may be unknown");
    return result.result;
  }
  register(app: Express): void {
    app.post(CORE_RPC_PATH, express.raw({ type: "application/json", limit: REQUEST_LIMIT }), async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      try {
        if (!this.secret || !this.origin || !Buffer.isBuffer(req.body)) return res.sendStatus(403);
        const time = req.get("x-vox-core-time") ?? "", nonce = req.get("x-vox-core-nonce") ?? "", signature = req.get("x-vox-core-signature") ?? "";
        if (!/^\d{13}$/.test(time) || Math.abs(Date.now() - Number(time)) > 30_000 || !z.string().uuid().safeParse(nonce).success || !/^[a-f0-9]{64}$/.test(signature)) return res.sendStatus(403);
        const expected = this.signature(time, nonce, req.body.toString("utf8"));
        if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"))) return res.sendStatus(403);
        const parsed = envelopeSchema.safeParse(JSON.parse(req.body.toString("utf8")));
        if (!parsed.success || parsed.data.owner.coreId !== this.id || !await this.directory.acceptNonce(nonce)) return res.sendStatus(403);
        const result = await this.execute(parsed.data.owner, parsed.data.payload);
        const response = JSON.stringify({ ok: true, result });
        if (Buffer.byteLength(response) > RESPONSE_LIMIT) throw new Error("Response limit exceeded");
        res.type("json").send(response);
      } catch { res.status(503).json({ ok: false, error: "Core owner unavailable; command outcome may be unknown" }); }
    });
  }
}
