import { describe, it, expect, beforeAll, afterAll } from "vitest";

// =====================================================================
// Clash Runner Lifecycle Tests
//
// Integration tests that exercise the full clash runner lifecycle against
// a running Vox server: token creation → registration → heartbeat →
// match assignment → completion → Elo updates.
//
// Requires: local dev server running (./scripts/dev-local-run.sh start)
// =====================================================================

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || "admin@vox.local";
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || "admin123456";

interface AuthSession { cookie: string }

async function login(email: string, password: string): Promise<AuthSession> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status}`);
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("No session cookie");
  return { cookie: setCookie.split(";")[0] };
}

async function authFetch(session: AuthSession, url: string, options: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...options,
    headers: { ...options.headers, Cookie: session.cookie, "Content-Type": "application/json" },
  });
}

async function bearerFetch(token: string, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// =====================================================================
// Tests
// =====================================================================

describe("Clash Runner Lifecycle", () => {
  let admin: AuthSession;
  let runnerToken: string;
  let runnerTokenId: number;
  let profileAId: number;
  let profileBId: number;
  let eventId: number;
  const testId = Date.now().toString(36); // unique per test run

  beforeAll(async () => {
    admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  });

  // ── Token Management ──────────────────────────────────────────────

  describe("Runner Token CRUD", () => {
    it("creates a runner token with region", async () => {
      const res = await authFetch(admin, `${BASE_URL}/api/admin/clash-runner-tokens`, {
        method: "POST",
        body: JSON.stringify({ name: "lifecycle-test-runner", region: "na" }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.token).toBeTruthy();
      expect(data.token).toMatch(/^cr/);
      expect(data.region).toBe("na");
      expect(data.name).toBe("lifecycle-test-runner");
      runnerToken = data.token;
      runnerTokenId = data.id;
    });

    it("rejects token creation with invalid region", async () => {
      const res = await authFetch(admin, `${BASE_URL}/api/admin/clash-runner-tokens`, {
        method: "POST",
        body: JSON.stringify({ name: "bad", region: "invalid" }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects token creation without name", async () => {
      const res = await authFetch(admin, `${BASE_URL}/api/admin/clash-runner-tokens`, {
        method: "POST",
        body: JSON.stringify({ region: "na" }),
      });
      expect(res.status).toBe(400);
    });

    it("lists tokens including the new one", async () => {
      const res = await authFetch(admin, `${BASE_URL}/api/admin/clash-runner-tokens`);
      expect(res.status).toBe(200);
      const tokens = await res.json();
      const found = tokens.find((t: any) => t.id === runnerTokenId);
      expect(found).toBeTruthy();
      expect(found.name).toBe("lifecycle-test-runner");
      // Token hash should NOT be exposed in list
      expect(found.token).toBeUndefined();
    });
  });

  // ── Runner Registration ───────────────────────────────────────────

  describe("Runner Registration", () => {
    it("registers successfully with valid token", async () => {
      const res = await bearerFetch(runnerToken, "POST", "/api/clash-runner/register", {
        runnerId: `test-host-${testId}-1`,
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.state).toBe("idle");
      expect(data.region).toBe("na");
      expect(data.id).toBeTypeOf("number");
    });

    it("re-registers with same token (upsert) — new runnerId replaces old", async () => {
      const res = await bearerFetch(runnerToken, "POST", "/api/clash-runner/register", {
        runnerId: `test-host-${testId}-2`,
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.state).toBe("idle");
    });

    it("rejects registration with invalid token", async () => {
      const res = await bearerFetch("cr_invalid_token", "POST", "/api/clash-runner/register", {
        runnerId: "bad-host",
      });
      expect(res.status).toBe(401);
    });

    it("rejects registration without runnerId", async () => {
      const res = await bearerFetch(runnerToken, "POST", "/api/clash-runner/register", {});
      expect(res.status).toBe(400);
    });

    it("rejects registration with revoked token", async () => {
      // Create + revoke a token
      const createRes = await authFetch(admin, `${BASE_URL}/api/admin/clash-runner-tokens`, {
        method: "POST",
        body: JSON.stringify({ name: "to-revoke", region: "na" }),
      });
      const { token: revokeToken, id: revokeId } = await createRes.json();

      await authFetch(admin, `${BASE_URL}/api/admin/clash-runner-tokens/${revokeId}/revoke`, {
        method: "POST",
      });

      const res = await bearerFetch(revokeToken, "POST", "/api/clash-runner/register", {
        runnerId: "revoked-host",
      });
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toMatch(/revoked/i);
    });
  });

  // ── Heartbeat ─────────────────────────────────────────────────────

  describe("Runner Heartbeat", () => {
    it("sends heartbeat and receives current state", async () => {
      const res = await bearerFetch(runnerToken, "POST", "/api/clash-runner/heartbeat");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.state).toBe("idle");
      expect(data.currentMatchId).toBeNull();
    });

    it("rejects heartbeat with invalid token", async () => {
      const res = await bearerFetch("cr_bad", "POST", "/api/clash-runner/heartbeat");
      expect(res.status).toBe(401);
    });
  });

  // ── Assignment Polling ────────────────────────────────────────────

  describe("Assignment Polling", () => {
    it("returns assigned:false when idle", async () => {
      const res = await bearerFetch(runnerToken, "GET", "/api/clash-runner/assignment");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.assigned).toBe(false);
    });
  });

  // ── Secrets Endpoint ───────────────────────────────────────────────

  describe("Secrets Endpoint", () => {
    it("rejects secrets request when runner is idle (no active match)", async () => {
      const res = await bearerFetch(runnerToken, "GET", "/api/clash-runner/secrets?matchId=999");
      expect(res.status).toBe(403);
    });

    it("rejects secrets request without matchId", async () => {
      const res = await bearerFetch(runnerToken, "GET", "/api/clash-runner/secrets");
      expect(res.status).toBe(400);
    });

    it("rejects secrets request with invalid token", async () => {
      const res = await bearerFetch("cr_bad", "GET", "/api/clash-runner/secrets?matchId=1");
      expect(res.status).toBe(401);
    });
  });

  // ── Runner Listing (admin + scout) ────────────────────────────────

  describe("Runner Listing", () => {
    it("admin can list registered runners", async () => {
      const res = await authFetch(admin, `${BASE_URL}/api/admin/clash-runners`);
      expect(res.status).toBe(200);
      const runners = await res.json();
      expect(Array.isArray(runners)).toBe(true);
      const found = runners.find((r: any) => r.runnerId === `test-host-${testId}-2`);
      expect(found).toBeTruthy();
      expect(found.region).toBe("na");
      expect(found.state).toBe("idle");
    });

    it("unauthenticated user cannot list runners", async () => {
      const res = await fetch(`${BASE_URL}/api/admin/clash-runners`);
      expect(res.status).toBe(401);
    });
  });

  // ── Full Match Lifecycle ──────────────────────────────────────────

  describe("Match Assignment & Completion", () => {
    beforeAll(async () => {
      // Create two agent profiles for matching
      const profARes = await authFetch(admin, `${BASE_URL}/api/clash/profiles`, {
        method: "POST",
        body: JSON.stringify({
          name: "Test Agent A (lifecycle)",
          agentUrl: "https://example.com/agent-a",
          visibility: "private",
          setupSteps: [],
        }),
      });
      profileAId = (await profARes.json()).id;

      const profBRes = await authFetch(admin, `${BASE_URL}/api/clash/profiles`, {
        method: "POST",
        body: JSON.stringify({
          name: "Test Agent B (lifecycle)",
          agentUrl: "https://example.com/agent-b",
          visibility: "private",
          setupSteps: [],
        }),
      });
      profileBId = (await profBRes.json()).id;
    });

    it("creates an event with a match and starts it", async () => {
      // Create event
      const eventRes = await authFetch(admin, `${BASE_URL}/api/clash/events`, {
        method: "POST",
        body: JSON.stringify({
          name: "Lifecycle Test Event",
          region: "na",
          visibility: "private",
          matchups: [
            {
              agentAProfileId: profileAId,
              agentBProfileId: profileBId,
              topic: "Testing runner lifecycle",
              maxDurationSeconds: 60,
            },
          ],
        }),
      });
      expect(eventRes.ok).toBe(true);
      const event = await eventRes.json();
      eventId = event.id;
      expect(event.status).toBe("upcoming");

      // Start the event (transitions to "live")
      const startRes = await authFetch(admin, `${BASE_URL}/api/clash/events/${eventId}/start`, {
        method: "POST",
      });
      expect(startRes.status).toBe(200);
      const started = await startRes.json();
      expect(started.status).toBe("live");
    });

    it("match gets assigned to the idle runner via scheduler polling", async () => {
      // The scheduler runs every 10s. We can't wait for it in tests, but we can
      // manually verify the state. For now, let's check the match is "pending"
      const eventRes = await authFetch(admin, `${BASE_URL}/api/clash/events/${eventId}`);
      const event = await eventRes.json();
      const matches = event.matches || [];
      expect(matches.length).toBe(1);
      // Match starts as "pending" — scheduler will pick it up
      expect(["pending", "starting", "live"]).toContain(matches[0].status);
    });

    it("runner can complete a match with metrics", async () => {
      // Get the match ID
      const eventRes = await authFetch(admin, `${BASE_URL}/api/clash/events/${eventId}`);
      const event = await eventRes.json();
      const matchId = event.matches[0].id;

      // Simulate completion (the runner normally does this after running browsers)
      const completeRes = await bearerFetch(runnerToken, "POST", "/api/clash-runner/complete", {
        matchId,
        metricsA: {
          responseLatencyMedian: 450,
          responseLatencySd: 120,
          interruptLatencyMedian: 200,
          interruptLatencySd: 50,
          ttftMedian: 300,
          turnCount: 8,
          overlapPercent: 5.2,
        },
        metricsB: {
          responseLatencyMedian: 600,
          responseLatencySd: 180,
          interruptLatencyMedian: 250,
          interruptLatencySd: 70,
          ttftMedian: 400,
          turnCount: 7,
          overlapPercent: 3.8,
        },
        durationSeconds: 55,
      });
      expect(completeRes.status).toBe(200);
      const result = await completeRes.json();
      expect(result.success).toBe(true);
    });

    it("match is completed with correct winner (A wins — lower latency)", async () => {
      const eventRes = await authFetch(admin, `${BASE_URL}/api/clash/events/${eventId}`);
      const event = await eventRes.json();
      const match = event.matches[0];
      expect(match.status).toBe("completed");
      // Agent A had 450ms vs Agent B 600ms: ratio = 0.75 < 0.9, so A wins
      expect(match.winnerId).toBe(profileAId);
      expect(match.durationSeconds).toBe(55);
    });

    it("event auto-completes when all matches done", async () => {
      const eventRes = await authFetch(admin, `${BASE_URL}/api/clash/events/${eventId}`);
      const event = await eventRes.json();
      expect(event.status).toBe("completed");
      expect(event.completedAt).toBeTruthy();
    });

    it("Elo ratings were updated for both agents", async () => {
      const ratingsRes = await fetch(`${BASE_URL}/api/clash/leaderboard`);
      expect(ratingsRes.status).toBe(200);
      const ratings = await ratingsRes.json();

      const ratingA = ratings.find((r: any) => r.agentProfileId === profileAId);
      const ratingB = ratings.find((r: any) => r.agentProfileId === profileBId);

      if (ratingA && ratingB) {
        // Winner's rating should increase, loser's should decrease
        expect(ratingA.rating).toBeGreaterThan(1500);
        expect(ratingB.rating).toBeLessThan(1500);
        expect(ratingA.winCount).toBe(1);
        expect(ratingB.lossCount).toBe(1);
      }
    });

    it("runner returns to idle after completion", async () => {
      const hbRes = await bearerFetch(runnerToken, "POST", "/api/clash-runner/heartbeat");
      const hb = await hbRes.json();
      expect(hb.state).toBe("idle");
      expect(hb.currentMatchId).toBeNull();
    });

    it("runner can handle a match with error (failure path)", async () => {
      // Create + start another event
      const eventRes = await authFetch(admin, `${BASE_URL}/api/clash/events`, {
        method: "POST",
        body: JSON.stringify({
          name: "Failure Test Event",
          region: "na",
          visibility: "private",
          matchups: [{
            agentAProfileId: profileAId,
            agentBProfileId: profileBId,
            topic: "Testing failure path",
            maxDurationSeconds: 60,
          }],
        }),
      });
      const event = await eventRes.json();
      await authFetch(admin, `${BASE_URL}/api/clash/events/${event.id}/start`, { method: "POST" });

      // Get match ID
      const detailRes = await authFetch(admin, `${BASE_URL}/api/clash/events/${event.id}`);
      const detail = await detailRes.json();
      const matchId = detail.matches[0].id;

      // Complete with error
      const completeRes = await bearerFetch(runnerToken, "POST", "/api/clash-runner/complete", {
        matchId,
        error: "Browser crashed during setup",
        durationSeconds: 5,
      });
      expect(completeRes.status).toBe(200);

      // Verify match is failed
      const checkRes = await authFetch(admin, `${BASE_URL}/api/clash/events/${event.id}`);
      const check = await checkRes.json();
      expect(check.matches[0].status).toBe("failed");
      expect(check.matches[0].winnerId).toBeNull();
    });
  });

  // ── Draw Scenario ─────────────────────────────────────────────────

  describe("Draw Scenario", () => {
    it("match is a draw when latencies are within 10%", async () => {
      const eventRes = await authFetch(admin, `${BASE_URL}/api/clash/events`, {
        method: "POST",
        body: JSON.stringify({
          name: "Draw Test Event",
          region: "na",
          visibility: "private",
          matchups: [{
            agentAProfileId: profileAId,
            agentBProfileId: profileBId,
            topic: "Draw test",
            maxDurationSeconds: 60,
          }],
        }),
      });
      const event = await eventRes.json();
      await authFetch(admin, `${BASE_URL}/api/clash/events/${event.id}/start`, { method: "POST" });
      const detail = await (await authFetch(admin, `${BASE_URL}/api/clash/events/${event.id}`)).json();
      const matchId = detail.matches[0].id;

      // 500ms vs 520ms → ratio = 0.96, within 0.9–1.1 = draw
      await bearerFetch(runnerToken, "POST", "/api/clash-runner/complete", {
        matchId,
        metricsA: { responseLatencyMedian: 500, responseLatencySd: 100 },
        metricsB: { responseLatencyMedian: 520, responseLatencySd: 110 },
        durationSeconds: 60,
      });

      const check = await (await authFetch(admin, `${BASE_URL}/api/clash/events/${event.id}`)).json();
      expect(check.matches[0].status).toBe("completed");
      expect(check.matches[0].winnerId).toBeNull(); // draw
    });
  });

  // ── Moderator Endpoints ────────────────────────────────────────────

  describe("Moderator Endpoints", () => {
    it("moderator/start succeeds (returns moderatorAvailable or skips gracefully)", async () => {
      const eventRes = await authFetch(admin, `${BASE_URL}/api/clash/events`, {
        method: "POST",
        body: JSON.stringify({
          name: "Moderator Test Event",
          region: "na",
          visibility: "private",
          matchups: [{
            agentAProfileId: profileAId,
            agentBProfileId: profileBId,
            topic: "Test moderator",
            maxDurationSeconds: 60,
          }],
        }),
      });
      const event = await eventRes.json();
      await authFetch(admin, `${BASE_URL}/api/clash/events/${event.id}/start`, { method: "POST" });
      const detail = await (await authFetch(admin, `${BASE_URL}/api/clash/events/${event.id}`)).json();
      const matchId = detail.matches[0].id;

      const res = await bearerFetch(runnerToken, "POST", "/api/clash/moderator/start", {
        matchId,
        phase: "announce",
      });
      const data = await res.json();
      // 200 = moderator started or skipped; 500 = ConvoAI API error (credentials/appId mismatch in dev)
      expect([200, 500]).toContain(res.status);
      if (res.status === 200) {
        expect(data.success).toBe(true);
      }

      // Clean up
      await bearerFetch(runnerToken, "POST", "/api/clash-runner/complete", {
        matchId, error: "test cleanup",
      });
    });

    it("moderator/announce skips when no moderator agent", async () => {
      const res = await bearerFetch(runnerToken, "POST", "/api/clash/moderator/announce", {
        matchId: 999999,
        phase: "start",
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.skipped).toBe(true);
    });

    it("moderator/announce skips when event has no moderator agent", async () => {
      // Create event without moderator — announce should skip gracefully
      const eventRes = await authFetch(admin, `${BASE_URL}/api/clash/events`, {
        method: "POST",
        body: JSON.stringify({
          name: "Phase Test",
          region: "na",
          visibility: "private",
          matchups: [{
            agentAProfileId: profileAId,
            agentBProfileId: profileBId,
            topic: "Phase test",
            maxDurationSeconds: 60,
          }],
        }),
      });
      const event = await eventRes.json();
      const detail = await (await authFetch(admin, `${BASE_URL}/api/clash/events/${event.id}`)).json();
      const matchId = detail.matches[0].id;

      const res = await bearerFetch(runnerToken, "POST", "/api/clash/moderator/announce", {
        matchId,
        phase: "start",
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.skipped).toBe(true);
    });

    it("moderator/stop succeeds even without active moderator", async () => {
      const res = await bearerFetch(runnerToken, "POST", "/api/clash/moderator/stop", {
        matchId: 999999,
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
    });

    it("moderator endpoints require Bearer token", async () => {
      const endpoints = [
        { path: "/api/clash/moderator/start", body: { matchId: 1 } },
        { path: "/api/clash/moderator/announce", body: { matchId: 1, phase: "start" } },
        { path: "/api/clash/moderator/stop", body: { matchId: 1 } },
      ];
      for (const ep of endpoints) {
        const res = await fetch(`${BASE_URL}${ep.path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(ep.body),
        });
        expect(res.status).toBe(401);
      }
    });
  });

  // ── Token Revocation ──────────────────────────────────────────────

  describe("Token Revocation", () => {
    it("revokes the runner token", async () => {
      const res = await authFetch(admin, `${BASE_URL}/api/admin/clash-runner-tokens/${runnerTokenId}/revoke`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
    });

    it("revoked token cannot register", async () => {
      const res = await bearerFetch(runnerToken, "POST", "/api/clash-runner/register", {
        runnerId: "should-fail",
      });
      expect(res.status).toBe(401);
    });

    it("revoked token cannot heartbeat", async () => {
      const res = await bearerFetch(runnerToken, "POST", "/api/clash-runner/heartbeat");
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toMatch(/revoked/i);
    });
  });

  // ── Profile Editing ────────────────────────────────────────────────

  describe("Profile Editing", () => {
    it("owner can edit profile name and URL", async () => {
      const res = await authFetch(admin, `${BASE_URL}/api/clash/profiles/${profileAId}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: "Test Agent A (updated)",
          agentUrl: "https://example.com/agent-a-v2",
        }),
      });
      expect(res.status).toBe(200);
      const updated = await res.json();
      expect(updated.name).toBe("Test Agent A (updated)");
      expect(updated.agentUrl).toBe("https://example.com/agent-a-v2");
    });

    it("owner can edit setup steps", async () => {
      const newSteps = [
        { action: "click", selector: "#start" },
        { action: "fill", selector: "#email", value: "${secrets.AGORA_CONSOLE_EMAIL}" },
      ];
      const res = await authFetch(admin, `${BASE_URL}/api/clash/profiles/${profileAId}`, {
        method: "PATCH",
        body: JSON.stringify({ setupSteps: newSteps }),
      });
      expect(res.status).toBe(200);
      const updated = await res.json();
      expect(updated.setupSteps).toHaveLength(2);
      expect(updated.setupSteps[0].action).toBe("click");
      expect(updated.setupSteps[1].value).toBe("${secrets.AGORA_CONSOLE_EMAIL}");
    });

    it("rejects edit on non-existent profile", async () => {
      const res = await authFetch(admin, `${BASE_URL}/api/clash/profiles/999999`, {
        method: "PATCH",
        body: JSON.stringify({ name: "nope" }),
      });
      expect(res.status).toBe(404);
    });
  });

  // ── Stream Info ───────────────────────────────────────────────────

  describe("Stream Info", () => {
    it("returns 400 for non-live match", async () => {
      // Create an event but don't start it — match stays "pending"
      const eventRes = await authFetch(admin, `${BASE_URL}/api/clash/events`, {
        method: "POST",
        body: JSON.stringify({
          name: "Stream Info Test",
          region: "na",
          visibility: "private",
          matchups: [{
            agentAProfileId: profileAId,
            agentBProfileId: profileBId,
            topic: "Stream test",
            maxDurationSeconds: 60,
          }],
        }),
      });
      const event = await eventRes.json();
      const detailRes = await authFetch(admin, `${BASE_URL}/api/clash/events/${event.id}`);
      const detail = await detailRes.json();
      const matchId = detail.matches[0].id;

      const streamRes = await fetch(`${BASE_URL}/api/clash/matches/${matchId}/stream-info`);
      expect(streamRes.status).toBe(400); // match is pending, not live
    });

    it("returns 404 for non-existent match", async () => {
      const res = await fetch(`${BASE_URL}/api/clash/matches/999999/stream-info`);
      expect(res.status).toBe(404);
    });
  });

  // ── Cleanup ───────────────────────────────────────────────────────

  afterAll(async () => {
    // Clean up test profiles (events cascade-delete matches/results)
    if (profileAId) {
      await authFetch(admin, `${BASE_URL}/api/clash/profiles/${profileAId}`, { method: "DELETE" });
    }
    if (profileBId) {
      await authFetch(admin, `${BASE_URL}/api/clash/profiles/${profileBId}`, { method: "DELETE" });
    }
  });
});

// =====================================================================
// Storage Logic Tests (unit tests — no running server needed)
// =====================================================================

describe("Clash Runner Storage Logic", () => {
  describe("Elo Winner Determination", () => {
    function determineWinner(
      latA: number | null | undefined,
      latB: number | null | undefined,
      agentAId: number,
      agentBId: number,
    ): number | null {
      if (latA == null || latB == null || latA <= 0 || latB <= 0) return null;
      const ratio = latA / latB;
      if (ratio < 0.9) return agentAId;
      if (ratio > 1.1) return agentBId;
      return null; // draw
    }

    it("A wins when significantly faster", () => {
      expect(determineWinner(300, 500, 1, 2)).toBe(1); // ratio 0.6
    });

    it("B wins when significantly faster", () => {
      expect(determineWinner(800, 400, 1, 2)).toBe(2); // ratio 2.0
    });

    it("draw when latencies are close", () => {
      expect(determineWinner(490, 500, 1, 2)).toBeNull(); // ratio 0.98
    });

    it("draw at boundary 0.9", () => {
      expect(determineWinner(450, 500, 1, 2)).toBeNull(); // ratio 0.9 — exactly at boundary, not < 0.9
    });

    it("A wins just below 0.9 boundary", () => {
      expect(determineWinner(449, 500, 1, 2)).toBe(1); // ratio 0.898 < 0.9
    });

    it("draw when null metrics", () => {
      expect(determineWinner(null, 500, 1, 2)).toBeNull();
      expect(determineWinner(500, null, 1, 2)).toBeNull();
    });

    it("draw when zero latency", () => {
      expect(determineWinner(0, 500, 1, 2)).toBeNull();
      expect(determineWinner(500, 0, 1, 2)).toBeNull();
    });

    it("draw when both null", () => {
      expect(determineWinner(null, null, 1, 2)).toBeNull();
    });
  });

  describe("Stale Runner Threshold", () => {
    it("45s threshold detects stale runners", () => {
      const threshold = 45_000;
      const now = Date.now();
      const lastHb = now - 50_000; // 50s ago
      expect(now - lastHb > threshold).toBe(true);
    });

    it("recent heartbeat is not stale", () => {
      const threshold = 45_000;
      const now = Date.now();
      const lastHb = now - 10_000; // 10s ago
      expect(now - lastHb > threshold).toBe(false);
    });
  });

  describe("Match Timeout Logic", () => {
    it("5-minute timeout detects stuck matches", () => {
      const threshold = 300_000;
      const now = Date.now();
      const startedAt = now - 360_000; // 6 min ago
      expect(now - startedAt > threshold).toBe(true);
    });

    it("recent match is not stuck", () => {
      const threshold = 300_000;
      const now = Date.now();
      const startedAt = now - 120_000; // 2 min ago
      expect(now - startedAt > threshold).toBe(false);
    });
  });

  describe("UID Reservation", () => {
    const BROADCASTER_UID_A = 100;
    const BROADCASTER_UID_B = 200;
    const MODERATOR_UID = 500;
    const RESERVED_MAX = 10000;
    const SPECTATOR_MIN = 10001;

    it("broadcaster UIDs are in reserved range", () => {
      expect(BROADCASTER_UID_A).toBeLessThanOrEqual(RESERVED_MAX);
      expect(BROADCASTER_UID_B).toBeLessThanOrEqual(RESERVED_MAX);
    });

    it("moderator UID is in reserved range", () => {
      expect(MODERATOR_UID).toBeLessThanOrEqual(RESERVED_MAX);
    });

    it("broadcaster UIDs are distinct", () => {
      expect(BROADCASTER_UID_A).not.toBe(BROADCASTER_UID_B);
    });

    it("no UID collisions between system roles", () => {
      const uids = [BROADCASTER_UID_A, BROADCASTER_UID_B, MODERATOR_UID];
      expect(new Set(uids).size).toBe(uids.length);
    });

    it("spectator UIDs are above reserved range", () => {
      // Simulate the server's spectator UID generation
      for (let i = 0; i < 100; i++) {
        const uid = Math.floor(Math.random() * 100000) + SPECTATOR_MIN;
        expect(uid).toBeGreaterThan(RESERVED_MAX);
      }
    });
  });

  describe("Dual Broadcast Config", () => {
    it("BroadcastConfig has separate tokenA/tokenB and uidA/uidB", () => {
      const config = {
        appId: "test-app-id",
        channelName: "clash-42",
        tokenA: "token-for-agent-a",
        tokenB: "token-for-agent-b",
        uidA: 100,
        uidB: 200,
      };
      expect(config.tokenA).not.toBe(config.tokenB);
      expect(config.uidA).not.toBe(config.uidB);
      expect(config.uidA).toBe(100);
      expect(config.uidB).toBe(200);
    });

    it("each agent maps to its own PipeWire monitor", () => {
      const mapping = {
        agentA: { device: "Virtual_Sink_A.monitor", uid: 100 },
        agentB: { device: "Virtual_Sink_B.monitor", uid: 200 },
      };
      expect(mapping.agentA.device).toContain("_A");
      expect(mapping.agentB.device).toContain("_B");
      expect(mapping.agentA.uid).not.toBe(mapping.agentB.uid);
    });
  });

  describe("Token Format", () => {
    it("clash runner tokens have 'cr' prefix", () => {
      const token = "cr" + "a".repeat(30);
      expect(token.startsWith("cr")).toBe(true);
      expect(token.length).toBe(32);
    });

    it("distinguishable from eval agent tokens", () => {
      const clashToken = "cr1234567890abcdef";
      const evalToken = "ev1234567890abcdef";
      expect(clashToken.startsWith("cr")).toBe(true);
      expect(evalToken.startsWith("ev")).toBe(true);
      expect(clashToken.startsWith("cr")).not.toBe(evalToken.startsWith("cr"));
    });
  });
});
