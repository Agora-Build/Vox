import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { storage, pool } from "../server/storage";

// Task 3 (designs/2026-10-22-network-tags-design.md "Data model" / "visibility
// rules"): hand-set tags and link type through the API.
//
// Flow tags: POST/PATCH /api/eval-flows accept `tags`, validated with
// shared/tags.ts's parseTags; editing follows the existing evalFlow edit rule
// (isOwnerOrOrgManager — a PATCH is 403 for anyone else, admin included isn't
// tested here since that's the pre-existing rule, just reused).
//
// Agent tags: PATCH /api/eval-agents/:id/tags — only the creator of the
// agent's TOKEN may set them (not the agent's own operator process, not an
// org manager, not an admin).
//
// Link type: register/heartbeat accept optional `linkType` — a LINK_VALUES
// member is stored, an invalid string is ignored (no error, old value kept),
// absent leaves it, explicit null clears it.
//
// GET /api/eval-agents exposes `tags`/`linkType`/`canEditTags`, never
// `observedIp`.

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;
const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || "admin@vox.local";
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || "admin123456";

interface AuthSession { cookie: string; userId: number; email: string }

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`Login failed for ${email}: ${res.status}`);
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("No session cookie received");
  return setCookie.split(";")[0];
}

async function jsonFetch(url: string, opts: RequestInit & { cookie?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(opts.headers as Record<string, string> | undefined) };
  if (opts.cookie) headers.Cookie = opts.cookie;
  const res = await fetch(url, { ...opts, headers });
  const body = await res.json().catch(() => undefined);
  return { status: res.status, ok: res.ok, body };
}

d("network tags: hand-set tags and link type through the API", () => {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  let providerId = "";
  let adminCookie = "";
  const userA: AuthSession = { cookie: "", userId: 0, email: `ntagsA-${stamp}@example.com` };
  const userB: AuthSession = { cookie: "", userId: 0, email: `ntagsB-${stamp}@example.com` };

  const flowIds: number[] = [];
  const tokenIds: number[] = [];

  async function makePremiumUser(session: AuthSession): Promise<void> {
    const invite = await jsonFetch(`${BASE_URL}/api/admin/invite`, {
      method: "POST", cookie: adminCookie,
      body: JSON.stringify({ email: session.email, plan: "premium" }),
    });
    expect(invite.ok).toBe(true);
    const username = session.email.split("@")[0].replace(/-/g, "");
    await jsonFetch(`${BASE_URL}/api/auth/register`, {
      method: "POST",
      body: JSON.stringify({ username, password: "TestPass123!", token: invite.body.token }),
    });
    const row = await pool.query("SELECT id FROM users WHERE email = $1", [session.email]);
    session.userId = row.rows[0].id;
    session.cookie = await login(session.email, "TestPass123!");
  }

  beforeAll(async () => {
    adminCookie = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    const providers = await storage.getAllProviders();
    expect(providers.length).toBeGreaterThan(0);
    providerId = providers[0].id;
    await makePremiumUser(userA);
    await makePremiumUser(userB);
  });

  afterAll(async () => {
    if (!hasDb) return;
    if (tokenIds.length) {
      await pool.query(`DELETE FROM eval_agents WHERE token_id = ANY($1)`, [tokenIds]).catch(() => {});
      await pool.query(`DELETE FROM eval_agent_tokens WHERE id = ANY($1)`, [tokenIds]).catch(() => {});
    }
    if (flowIds.length) {
      await pool.query(`DELETE FROM eval_flows WHERE id = ANY($1)`, [flowIds]).catch(() => {});
    }
    const ids = [userA.userId, userB.userId].filter(Boolean);
    if (ids.length) {
      await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [ids]).catch(() => {});
    }
  });

  // ---- Flow tags ----

  it("saves normalized tags on create, and rejects an invalid tag with 400", async () => {
    const created = await jsonFetch(`${BASE_URL}/api/eval-flows`, {
      method: "POST", cookie: userA.cookie,
      body: JSON.stringify({
        name: `ntags-flow-${stamp}`, providerId, visibility: "public",
        tags: [" Line : Twilio ", "Codec:Opus"],
      }),
    });
    expect(created.status).toBe(200);
    flowIds.push(created.body.id);
    expect(created.body.tags).toEqual(
      expect.arrayContaining([{ key: "line", value: "twilio" }, { key: "codec", value: "opus" }]),
    );
    expect(created.body.tags.length).toBe(2);

    const bad = await jsonFetch(`${BASE_URL}/api/eval-flows`, {
      method: "POST", cookie: userA.cookie,
      body: JSON.stringify({ name: `ntags-bad-${stamp}`, providerId, visibility: "public", tags: ["not-a-tag"] }),
    });
    expect(bad.status).toBe(400);
    expect(typeof bad.body.error).toBe("string");
  });

  it("GET returns tags and lineLookup on the flow", async () => {
    const get = await jsonFetch(`${BASE_URL}/api/eval-flows/${flowIds[0]}`, { cookie: userA.cookie });
    expect(get.status).toBe(200);
    expect(get.body.tags).toEqual(expect.arrayContaining([{ key: "line", value: "twilio" }]));
    expect("lineLookup" in get.body).toBe(true);
  });

  it("PATCH updates tags when provided, validates them, and leaves them unchanged when omitted", async () => {
    const invalid = await jsonFetch(`${BASE_URL}/api/eval-flows/${flowIds[0]}`, {
      method: "PATCH", cookie: userA.cookie,
      body: JSON.stringify({ tags: ["link:not-a-link-value"] }),
    });
    expect(invalid.status).toBe(400);

    const patched = await jsonFetch(`${BASE_URL}/api/eval-flows/${flowIds[0]}`, {
      method: "PATCH", cookie: userA.cookie,
      body: JSON.stringify({ tags: ["codec:g711"] }),
    });
    expect(patched.status).toBe(200);
    expect(patched.body.tags).toEqual([{ key: "codec", value: "g711" }]);

    // PATCH without `tags` must leave the stored tags unchanged.
    const untouched = await jsonFetch(`${BASE_URL}/api/eval-flows/${flowIds[0]}`, {
      method: "PATCH", cookie: userA.cookie,
      body: JSON.stringify({ description: "no tags field here" }),
    });
    expect(untouched.status).toBe(200);
    expect(untouched.body.tags).toEqual([{ key: "codec", value: "g711" }]);
  });

  it("a flow refuses the agent's known keys (isp/link/sim) with a 400 naming the agent — console and v1 (finding 4)", async () => {
    const createIsp = await jsonFetch(`${BASE_URL}/api/eval-flows`, {
      method: "POST", cookie: userA.cookie,
      body: JSON.stringify({ name: `ntags-isp-${stamp}`, providerId, visibility: "public", tags: ["isp:att"] }),
    });
    expect(createIsp.status).toBe(400);
    expect(createIsp.body.error).toBe("isp is detected from the eval agent's network — set it on the agent, not the flow");

    const patchLink = await jsonFetch(`${BASE_URL}/api/eval-flows/${flowIds[0]}`, {
      method: "PATCH", cookie: userA.cookie, body: JSON.stringify({ tags: ["line:twilio", "link:wifi"] }),
    });
    expect(patchLink.status).toBe(400);
    expect(patchLink.body.error).toContain("set it on the agent");

    const v1Create = await jsonFetch(`${BASE_URL}/api/v1/eval-flows`, {
      method: "POST", cookie: userA.cookie,
      body: JSON.stringify({ name: `ntags-v1-${stamp}`, providerId, visibility: "public", tags: ["sim:att"] }),
    });
    expect(v1Create.status).toBe(400);
    expect(v1Create.body.error).toContain("set it on the agent");

    const v1Put = await jsonFetch(`${BASE_URL}/api/v1/eval-flows/${flowIds[0]}`, {
      method: "PUT", cookie: userA.cookie, body: JSON.stringify({ tags: ["isp:comcast"] }),
    });
    expect(v1Put.status).toBe(400);
    expect(v1Put.body.error).toContain("set it on the agent");

    // Nothing was written by the refused saves.
    expect((await storage.getEvalFlow(flowIds[0]))!.tags).toEqual([{ key: "codec", value: "g711" }]);
  });

  it("refuses a PATCH from someone who isn't the evalFlow's owner (403, reuses the existing edit rule)", async () => {
    const res = await jsonFetch(`${BASE_URL}/api/eval-flows/${flowIds[0]}`, {
      method: "PATCH", cookie: userB.cookie,
      body: JSON.stringify({ tags: ["line:bandwidth"] }),
    });
    expect(res.status).toBe(403);
  });

  // ---- Agent tags + link type ----

  d("agent tags and link type", () => {
    let tokenValue = "";
    let tokenId = 0;
    let agentId = 0;
    let leaseId = "";

    beforeAll(async () => {
      // Private token owned by userA (no admin bypass per the permission model).
      const tok = await jsonFetch(`${BASE_URL}/api/eval-agent-tokens`, {
        method: "POST", cookie: userA.cookie,
        body: JSON.stringify({ name: `ntags-token-${stamp}` }),
      });
      expect(tok.status).toBe(200);
      tokenValue = tok.body.token;
      tokenId = tok.body.id;
      tokenIds.push(tokenId);

      const reg = await jsonFetch(`${BASE_URL}/api/eval-agent/register`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenValue}` },
        body: JSON.stringify({ name: "ntags agent", metadata: {}, linkType: "wifi" }),
      });
      expect(reg.status).toBe(200);
      agentId = reg.body.id;
      leaseId = reg.body.leaseId;
    });

    it("stores a LINK_VALUES link type on register", async () => {
      const agent = await storage.getEvalAgent(agentId);
      expect(agent?.linkType).toBe("wifi");
    });

    it("heartbeat: ignores an invalid linkType silently (keeps the old value)", async () => {
      const hb = await jsonFetch(`${BASE_URL}/api/eval-agent/heartbeat`, {
        method: "POST", headers: { Authorization: `Bearer ${tokenValue}` },
        body: JSON.stringify({ agentId, leaseId, state: "idle", linkType: "not-a-real-link" }),
      });
      expect(hb.status).toBe(200);
      const agent = await storage.getEvalAgent(agentId);
      expect(agent?.linkType).toBe("wifi");
    });

    it("heartbeat: absent linkType leaves the stored value unchanged", async () => {
      const hb = await jsonFetch(`${BASE_URL}/api/eval-agent/heartbeat`, {
        method: "POST", headers: { Authorization: `Bearer ${tokenValue}` },
        body: JSON.stringify({ agentId, leaseId, state: "idle" }),
      });
      expect(hb.status).toBe(200);
      const agent = await storage.getEvalAgent(agentId);
      expect(agent?.linkType).toBe("wifi");
    });

    it("heartbeat: a valid linkType updates it; explicit null clears it", async () => {
      const hb1 = await jsonFetch(`${BASE_URL}/api/eval-agent/heartbeat`, {
        method: "POST", headers: { Authorization: `Bearer ${tokenValue}` },
        body: JSON.stringify({ agentId, leaseId, state: "idle", linkType: "cellular" }),
      });
      expect(hb1.status).toBe(200);
      expect((await storage.getEvalAgent(agentId))?.linkType).toBe("cellular");

      const hb2 = await jsonFetch(`${BASE_URL}/api/eval-agent/heartbeat`, {
        method: "POST", headers: { Authorization: `Bearer ${tokenValue}` },
        body: JSON.stringify({ agentId, leaseId, state: "idle", linkType: null }),
      });
      expect(hb2.status).toBe(200);
      expect((await storage.getEvalAgent(agentId))?.linkType).toBeNull();
    });

    it("PATCH /api/eval-agents/:id/tags: 404 for an unknown agent", async () => {
      const res = await jsonFetch(`${BASE_URL}/api/eval-agents/999999999/tags`, {
        method: "PATCH", cookie: userA.cookie,
        body: JSON.stringify({ tags: ["isp:comcast"] }),
      });
      expect(res.status).toBe(404);
    });

    it("PATCH /api/eval-agents/:id/tags: 403 for anyone but the token's creator — including another premium user and an admin", async () => {
      const asB = await jsonFetch(`${BASE_URL}/api/eval-agents/${agentId}/tags`, {
        method: "PATCH", cookie: userB.cookie,
        body: JSON.stringify({ tags: ["isp:comcast"] }),
      });
      expect(asB.status).toBe(403);

      const asAdmin = await jsonFetch(`${BASE_URL}/api/eval-agents/${agentId}/tags`, {
        method: "PATCH", cookie: adminCookie,
        body: JSON.stringify({ tags: ["isp:comcast"] }),
      });
      expect(asAdmin.status).toBe(403);
    });

    it("PATCH /api/eval-agents/:id/tags: 400 on an invalid tag", async () => {
      const res = await jsonFetch(`${BASE_URL}/api/eval-agents/${agentId}/tags`, {
        method: "PATCH", cookie: userA.cookie,
        body: JSON.stringify({ tags: ["link:not-a-link-value"] }),
      });
      expect(res.status).toBe(400);
    });

    it("PATCH /api/eval-agents/:id/tags: line belongs to the flow — 400 (finding 4)", async () => {
      const res = await jsonFetch(`${BASE_URL}/api/eval-agents/${agentId}/tags`, {
        method: "PATCH", cookie: userA.cookie,
        body: JSON.stringify({ tags: ["isp:comcast", "line:twilio"] }),
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("line belongs to the eval flow's dialled number — set it on the flow, not the agent");
    });

    it("PATCH /api/eval-agents/:id/tags: the token's creator can set normalized tags", async () => {
      const res = await jsonFetch(`${BASE_URL}/api/eval-agents/${agentId}/tags`, {
        method: "PATCH", cookie: userA.cookie,
        body: JSON.stringify({ tags: [" ISP : Comcast "] }),
      });
      expect(res.status).toBe(200);
      const agent = await storage.getEvalAgent(agentId);
      expect(agent?.tags).toEqual([{ key: "isp", value: "comcast" }]);
    });

    it("PATCH /api/eval-agents/:id/tags without a tags field is a 400, never a silent clear (finding 6)", async () => {
      for (const body of [{}, { tag: ["isp:comcast"] }]) {
        const res = await jsonFetch(`${BASE_URL}/api/eval-agents/${agentId}/tags`, {
          method: "PATCH", cookie: userA.cookie, body: JSON.stringify(body),
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe("tags is required — send [] to clear");
      }
      const noBody = await jsonFetch(`${BASE_URL}/api/eval-agents/${agentId}/tags`, { method: "PATCH", cookie: userA.cookie });
      expect(noBody.status).toBe(400);
      expect((await storage.getEvalAgent(agentId))?.tags).toEqual([{ key: "isp", value: "comcast" }]);
    });

    it("GET /api/eval-agents exposes tags/linkType/canEditTags and never observedIp", async () => {
      const asOwner = await jsonFetch(`${BASE_URL}/api/eval-agents`, { cookie: userA.cookie });
      expect(asOwner.status).toBe(200);
      const mine = asOwner.body.find((a: { id: number }) => a.id === agentId);
      expect(mine).toBeTruthy();
      expect(mine.tags).toEqual([{ key: "isp", value: "comcast" }]);
      expect(mine.canEditTags).toBe(true);
      expect(JSON.stringify(mine)).not.toContain("observedIp");
      expect(JSON.stringify(mine)).not.toContain("observed_ip");

      const asOther = await jsonFetch(`${BASE_URL}/api/eval-agents`, { cookie: userB.cookie });
      // This agent's token is private (userA's own) — it's invisible to userB,
      // which also means canEditTags can't be asserted false on it directly;
      // the admin view is the reachable negative instead.
      expect(asOther.body.find((a: { id: number }) => a.id === agentId)).toBeUndefined();

      const asAdmin = await jsonFetch(`${BASE_URL}/api/eval-agents`, { cookie: adminCookie });
      const asAdminRow = asAdmin.body.find((a: { id: number }) => a.id === agentId);
      expect(asAdminRow).toBeTruthy(); // admin sees private agents (existing visibility rule)
      expect(asAdminRow.canEditTags).toBe(false); // but may not edit its tags
    });
  });
});
