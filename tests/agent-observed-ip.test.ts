import { describe, it, expect, beforeAll } from "vitest";
import { storage } from "../server/storage";
import { BASE_NA } from "./helpers/regions";

// Task 11: Agent observed-IP recording (layer-2/3 foundation). Core records
// each agent's observed egress IP at register/heartbeat into
// eval_agents.observed_ip / observed_ip_at. Raw IP is Core-internal — future
// phases derive network labels (residential/starlink/datacenter) from it; it
// must NEVER appear in the public agents listing.

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || "admin@vox.local";
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || "admin123456";

interface AuthSession {
  cookie: string;
}

async function login(email: string, password: string): Promise<AuthSession> {
  const response = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`Login failed: ${response.status}`);
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("No session cookie received");
  return { cookie: setCookie.split(";")[0] };
}

async function authFetch(session: AuthSession, url: string, options: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...options,
    headers: { ...options.headers, Cookie: session.cookie, "Content-Type": "application/json" },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Phase C: agent observed-IP recording", () => {
  let admin: AuthSession;
  let tokenValue: string;
  let tokenId: number;
  const stamp = Date.now();

  beforeAll(async () => {
    admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

    const tokenRes = await authFetch(admin, `${BASE_URL}/api/admin/eval-agent-tokens`, {
      method: "POST",
      body: JSON.stringify({ name: `OIP Token ${stamp}`, regionLocationBaseId: BASE_NA }),
    });
    expect(tokenRes.ok).toBe(true);
    const tokenData = await tokenRes.json();
    tokenValue = tokenData.token;
    tokenId = tokenData.id;
  });

  it("records observedIp/observedIpAt on register, advances observedIpAt on heartbeat, and never leaks in the public listing", async () => {
    const regRes = await fetch(`${BASE_URL}/api/eval-agent/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenValue}` },
      body: JSON.stringify({ name: "OIP Agent", metadata: {} }),
    });
    expect(regRes.ok).toBe(true);
    const regBody = await regRes.json();
    const agentId: number = regBody.id;
    const leaseId: string = regBody.leaseId;

    const agentsAfterRegister = await storage.getEvalAgentsByTokenId(tokenId);
    expect(agentsAfterRegister.length).toBeGreaterThan(0);
    const agentAfterRegister = agentsAfterRegister[0];

    expect(typeof agentAfterRegister.observedIp).toBe("string");
    expect((agentAfterRegister.observedIp || "").length).toBeGreaterThan(0);
    expect(agentAfterRegister.observedIpAt).toBeTruthy();
    const firstObservedAt = new Date(agentAfterRegister.observedIpAt as unknown as string).getTime();
    expect(Date.now() - firstObservedAt).toBeLessThan(30_000);

    // Heartbeat write is a fire-and-forget (`void`) call — poll briefly
    // instead of asserting instantly after the response comes back.
    await sleep(50);
    const hbRes = await fetch(`${BASE_URL}/api/eval-agent/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenValue}` },
      body: JSON.stringify({ agentId, leaseId, state: "idle", metadata: {} }),
    });
    expect(hbRes.ok).toBe(true);

    let advanced = false;
    for (let i = 0; i < 15; i++) {
      const agentsAfterHeartbeat = await storage.getEvalAgentsByTokenId(tokenId);
      const agentAfterHeartbeat = agentsAfterHeartbeat[0];
      const secondObservedAt = new Date(agentAfterHeartbeat.observedIpAt as unknown as string).getTime();
      if (secondObservedAt > firstObservedAt) {
        advanced = true;
        break;
      }
      await sleep(200);
    }
    expect(advanced).toBe(true);

    // Public listing must never expose the raw observed IP.
    const listRes = await fetch(`${BASE_URL}/api/eval-agents`);
    expect(listRes.ok).toBe(true);
    const listBody = await listRes.json();
    const listJson = JSON.stringify(listBody);
    expect(listJson).not.toContain("observedIp");
    expect(listJson).not.toContain("observed_ip");
  });
});
