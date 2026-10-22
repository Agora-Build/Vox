import { describe, it, expect, afterAll } from "vitest";
import { storage, pool, hashToken } from "../server/storage";

// Behind Cloudflare, Vox recorded a PROXY's address as every agent's IP when
// the chain had more hops than `trust proxy` allowed for — and that address is
// what GeoIP region detection reads. It now uses the caller's real address
// (CF-Connecting-IP, believed from a private-network hop; server/client-ip.ts).
// The dev server sees these requests from 127.0.0.1: a private hop, as
// cloudflared/Traefik are in production.

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";
const d = process.env.DATABASE_URL ? describe : describe.skip;

d("an agent's observed IP is the caller behind Cloudflare, not the proxy", () => {
  const tokenIds: number[] = [];
  afterAll(async () => {
    if (tokenIds.length) {
      await pool.query("DELETE FROM eval_agents WHERE token_id = ANY($1)", [tokenIds]);
      await pool.query("DELETE FROM eval_agent_tokens WHERE id = ANY($1)", [tokenIds]);
    }
  });

  it("register and heartbeat record CF-Connecting-IP", async () => {
    const raw = `vox_agent_cfip_${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const tok = await storage.createEvalAgentToken({ name: `cfip-${Date.now()}`, tokenHash: hashToken(raw), siteId: null, dispatchTier: "private", createdBy: 1 } as any);
    tokenIds.push(tok.id);
    const reg = await fetch(`${BASE_URL}/api/eval-agent/register`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${raw}`, "CF-Connecting-IP": "203.0.113.77" },
      body: JSON.stringify({ name: "cfip-agent" }),
    });
    expect(reg.ok).toBe(true);
    const agent = await reg.json();
    const observed = async () => {
      for (let i = 0; i < 20; i++) { // recorded fire-and-forget
        const v = (await pool.query("SELECT observed_ip FROM eval_agents WHERE id = $1", [agent.id])).rows[0]?.observed_ip;
        if (v) return v as string;
        await new Promise((r) => setTimeout(r, 100));
      }
      return null;
    };
    expect(await observed()).toBe("203.0.113.77");

    const hb = await fetch(`${BASE_URL}/api/eval-agent/heartbeat`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${raw}`, "CF-Connecting-IP": "198.51.100.42" },
      body: JSON.stringify({ agentId: agent.id, leaseId: agent.leaseId, state: "idle" }),
    });
    expect(hb.ok).toBe(true);
    for (let i = 0; i < 20 && (await observed()) !== "198.51.100.42"; i++) await new Promise((r) => setTimeout(r, 100));
    expect(await observed()).toBe("198.51.100.42");
  });
});
