import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";

// Load test credentials from .env.dev (same as dev-local-run.sh)
try {
  const envFile = readFileSync(".env.dev", "utf-8");
  for (const line of envFile.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx);
      const val = trimmed.slice(eqIdx + 1);
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch {}

import {
  isAgoraConfigured,
  isModeratorConfigured,
  generateRtcToken,
  generateEventChannelName,
  startModerator,
  stopModerator,
  speakModerator,
  buildAnnouncementPrompt,
  buildStartPrompt,
} from "../server/agora";

// =====================================================================
// Agora E2E Tests — calls real Agora APIs with test credentials
//
// Requires: .env.tests with valid AGORA_APP_ID, AGORA_APP_CERTIFICATE,
// AGORA_CUSTOMER_ID, AGORA_CUSTOMER_SECRET, AGORA_CONVOAI_CONFIG
//
// These tests create real ConvoAI agents and must clean up after.
// Skip if credentials not configured.
// =====================================================================

const hasCredentials = isAgoraConfigured() && isModeratorConfigured();

describe.skipIf(!hasCredentials)("Agora E2E (real API calls)", () => {
  const testChannelName = `test-e2e-${Date.now()}`;
  let agentId: string | null = null;

  describe("RTC Token Generation", () => {
    it("generates a valid RTC token", () => {
      const token = generateRtcToken(testChannelName, 500, "publisher");
      expect(token).toBeTruthy();
      expect(typeof token).toBe("string");
      expect(token.length).toBeGreaterThan(50);
      // Agora tokens start with "007"
      expect(token.startsWith("007")).toBe(true);
    });

    it("generates different tokens for different UIDs", () => {
      const tokenA = generateRtcToken(testChannelName, 100, "publisher");
      const tokenB = generateRtcToken(testChannelName, 200, "publisher");
      expect(tokenA).not.toBe(tokenB);
    });

    it("generates different tokens for publisher vs audience", () => {
      const pub = generateRtcToken(testChannelName, 100, "publisher");
      const aud = generateRtcToken(testChannelName, 100, "audience");
      expect(pub).not.toBe(aud);
    });
  });

  describe("ConvoAI Moderator Lifecycle", () => {
    it("starts a moderator agent", async () => {
      const channelName = generateEventChannelName(99999);
      const token = generateRtcToken(channelName, 500, "publisher");
      const prompt = buildAnnouncementPrompt("TestAgentA", "TestAgentB", "Testing", 60);

      agentId = await startModerator({
        channelName,
        token,
        uid: "500",
        systemPrompt: prompt.systemPrompt,
        greetingMessage: prompt.greetingMessage,
      });

      expect(agentId).toBeTruthy();
      expect(typeof agentId).toBe("string");
      console.log(`[E2E] Moderator started: agentId=${agentId}`);
    }, 15000);

    it("speaks via the moderator", async () => {
      expect(agentId).toBeTruthy();

      await speakModerator(agentId!, "This is an E2E test. Hello from Vox!", "INTERRUPT", false);
      console.log("[E2E] Moderator spoke successfully");
    }, 10000);

    it("speaks with APPEND priority", async () => {
      expect(agentId).toBeTruthy();

      await speakModerator(agentId!, "Queued message after the first one.", "APPEND", true);
      console.log("[E2E] Moderator spoke with APPEND");
    }, 10000);

    it("stops the moderator agent", async () => {
      expect(agentId).toBeTruthy();

      await stopModerator(agentId!);
      console.log("[E2E] Moderator stopped");
      agentId = null;
    }, 10000);

    it("stopping a non-existent agent does not throw", async () => {
      // Should handle 404 gracefully
      await expect(stopModerator("non-existent-agent-id")).resolves.toBeUndefined();
    }, 10000);
  });

  describe("ConvoAI Error Handling", () => {
    it("rejects start with invalid channel name", async () => {
      await expect(startModerator({
        channelName: "",
        token: "invalid-token",
        uid: "500",
        systemPrompt: "test",
        greetingMessage: "test",
      })).rejects.toThrow();
    }, 10000);

    it("rejects speak with invalid agent ID", async () => {
      await expect(
        speakModerator("invalid-agent-id", "test", "INTERRUPT", false)
      ).rejects.toThrow();
    }, 10000);
  });

  // Cleanup: ensure agent is stopped even if tests fail
  afterAll(async () => {
    if (agentId) {
      try {
        await stopModerator(agentId);
        console.log("[E2E] Cleanup: stopped leftover moderator agent");
      } catch {}
    }
  });
});

describe.skipIf(!hasCredentials)("Agora Config Validation (with real env)", () => {
  it("isAgoraConfigured returns true", () => {
    expect(isAgoraConfigured()).toBe(true);
  });

  it("isModeratorConfigured returns true", () => {
    expect(isModeratorConfigured()).toBe(true);
  });

  it("AGORA_CONVOAI_CONFIG parses successfully", () => {
    // This implicitly tests the quote-stripping and unescape logic
    expect(() => {
      const raw = process.env.AGORA_CONVOAI_CONFIG!;
      let cleaned = raw.trim();
      if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
        cleaned = cleaned.slice(1, -1);
      }
      if (cleaned.includes('\\"')) {
        cleaned = cleaned.replace(/\\"/g, '"');
      }
      const config = JSON.parse(cleaned);
      expect(config.llm).toBeDefined();
      expect(config.tts).toBeDefined();
      expect(config.asr).toBeDefined();
    }).not.toThrow();
  });
});
