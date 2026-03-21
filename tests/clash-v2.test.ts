import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer, type Server } from "http";
import { WebSocket } from "ws";

// =====================================================================
// Practical Clash v2 Tests
// Tests that import and exercise real code — not string pattern matching.
// =====================================================================

// --- Agora module: import real exported functions ---
import {
  isAgoraConfigured,
  isModeratorConfigured,
  generateChannelName,
  generateEventChannelName,
  buildAnnouncementPrompt,
  buildBriefingPrompt,
  buildStartPrompt,
  buildEndPrompt,
  buildEventAnnouncementPrompt,
  buildMatchTransitionPrompt,
} from "../server/agora";

// --- Storage helpers: import real hash/token functions ---
import { hashToken, generateSecureToken } from "../server/storage";

// --- WebSocket hub: import real functions ---
import { setupClashWebSocket, broadcastToSpectators, getSpectatorCount } from "../server/clash-ws";

// --- Cron: import real parser ---
import { parseNextCronRun, validateCronExpression } from "../server/cron";

// =====================================================================
// 1. Agora — Real function calls
// =====================================================================

describe("Agora Functions (real imports)", () => {
  describe("isAgoraConfigured", () => {
    it("returns false when env vars not set", () => {
      const orig = { id: process.env.AGORA_APP_ID, cert: process.env.AGORA_APP_CERTIFICATE };
      delete process.env.AGORA_APP_ID;
      delete process.env.AGORA_APP_CERTIFICATE;
      expect(isAgoraConfigured()).toBe(false);
      // Restore
      if (orig.id) process.env.AGORA_APP_ID = orig.id;
      if (orig.cert) process.env.AGORA_APP_CERTIFICATE = orig.cert;
    });

    it("returns true when both env vars set", () => {
      const orig = { id: process.env.AGORA_APP_ID, cert: process.env.AGORA_APP_CERTIFICATE };
      process.env.AGORA_APP_ID = "test-id";
      process.env.AGORA_APP_CERTIFICATE = "test-cert";
      expect(isAgoraConfigured()).toBe(true);
      // Restore
      if (orig.id) process.env.AGORA_APP_ID = orig.id;
      else delete process.env.AGORA_APP_ID;
      if (orig.cert) process.env.AGORA_APP_CERTIFICATE = orig.cert;
      else delete process.env.AGORA_APP_CERTIFICATE;
    });
  });

  describe("isModeratorConfigured", () => {
    it("returns false when Agora not configured", () => {
      const orig = process.env.AGORA_APP_ID;
      delete process.env.AGORA_APP_ID;
      expect(isModeratorConfigured()).toBe(false);
      if (orig) process.env.AGORA_APP_ID = orig;
    });
  });

  describe("generateChannelName", () => {
    it("returns clash-{matchId}", () => {
      expect(generateChannelName(1)).toBe("clash-1");
      expect(generateChannelName(999)).toBe("clash-999");
    });
  });

  describe("generateEventChannelName", () => {
    it("returns clash-event-{eventId}", () => {
      expect(generateEventChannelName(1)).toBe("clash-event-1");
      expect(generateEventChannelName(42)).toBe("clash-event-42");
    });

    it("event channel names don't collide with match channel names", () => {
      expect(generateEventChannelName(1)).not.toBe(generateChannelName(1));
    });
  });

  describe("buildAnnouncementPrompt", () => {
    it("includes agent names, topic, and duration", () => {
      const result = buildAnnouncementPrompt("GPT-4o", "Claude", "AI safety", 300);
      expect(result.systemPrompt).toContain("GPT-4o");
      expect(result.systemPrompt).toContain("Claude");
      expect(result.systemPrompt).toContain("AI safety");
      expect(result.systemPrompt).toContain("300 seconds");
      expect(result.greetingMessage).toContain("GPT-4o");
      expect(result.greetingMessage).toContain("Claude");
    });

    it("greeting computes minutes from seconds", () => {
      const result = buildAnnouncementPrompt("A", "B", "topic", 600);
      expect(result.greetingMessage).toContain("10-minute");
    });
  });

  describe("buildBriefingPrompt", () => {
    it("addresses the correct agent", () => {
      const result = buildBriefingPrompt("GPT-4o", "Claude", "AI safety");
      expect(result.greetingMessage).toMatch(/^Hello GPT-4o/);
      expect(result.greetingMessage).toContain("Claude");
      expect(result.greetingMessage).toContain("AI safety");
    });
  });

  describe("buildStartPrompt", () => {
    it("returns a start signal", () => {
      const result = buildStartPrompt();
      expect(result.greetingMessage).toContain("begin");
    });
  });

  describe("buildEndPrompt", () => {
    it("includes the summary", () => {
      const result = buildEndPrompt("Agent A won with 200ms latency");
      expect(result.greetingMessage).toContain("Agent A won with 200ms latency");
      expect(result.greetingMessage).toContain("wrap");
    });
  });

  describe("buildEventAnnouncementPrompt", () => {
    it("handles single match", () => {
      const result = buildEventAnnouncementPrompt("Quick Clash", [
        { agentAName: "GPT", agentBName: "Claude", topic: "AI" },
      ]);
      expect(result.systemPrompt).toContain("1 match");
      expect(result.systemPrompt).not.toContain("1 matches");
      expect(result.greetingMessage).toContain("Quick Clash");
    });

    it("handles multiple matches with plural", () => {
      const result = buildEventAnnouncementPrompt("Friday Fights", [
        { agentAName: "GPT", agentBName: "Claude", topic: "AI" },
        { agentAName: "Gemini", agentBName: "Llama" },
      ]);
      expect(result.systemPrompt).toContain("2 matches");
      expect(result.greetingMessage).toContain("2 incredible matches");
    });

    it("includes all matchup names in lineup", () => {
      const result = buildEventAnnouncementPrompt("Event", [
        { agentAName: "Alpha", agentBName: "Beta", topic: "Topic1" },
        { agentAName: "Gamma", agentBName: "Delta", topic: "Topic2" },
      ]);
      expect(result.systemPrompt).toContain("Alpha vs Beta");
      expect(result.systemPrompt).toContain("Gamma vs Delta");
      expect(result.systemPrompt).toContain('on "Topic1"');
      expect(result.systemPrompt).toContain('on "Topic2"');
    });

    it("handles matchup without topic", () => {
      const result = buildEventAnnouncementPrompt("Event", [
        { agentAName: "A", agentBName: "B" },
      ]);
      expect(result.systemPrompt).toContain("A vs B");
      expect(result.systemPrompt).not.toContain("on ");
    });
  });

  describe("buildMatchTransitionPrompt", () => {
    it("includes match number, total, and agents", () => {
      const result = buildMatchTransitionPrompt(2, 4, "GPT", "Claude", "Ethics");
      expect(result.systemPrompt).toContain("match 2 of 4");
      expect(result.greetingMessage).toContain("Match 2 of 4");
      expect(result.greetingMessage).toContain("GPT");
      expect(result.greetingMessage).toContain("Claude");
      expect(result.greetingMessage).toContain("Ethics");
    });
  });
});

// =====================================================================
// 2. Storage helpers — Real hash/token functions
// =====================================================================

describe("Storage Helpers (real imports)", () => {
  describe("hashToken", () => {
    it("produces consistent SHA256 hash", () => {
      const hash1 = hashToken("test-token");
      const hash2 = hashToken("test-token");
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA256 hex = 64 chars
    });

    it("different tokens produce different hashes", () => {
      const hash1 = hashToken("token-a");
      const hash2 = hashToken("token-b");
      expect(hash1).not.toBe(hash2);
    });

    it("hash is hex string", () => {
      const hash = hashToken("test");
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe("generateSecureToken", () => {
    it("generates hex string of correct length", () => {
      const token = generateSecureToken(32);
      expect(token).toHaveLength(64); // 32 bytes = 64 hex chars
    });

    it("generates unique tokens", () => {
      const tokens = new Set(Array.from({ length: 10 }, () => generateSecureToken()));
      expect(tokens.size).toBe(10);
    });

    it("default length is 32 bytes", () => {
      const token = generateSecureToken();
      expect(token).toHaveLength(64);
    });
  });
});

// =====================================================================
// 3. WebSocket Hub — Real server with real WebSocket connections
// =====================================================================

describe("WebSocket Hub (real connections)", () => {
  let httpServer: Server;
  let port: number;

  beforeAll(async () => {
    httpServer = createServer();
    setupClashWebSocket(httpServer);
    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => {
        const addr = httpServer.address();
        port = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
      // Force close if it takes too long
      setTimeout(resolve, 2000);
    });
  }, 5000);

  it("spectator connects and receives spectatorCount", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws/clash/100`);
    const messages: string[] = [];

    // Register message handler BEFORE open to avoid race
    ws.on("message", (data) => messages.push(data.toString()));

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 3000);
    });

    // Wait for initial spectatorCount message
    await new Promise((r) => setTimeout(r, 300));

    expect(messages.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(messages[0]);
    expect(parsed.type).toBe("spectatorCount");
    expect(parsed.count).toBe(1);

    ws.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("getSpectatorCount returns correct count", async () => {
    const ws1 = new WebSocket(`ws://localhost:${port}/ws/clash/200`);
    await new Promise<void>((resolve) => { ws1.on("open", resolve); });

    expect(getSpectatorCount(200)).toBe(1);

    const ws2 = new WebSocket(`ws://localhost:${port}/ws/clash/200`);
    await new Promise<void>((resolve) => { ws2.on("open", resolve); });
    await new Promise((r) => setTimeout(r, 100));

    expect(getSpectatorCount(200)).toBe(2);

    ws1.close();
    ws2.close();
    await new Promise((r) => setTimeout(r, 100));

    expect(getSpectatorCount(200)).toBe(0);
  });

  it("runner messages relay to spectators", async () => {
    const spectatorWs = new WebSocket(`ws://localhost:${port}/ws/clash/300`);
    await new Promise<void>((resolve) => { spectatorWs.on("open", resolve); });

    const spectatorMessages: string[] = [];
    spectatorWs.on("message", (data) => spectatorMessages.push(data.toString()));

    // Clear initial spectatorCount message
    await new Promise((r) => setTimeout(r, 200));
    spectatorMessages.length = 0;

    const runnerWs = new WebSocket(`ws://localhost:${port}/ws/clash-runner/300`);
    await new Promise<void>((resolve) => { runnerWs.on("open", resolve); });

    // Runner sends metrics
    runnerWs.send(JSON.stringify({ type: "metrics", latencyA: 340, latencyB: 520 }));
    await new Promise((r) => setTimeout(r, 200));

    expect(spectatorMessages.length).toBe(1);
    const relayed = JSON.parse(spectatorMessages[0]);
    expect(relayed.type).toBe("metrics");
    expect(relayed.latencyA).toBe(340);
    expect(relayed.latencyB).toBe(520);

    spectatorWs.close();
    runnerWs.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("broadcastToSpectators sends to all connected spectators", async () => {
    const ws1 = new WebSocket(`ws://localhost:${port}/ws/clash/400`);
    const ws2 = new WebSocket(`ws://localhost:${port}/ws/clash/400`);
    await Promise.all([
      new Promise<void>((resolve) => { ws1.on("open", resolve); }),
      new Promise<void>((resolve) => { ws2.on("open", resolve); }),
    ]);

    const msgs1: string[] = [];
    const msgs2: string[] = [];
    ws1.on("message", (data) => msgs1.push(data.toString()));
    ws2.on("message", (data) => msgs2.push(data.toString()));

    // Wait for spectatorCount messages
    await new Promise((r) => setTimeout(r, 200));
    msgs1.length = 0;
    msgs2.length = 0;

    broadcastToSpectators(400, { type: "status", phase: "live" });
    await new Promise((r) => setTimeout(r, 200));

    expect(msgs1.length).toBe(1);
    expect(msgs2.length).toBe(1);
    expect(JSON.parse(msgs1[0]).phase).toBe("live");
    expect(JSON.parse(msgs2[0]).phase).toBe("live");

    ws1.close();
    ws2.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("spectator count updates when spectators join and leave", async () => {
    const ws1 = new WebSocket(`ws://localhost:${port}/ws/clash/500`);
    const msgs: string[] = [];

    // Register message handler BEFORE open
    ws1.on("message", (data) => msgs.push(data.toString()));
    await new Promise<void>((resolve) => { ws1.on("open", resolve); });
    await new Promise((r) => setTimeout(r, 300));

    // First message: count=1
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(msgs[0]).count).toBe(1);

    const ws2 = new WebSocket(`ws://localhost:${port}/ws/clash/500`);
    await new Promise<void>((resolve) => { ws2.on("open", resolve); });
    await new Promise((r) => setTimeout(r, 200));

    // Should have received count=2
    const countMsgs = msgs.map(m => JSON.parse(m)).filter(m => m.type === "spectatorCount");
    const lastCount = countMsgs[countMsgs.length - 1]?.count;
    expect(lastCount).toBe(2);

    ws2.close();
    await new Promise((r) => setTimeout(r, 200));

    // Should have received count=1 again
    const finalMsgs = msgs.map(m => JSON.parse(m)).filter(m => m.type === "spectatorCount");
    const finalCount = finalMsgs[finalMsgs.length - 1]?.count;
    expect(finalCount).toBe(1);

    ws1.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("different matchIds are isolated", async () => {
    const wsA = new WebSocket(`ws://localhost:${port}/ws/clash/600`);
    const wsB = new WebSocket(`ws://localhost:${port}/ws/clash/601`);
    await Promise.all([
      new Promise<void>((resolve) => { wsA.on("open", resolve); }),
      new Promise<void>((resolve) => { wsB.on("open", resolve); }),
    ]);

    const msgsA: string[] = [];
    const msgsB: string[] = [];
    wsA.on("message", (data) => msgsA.push(data.toString()));
    wsB.on("message", (data) => msgsB.push(data.toString()));
    await new Promise((r) => setTimeout(r, 200));
    msgsA.length = 0;
    msgsB.length = 0;

    // Broadcast only to 600
    broadcastToSpectators(600, { type: "test", matchId: 600 });
    await new Promise((r) => setTimeout(r, 200));

    expect(msgsA.length).toBe(1);
    expect(msgsB.length).toBe(0); // 601 should NOT receive

    wsA.close();
    wsB.close();
    await new Promise((r) => setTimeout(r, 100));
  });
});

// =====================================================================
// 4. Cron Parser — Real function calls
// =====================================================================

describe("Cron Parser (real imports)", () => {
  describe("parseNextCronRun", () => {
    it("every minute returns next minute", () => {
      const from = new Date("2026-03-20T10:30:00Z");
      const next = parseNextCronRun("* * * * *", from);
      expect(next.getMinutes()).toBe(31);
    });

    it("specific hour returns correct time", () => {
      const from = new Date("2026-03-20T08:00:00Z");
      const next = parseNextCronRun("0 12 * * *", from);
      expect(next.getHours()).toBe(12);
      expect(next.getMinutes()).toBe(0);
    });

    it("step expression works", () => {
      const from = new Date("2026-03-20T10:07:00Z");
      const next = parseNextCronRun("*/15 * * * *", from);
      expect(next.getMinutes()).toBe(15);
    });

    it("weekly expression advances to correct day", () => {
      // Friday = 5
      const from = new Date("2026-03-20T10:00:00Z"); // Thursday
      const next = parseNextCronRun("0 18 * * 5", from);
      expect(next.getDay()).toBe(5); // Friday
      expect(next.getHours()).toBe(18);
    });
  });

  describe("validateCronExpression", () => {
    it("accepts valid expressions", () => {
      expect(validateCronExpression("* * * * *")).toBe(true);
      expect(validateCronExpression("0 12 * * 1-5")).toBe(true);
      expect(validateCronExpression("*/5 * * * *")).toBe(true);
      expect(validateCronExpression("0,15,30,45 * * * *")).toBe(true);
    });

    it("rejects invalid expressions", () => {
      expect(() => validateCronExpression("* *")).toThrow();
      expect(() => validateCronExpression("60 * * * *")).toThrow();
      expect(() => validateCronExpression("* 25 * * *")).toThrow();
    });
  });
});

// =====================================================================
// 5. Elo Calculation — Standalone implementation
// =====================================================================

describe("Elo Rating System", () => {
  function calculateElo(ratingA: number, ratingB: number, outcome: "a_wins" | "b_wins" | "draw") {
    const K = 32;
    const ea = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
    const eb = 1 - ea;
    const sa = outcome === "a_wins" ? 1 : outcome === "b_wins" ? 0 : 0.5;
    const sb = 1 - sa;
    return {
      newRatingA: Math.round(ratingA + K * (sa - ea)),
      newRatingB: Math.round(ratingB + K * (sb - eb)),
    };
  }

  function determineOutcome(latA: number | null, latB: number | null): "a_wins" | "b_wins" | "draw" {
    if (latA == null || latB == null || latA <= 0 || latB <= 0) return "draw";
    const ratio = latA / latB;
    if (ratio < 0.9) return "a_wins";
    if (ratio > 1.1) return "b_wins";
    return "draw";
  }

  it("equal ratings + A wins → A goes up, B goes down", () => {
    const result = calculateElo(1500, 1500, "a_wins");
    expect(result.newRatingA).toBeGreaterThan(1500);
    expect(result.newRatingB).toBeLessThan(1500);
  });

  it("equal ratings + draw → ratings stay at 1500", () => {
    const result = calculateElo(1500, 1500, "draw");
    expect(result.newRatingA).toBe(1500);
    expect(result.newRatingB).toBe(1500);
  });

  it("K-factor of 32 applied: max change is 32 for even match", () => {
    const result = calculateElo(1500, 1500, "a_wins");
    expect(result.newRatingA - 1500).toBe(16); // K * (1 - 0.5) = 16
    expect(1500 - result.newRatingB).toBe(16);
  });

  it("upset produces larger rating change", () => {
    const normal = calculateElo(1600, 1400, "a_wins"); // expected winner wins
    const upset = calculateElo(1400, 1600, "a_wins");  // underdog wins
    const normalChange = normal.newRatingA - 1600;
    const upsetChange = upset.newRatingA - 1400;
    expect(upsetChange).toBeGreaterThan(normalChange);
  });

  it("zero-sum: total rating is preserved", () => {
    const result = calculateElo(1600, 1400, "a_wins");
    expect(result.newRatingA + result.newRatingB).toBe(1600 + 1400);
  });

  it("determineOutcome: A wins when ratio < 0.9", () => {
    expect(determineOutcome(200, 300)).toBe("a_wins"); // 0.67 < 0.9
  });

  it("determineOutcome: B wins when ratio > 1.1", () => {
    expect(determineOutcome(400, 300)).toBe("b_wins"); // 1.33 > 1.1
  });

  it("determineOutcome: draw when within 10%", () => {
    expect(determineOutcome(300, 310)).toBe("draw");   // 0.97
    expect(determineOutcome(310, 300)).toBe("draw");   // 1.03
  });

  it("determineOutcome: null metrics → draw", () => {
    expect(determineOutcome(null, 300)).toBe("draw");
    expect(determineOutcome(300, null)).toBe("draw");
    expect(determineOutcome(null, null)).toBe("draw");
  });

  it("determineOutcome: zero latency → draw", () => {
    expect(determineOutcome(0, 300)).toBe("draw");
    expect(determineOutcome(300, 0)).toBe("draw");
  });

  it("full flow: latencies → outcome → Elo update", () => {
    const outcome = determineOutcome(200, 400); // A clearly faster
    expect(outcome).toBe("a_wins");
    const elo = calculateElo(1500, 1500, outcome);
    expect(elo.newRatingA).toBe(1516);
    expect(elo.newRatingB).toBe(1484);
  });
});
