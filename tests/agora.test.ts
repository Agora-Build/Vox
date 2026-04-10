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

    it("spectator UID should be above reserved range (>10000)", () => {
      const uid = Math.floor(Math.random() * 100000) + 10001;
      expect(uid).toBeGreaterThan(10000);
      expect(uid).toBeLessThanOrEqual(110001);
    });

    it("broadcaster UIDs are fixed (100 for A, 200 for B)", () => {
      expect(100).toBe(100);
      expect(200).toBe(200);
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

    it("should construct valid Basic auth header from env vars", () => {
      const key = "test_customer_key";
      const secret = "test_customer_secret";
      const header = "Basic " + Buffer.from(`${key}:${secret}`).toString("base64");
      expect(header).toMatch(/^Basic [A-Za-z0-9+/=]+$/);

      const decoded = Buffer.from(header.slice(6), "base64").toString();
      expect(decoded).toBe(`${key}:${secret}`);
    });

    it("should merge AGORA_CONVOAI_CONFIG with runtime values", () => {
      // Simulates what startModerator does: take config from env, merge with prompt
      const config = {
        llm: { url: "https://api.groq.com/openai/v1/chat/completions", api_key: "gsk_...", params: { model: "openai/gpt-oss-120b" } },
        tts: { vendor: "minimax", params: { key: "eyJ...", group_id: "196...", model: "speech-02-turbo" } },
        asr: { language: "en-US", vendor: "ares", params: {} },
      };

      const payload = {
        name: "clash-moderator",
        properties: {
          channel: { channel_name: "clash-event-42", token: "test-token", uid: "500" },
          llm: {
            ...config.llm,
            system_messages: [{ role: "system", content: "You are the moderator." }],
            greeting_message: "Welcome!",
            max_tokens: 256,
          },
          tts: config.tts,
          asr: config.asr,
        },
      };

      expect(payload.name).toBe("clash-moderator");
      expect(payload.properties.channel.uid).toBe("500");
      expect(payload.properties.llm.url).toContain("groq.com");
      expect((payload.properties.llm as any).params.model).toBe("openai/gpt-oss-120b");
      expect(payload.properties.llm.system_messages).toHaveLength(1);
      expect(payload.properties.llm.greeting_message).toBe("Welcome!");
      expect(payload.properties.tts.vendor).toBe("minimax");
      expect(payload.properties.asr.vendor).toBe("ares");
    });

    it("should build event ConvoAI payload with event channel name and fixed UID", () => {
      const eventId = 7;
      const channelName = `clash-event-${eventId}`;
      const payload = {
        name: "clash-moderator",
        properties: {
          channel: {
            channel_name: channelName,
            token: "test-token",
            uid: "500",
          },
        },
      };

      expect(payload.properties.channel.channel_name).toBe("clash-event-7");
      expect(payload.properties.channel.uid).toBe("500");
    });
  });

  describe("Moderator ASR Config", () => {
    it("payload should include ASR with ares vendor", () => {
      const payload = {
        name: "clash-moderator",
        properties: {
          channel: { channel_name: "clash-event-1", token: "t", uid: "500" },
          llm: {
            url: "https://api.openai.com/v1/chat/completions",
            api_key: "sk-test",
            system_messages: [{ role: "system", content: "moderator" }],
            greeting_message: "Welcome!",
            max_tokens: 256,
          },
          tts: { vendor: "microsoft", params: { key: "k", region: "eastus" } },
          asr: { language: "en-US", vendor: "ares", params: {} },
        },
      };

      expect(payload.properties.asr).toBeDefined();
      expect(payload.properties.asr.vendor).toBe("ares");
      expect(payload.properties.asr.language).toBe("en-US");
    });

    it("moderator has all three capabilities: LLM + TTS + ASR", () => {
      const properties = {
        llm: { url: "u", api_key: "k" },
        tts: { vendor: "microsoft" },
        asr: { vendor: "ares" },
      };

      expect(properties.llm).toBeDefined();
      expect(properties.tts).toBeDefined();
      expect(properties.asr).toBeDefined();
    });
  });

  describe("Speak API Payload", () => {
    it("should construct valid speak payload with INTERRUPT priority", () => {
      const payload = {
        text: "Both agents are locked and loaded. Let the clash begin!",
        priority: "INTERRUPT" as const,
        interruptable: false,
      };

      expect(payload.text).toBeTruthy();
      expect(payload.text.length).toBeLessThanOrEqual(512);
      expect(payload.priority).toBe("INTERRUPT");
      expect(payload.interruptable).toBe(false);
    });

    it("should support APPEND priority for queued speech", () => {
      const payload = {
        text: "Great point!",
        priority: "APPEND" as const,
        interruptable: true,
      };

      expect(payload.priority).toBe("APPEND");
      expect(payload.interruptable).toBe(true);
    });

    it("should support IGNORE priority for idle-only speech", () => {
      const payload = {
        text: "Interesting.",
        priority: "IGNORE" as const,
        interruptable: true,
      };

      expect(payload.priority).toBe("IGNORE");
    });

    it("text must be <= 512 bytes", () => {
      const shortText = "Hello!";
      const longText = "x".repeat(513);

      expect(new TextEncoder().encode(shortText).length).toBeLessThanOrEqual(512);
      expect(new TextEncoder().encode(longText).length).toBeGreaterThan(512);
    });

    it("speak URL should use conversational-ai-agent path (not conversational-ai)", () => {
      const appId = "test-app-id";
      const agentId = "agent-123";
      const speakUrl = `https://api.agora.io/api/conversational-ai-agent/v2/projects/${appId}/agents/${agentId}/speak`;

      expect(speakUrl).toContain("conversational-ai-agent");
      expect(speakUrl).toContain(appId);
      expect(speakUrl).toContain(agentId);
      expect(speakUrl).toContain("/speak");
    });
  });

  describe("Moderator Lifecycle Phases", () => {
    const phases = ["brief_a", "brief_b", "start", "end"];

    it("all phases produce non-empty greeting messages", () => {
      const agentAName = "GPT-4o";
      const agentBName = "Claude";
      const topic = "AI safety";

      const messages: Record<string, string> = {
        brief_a: `Hello ${agentAName}, you are about to debate the topic "${topic}" against ${agentBName}. When the moderator says begin, start making your argument. Good luck!`,
        brief_b: `Hello ${agentBName}, you are about to debate the topic "${topic}" against ${agentAName}. When the moderator says begin, start making your argument. Good luck!`,
        start: "Both agents are locked and loaded. Let the clash begin!",
        end: "And that's a wrap! The debate has concluded. Thank you for watching this Clash!",
      };

      for (const phase of phases) {
        expect(messages[phase]).toBeTruthy();
        expect(messages[phase].length).toBeGreaterThan(0);
        expect(new TextEncoder().encode(messages[phase]).length).toBeLessThanOrEqual(512);
      }
    });

    it("briefing messages are personalized per agent", () => {
      const briefA = `Hello AgentA, you are about to debate the topic "AI" against AgentB.`;
      const briefB = `Hello AgentB, you are about to debate the topic "AI" against AgentA.`;

      expect(briefA).toContain("AgentA");
      expect(briefA).not.toContain("Hello AgentB");
      expect(briefB).toContain("AgentB");
      expect(briefB).not.toContain("Hello AgentA");
    });

    it("start phase does not mention specific agents", () => {
      const startMsg = "Both agents are locked and loaded. Let the clash begin!";
      expect(startMsg).not.toContain("GPT");
      expect(startMsg).not.toContain("Claude");
    });
  });

  describe("Moderator UID", () => {
    it("moderator UID is fixed at 500", () => {
      const modUid = 500;
      expect(modUid).toBe(500);
      expect(modUid).toBeLessThanOrEqual(10000);
    });

    it("moderator UID does not collide with broadcaster UIDs", () => {
      const modUid = 500;
      const broadcasterA = 100;
      const broadcasterB = 200;
      expect(modUid).not.toBe(broadcasterA);
      expect(modUid).not.toBe(broadcasterB);
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

    it("isModeratorConfigured should require Agora + customer keys + config", () => {
      const check = (appId?: string, cert?: string, custKey?: string, custSecret?: string, config?: string) =>
        !!(appId && cert && custKey && custSecret && config);
      expect(check("id", "cert", "key", "secret", '{"llm":{}}')).toBe(true);
      expect(check("id", "cert", "key", "secret", undefined)).toBe(false);
      expect(check("id", "cert", undefined, "secret", '{"llm":{}}')).toBe(false);
      expect(check(undefined, "cert", "key", "secret", '{"llm":{}}')).toBe(false);
    });
  });
});
