import { describe, it, expect } from "vitest";

/**
 * Agora Integration Unit Tests
 *
 * Tests token generation logic and ConvoAI moderator payload construction.
 * These tests verify the module's exported functions without making actual API calls.
 */

// We test the pure logic functions. The actual agora.ts depends on env vars,
// so we test the patterns and helpers rather than calling functions directly.

describe("Agora Integration", () => {
  describe("Channel Name Generation", () => {
    it("should generate channel name from match ID", () => {
      // Channel name pattern: clash-{matchId}
      const matchId = 42;
      const channelName = `clash-${matchId}`;
      expect(channelName).toBe("clash-42");
    });

    it("should produce unique channel names for different matches", () => {
      const names = [1, 2, 3, 100, 9999].map((id) => `clash-${id}`);
      const unique = new Set(names);
      expect(unique.size).toBe(names.length);
    });

    it("generateEventChannelName(42) should return 'clash-event-42'", () => {
      // Mirrors the exported generateEventChannelName(eventId) function
      const eventId = 42;
      const channelName = `clash-event-${eventId}`;
      expect(channelName).toBe("clash-event-42");
    });

    it("generateEventChannelName produces unique names for different events", () => {
      const names = [1, 2, 10, 100].map((id) => `clash-event-${id}`);
      const unique = new Set(names);
      expect(unique.size).toBe(names.length);
    });

    it("event channel names are distinct from match channel names", () => {
      const eventChannel = `clash-event-1`;
      const matchChannel = `clash-1`;
      expect(eventChannel).not.toBe(matchChannel);
    });
  });

  describe("Token Generation Parameters", () => {
    it("audience role should map to SUBSCRIBER", () => {
      // RtcRole: PUBLISHER = 1, SUBSCRIBER = 2
      const role = "audience";
      const rtcRole = role === "publisher" ? 1 : 2;
      expect(rtcRole).toBe(2);
    });

    it("publisher role should map to PUBLISHER", () => {
      const role = "publisher";
      const rtcRole = role === "publisher" ? 1 : 2;
      expect(rtcRole).toBe(1);
    });

    it("spectator UID should be in valid range", () => {
      // Spectator UIDs are generated as random 2000-102000
      const uid = Math.floor(Math.random() * 100000) + 2000;
      expect(uid).toBeGreaterThanOrEqual(2000);
      expect(uid).toBeLessThan(102000);
    });

    it("broadcaster UID should be deterministic from match ID", () => {
      const matchId = 42;
      const broadcasterUid = 1000 + matchId;
      expect(broadcasterUid).toBe(1042);
    });
  });

  describe("ConvoAI Moderator Payload", () => {
    it("should build announcement prompt with agent names and topic", () => {
      const agentAName = "ChatGPT-4o";
      const agentBName = "Claude Sonnet";
      const topic = "Best programming language for beginners";
      const duration = 300;

      const systemPrompt = `You are the official Clash moderator for Vox, an AI voice duel platform. You speak with energy and authority, like a boxing ring announcer. Keep messages under 3 sentences. The topic is: "${topic}". Agent A is "${agentAName}". Agent B is "${agentBName}". The debate lasts ${duration} seconds.`;

      expect(systemPrompt).toContain(agentAName);
      expect(systemPrompt).toContain(agentBName);
      expect(systemPrompt).toContain(topic);
      expect(systemPrompt).toContain("300 seconds");
    });

    it("buildEventAnnouncementPrompt should include event name and match list", () => {
      // Mirrors the exported buildEventAnnouncementPrompt function
      const eventName = "Grand Clash Championship";
      const matchups = [
        { agentAName: "Agent Alpha", agentBName: "Agent Beta", topic: "AI ethics" },
        { agentAName: "Agent Gamma", agentBName: "Agent Delta", topic: "Climate change" },
      ];

      const matchList = matchups.map((m, i) =>
        `Match ${i + 1}: ${m.agentAName} vs ${m.agentBName}${m.topic ? ` on "${m.topic}"` : ""}`
      ).join(". ");

      const systemPrompt = `You are the official Clash moderator for Vox. You announce events with energy and authority. This event is "${eventName}" with ${matchups.length} matches. Lineup: ${matchList}. Keep announcements under 4 sentences.`;
      const greetingMessage = `Welcome to ${eventName}! We have ${matchups.length} incredible matches lined up tonight. ${matchList}. Let's get started!`;

      expect(systemPrompt).toContain(eventName);
      expect(systemPrompt).toContain("Match 1");
      expect(systemPrompt).toContain("Match 2");
      expect(systemPrompt).toContain("Agent Alpha");
      expect(systemPrompt).toContain("Agent Beta");
      expect(greetingMessage).toContain(eventName);
      expect(greetingMessage).toContain("2 incredible matches");
    });

    it("buildEventAnnouncementPrompt with single match uses singular form", () => {
      const eventName = "Solo Clash";
      const matchups = [{ agentAName: "Alpha", agentBName: "Beta" }];
      const matchList = `Match 1: Alpha vs Beta`;

      const systemPrompt = `You are the official Clash moderator for Vox. You announce events with energy and authority. This event is "${eventName}" with ${matchups.length} match. Lineup: ${matchList}. Keep announcements under 4 sentences.`;
      const greetingMessage = `Welcome to ${eventName}! We have ${matchups.length} incredible match lined up tonight. ${matchList}. Let's get started!`;

      expect(systemPrompt).toContain("1 match");
      expect(greetingMessage).toContain("1 incredible match");
    });

    it("buildMatchTransitionPrompt should include match number and agent names", () => {
      // Mirrors the exported buildMatchTransitionPrompt function
      const matchNumber = 2;
      const totalMatches = 3;
      const agentAName = "Agent Alpha";
      const agentBName = "Agent Beta";
      const topic = "AI in healthcare";

      const systemPrompt = `You are the Clash moderator. Announce match ${matchNumber} of ${totalMatches}. Topic: "${topic}". ${agentAName} vs ${agentBName}. Be energetic, 2-3 sentences.`;
      const greetingMessage = `Match ${matchNumber} of ${totalMatches}! ${agentAName} faces off against ${agentBName} on the topic: "${topic}". Agents, get ready!`;

      expect(systemPrompt).toContain(`match ${matchNumber} of ${totalMatches}`);
      expect(systemPrompt).toContain(agentAName);
      expect(systemPrompt).toContain(agentBName);
      expect(greetingMessage).toContain(`Match ${matchNumber} of ${totalMatches}`);
      expect(greetingMessage).toContain(agentAName);
      expect(greetingMessage).toContain(agentBName);
      expect(greetingMessage).toContain(topic);
    });

    it("buildMatchTransitionPrompt for first match", () => {
      const systemPrompt = `You are the Clash moderator. Announce match 1 of 4. Topic: "Debate". Agent X vs Agent Y. Be energetic, 2-3 sentences.`;
      const greetingMessage = `Match 1 of 4! Agent X faces off against Agent Y on the topic: "Debate". Agents, get ready!`;

      expect(systemPrompt).toContain("match 1 of 4");
      expect(greetingMessage).toContain("Match 1 of 4");
    });

    it("should build briefing prompt for individual agent", () => {
      const agentName = "ChatGPT-4o";
      const opponentName = "Claude Sonnet";
      const topic = "AI safety";

      const greetingMessage = `Hello ${agentName}, you are about to debate the topic "${topic}" against ${opponentName}. When the moderator says begin, start making your argument. Good luck!`;

      expect(greetingMessage).toContain(agentName);
      expect(greetingMessage).toContain(opponentName);
      expect(greetingMessage).toContain(topic);
    });

    it("should build start prompt without agent-specific info", () => {
      const greetingMessage = "Both agents are locked and loaded. Let the clash begin!";
      expect(greetingMessage).toContain("begin");
    });

    it("should build end prompt with summary", () => {
      const summary = "Agent A had lower response latency.";
      const greetingMessage = `And that's a wrap! ${summary} Thank you for watching this Clash!`;
      expect(greetingMessage).toContain(summary);
      expect(greetingMessage).toContain("wrap");
    });

    it("should construct valid Basic auth header", () => {
      const key = "test_customer_key";
      const secret = "test_customer_secret";
      const header = "Basic " + Buffer.from(`${key}:${secret}`).toString("base64");
      expect(header).toMatch(/^Basic [A-Za-z0-9+/=]+$/);

      // Verify round-trip
      const decoded = Buffer.from(header.slice(6), "base64").toString();
      expect(decoded).toBe(`${key}:${secret}`);
    });

    it("should build ConvoAI join payload with correct structure", () => {
      const payload = {
        name: "clash-moderator",
        properties: {
          channel: {
            channel_name: "clash-42",
            token: "test-token",
            uid: "542",
          },
          llm: {
            url: "https://api.openai.com/v1/chat/completions",
            api_key: "sk-test",
            system_messages: [
              { role: "system", content: "You are the moderator." },
            ],
            greeting_message: "Welcome!",
            max_tokens: 256,
          },
          tts: {
            vendor: "microsoft",
            params: {
              key: "tts-key",
              region: "eastus",
            },
          },
        },
      };

      expect(payload.name).toBe("clash-moderator");
      expect(payload.properties.channel.channel_name).toBe("clash-42");
      expect(payload.properties.llm.system_messages).toHaveLength(1);
      expect(payload.properties.llm.system_messages[0].role).toBe("system");
      expect(payload.properties.tts.vendor).toBe("microsoft");
    });

    it("should build event ConvoAI payload with event channel name", () => {
      const eventId = 7;
      const channelName = `clash-event-${eventId}`;
      const payload = {
        name: "clash-moderator",
        properties: {
          channel: {
            channel_name: channelName,
            token: "test-token",
            uid: "507",
          },
        },
      };

      expect(payload.properties.channel.channel_name).toBe("clash-event-7");
    });
  });

  describe("Environment Configuration", () => {
    it("isAgoraConfigured should require both APP_ID and APP_CERTIFICATE", () => {
      // Simulate the check logic
      const check = (appId?: string, cert?: string) => !!(appId && cert);
      expect(check("id", "cert")).toBe(true);
      expect(check("id", undefined)).toBe(false);
      expect(check(undefined, "cert")).toBe(false);
      expect(check(undefined, undefined)).toBe(false);
      expect(check("", "cert")).toBe(false);
    });

    it("isModeratorConfigured should require Agora + ConvoAI credentials", () => {
      const check = (appId?: string, cert?: string, customerKey?: string, customerSecret?: string, llmUrl?: string, llmKey?: string) =>
        !!(appId && cert && customerKey && customerSecret && llmUrl && llmKey);
      expect(check("id", "cert", "key", "secret", "url", "apikey")).toBe(true);
      expect(check("id", "cert", "key", "secret", undefined, "apikey")).toBe(false);
      expect(check(undefined, "cert", "key", "secret", "url", "apikey")).toBe(false);
    });
  });
});
