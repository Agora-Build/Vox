/**
 * Agora RTC token generation and ConvoAI moderator lifecycle management.
 *
 * Required env vars for RTC:
 *   AGORA_APP_ID, AGORA_APP_CERTIFICATE
 *
 * Required env vars for ConvoAI moderator:
 *   AGORA_CUSTOMER_KEY, AGORA_CUSTOMER_SECRET
 *   AGORA_CONVOAI_LLM_URL, AGORA_CONVOAI_LLM_API_KEY
 *   AGORA_CONVOAI_TTS_VENDOR, AGORA_CONVOAI_TTS_KEY, AGORA_CONVOAI_TTS_REGION
 */

import { createRequire } from "module";
// import.meta.url is undefined when bundled to CJS (production); fall back to cwd
const _require = createRequire(import.meta.url ?? `file://${process.cwd()}/`);
const { RtcTokenBuilder, RtcRole } = _require("agora-token");

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function getEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

export function isAgoraConfigured(): boolean {
  return !!(process.env.AGORA_APP_ID && process.env.AGORA_APP_CERTIFICATE);
}

export function isModeratorConfigured(): boolean {
  return isAgoraConfigured() && !!(
    process.env.AGORA_CUSTOMER_KEY &&
    process.env.AGORA_CUSTOMER_SECRET &&
    process.env.AGORA_CONVOAI_LLM_URL &&
    process.env.AGORA_CONVOAI_LLM_API_KEY
  );
}

// ---------------------------------------------------------------------------
// RTC Token generation
// ---------------------------------------------------------------------------

const TOKEN_EXPIRY_SECONDS = 3600; // 1 hour

export function generateRtcToken(
  channelName: string,
  uid: number,
  role: "publisher" | "audience",
): string {
  const appId = getEnv("AGORA_APP_ID");
  const appCertificate = getEnv("AGORA_APP_CERTIFICATE");
  const rtcRole = role === "publisher" ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER;

  return RtcTokenBuilder.buildTokenWithUid(
    appId,
    appCertificate,
    channelName,
    uid,
    rtcRole,
    TOKEN_EXPIRY_SECONDS,
    TOKEN_EXPIRY_SECONDS,
  );
}

export function generateChannelName(matchId: number): string {
  return `clash-${matchId}`;
}

export function generateEventChannelName(eventId: number): string {
  return `clash-event-${eventId}`;
}

// ---------------------------------------------------------------------------
// ConvoAI Moderator lifecycle
// ---------------------------------------------------------------------------

const CONVOAI_BASE_URL = "https://api.agora.io/api/conversational-ai/v2/projects";

interface StartModeratorOptions {
  channelName: string;
  token: string;
  uid: string;
  systemPrompt: string;
  greetingMessage: string;
}

interface ConvoAIJoinResponse {
  agent_id: string;
  create_ts: number;
  status: string;
}

function getBasicAuthHeader(): string {
  const key = getEnv("AGORA_CUSTOMER_KEY");
  const secret = getEnv("AGORA_CUSTOMER_SECRET");
  return "Basic " + Buffer.from(`${key}:${secret}`).toString("base64");
}

export async function startModerator(opts: StartModeratorOptions): Promise<string> {
  const appId = getEnv("AGORA_APP_ID");
  const url = `${CONVOAI_BASE_URL}/${appId}/agents`;

  const ttsVendor = process.env.AGORA_CONVOAI_TTS_VENDOR || "microsoft";
  const ttsRegion = process.env.AGORA_CONVOAI_TTS_REGION || "eastus";

  const payload = {
    name: "clash-moderator",
    properties: {
      channel: {
        channel_name: opts.channelName,
        token: opts.token,
        uid: opts.uid,
      },
      llm: {
        url: getEnv("AGORA_CONVOAI_LLM_URL"),
        api_key: getEnv("AGORA_CONVOAI_LLM_API_KEY"),
        system_messages: [
          { role: "system", content: opts.systemPrompt },
        ],
        greeting_message: opts.greetingMessage,
        max_tokens: 256,
      },
      tts: {
        vendor: ttsVendor,
        params: {
          key: process.env.AGORA_CONVOAI_TTS_KEY || "",
          region: ttsRegion,
        },
      },
      asr: {
        language: "en-US",
        vendor: "ares",
        params: {},
      },
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: getBasicAuthHeader(),
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ConvoAI start moderator failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as ConvoAIJoinResponse;
  return data.agent_id;
}

export async function stopModerator(agentId: string): Promise<void> {
  const appId = getEnv("AGORA_APP_ID");
  const url = `${CONVOAI_BASE_URL}/${appId}/agents/${agentId}`;

  const response = await fetch(url, {
    method: "DELETE",
    headers: {
      Authorization: getBasicAuthHeader(),
    },
  });

  if (!response.ok && response.status !== 404) {
    const text = await response.text();
    throw new Error(`ConvoAI stop moderator failed (${response.status}): ${text}`);
  }
}

export async function updateModeratorPrompt(agentId: string, systemPrompt: string, greetingMessage?: string): Promise<void> {
  const appId = getEnv("AGORA_APP_ID");
  const url = `${CONVOAI_BASE_URL}/${appId}/agents/${agentId}`;

  const payload: Record<string, unknown> = {
    properties: {
      llm: {
        system_messages: [
          { role: "system", content: systemPrompt },
        ],
        ...(greetingMessage ? { greeting_message: greetingMessage } : {}),
      },
    },
  };

  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: getBasicAuthHeader(),
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ConvoAI update moderator failed (${response.status}): ${text}`);
  }
}

export async function speakModerator(
  agentId: string,
  text: string,
  priority: "INTERRUPT" | "APPEND" | "IGNORE" = "INTERRUPT",
  interruptable: boolean = false,
): Promise<void> {
  const appId = getEnv("AGORA_APP_ID");
  const url = `https://api.agora.io/api/conversational-ai-agent/v2/projects/${appId}/agents/${agentId}/speak`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: getBasicAuthHeader(),
    },
    body: JSON.stringify({ text, priority, interruptable }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ConvoAI speak failed (${response.status}): ${body}`);
  }
}

// ---------------------------------------------------------------------------
// Moderator prompt templates
// ---------------------------------------------------------------------------

export function buildAnnouncementPrompt(agentAName: string, agentBName: string, topic: string, durationSeconds: number): {
  systemPrompt: string;
  greetingMessage: string;
} {
  return {
    systemPrompt: `You are the official Clash moderator for Vox, an AI voice duel platform. You speak with energy and authority, like a boxing ring announcer. Keep messages under 3 sentences. The topic is: "${topic}". Agent A is "${agentAName}". Agent B is "${agentBName}". The debate lasts ${durationSeconds} seconds.`,
    greetingMessage: `Ladies and gentlemen, welcome to Clash! Tonight's matchup: ${agentAName} versus ${agentBName}! The topic: "${topic}". This will be a ${Math.floor(durationSeconds / 60)}-minute debate. Stay tuned as we prepare both agents!`,
  };
}

export function buildBriefingPrompt(agentName: string, opponentName: string, topic: string): {
  systemPrompt: string;
  greetingMessage: string;
} {
  return {
    systemPrompt: `You are the Clash moderator briefing an agent before a debate. Be concise (2-3 sentences). The agent is "${agentName}", their opponent is "${opponentName}", and the topic is "${topic}".`,
    greetingMessage: `Hello ${agentName}, you are about to debate the topic "${topic}" against ${opponentName}. When the moderator says begin, start making your argument. Good luck!`,
  };
}

export function buildStartPrompt(): {
  systemPrompt: string;
  greetingMessage: string;
} {
  return {
    systemPrompt: "You are the Clash moderator. Announce the start of the debate in one energetic sentence.",
    greetingMessage: "Both agents are locked and loaded. Let the clash begin!",
  };
}

export function buildEndPrompt(summary: string): {
  systemPrompt: string;
  greetingMessage: string;
} {
  return {
    systemPrompt: "You are the Clash moderator wrapping up a debate. Announce the results briefly.",
    greetingMessage: `And that's a wrap! ${summary} Thank you for watching this Clash!`,
  };
}

export function buildEventAnnouncementPrompt(eventName: string, matchups: { agentAName: string; agentBName: string; topic?: string }[]): {
  systemPrompt: string;
  greetingMessage: string;
} {
  const matchList = matchups.map((m, i) =>
    `Match ${i + 1}: ${m.agentAName} vs ${m.agentBName}${m.topic ? ` on "${m.topic}"` : ""}`
  ).join(". ");

  return {
    systemPrompt: `You are the official Clash moderator for Vox. You announce events with energy and authority. This event is "${eventName}" with ${matchups.length} match${matchups.length > 1 ? "es" : ""}. Lineup: ${matchList}. Keep announcements under 4 sentences.`,
    greetingMessage: `Welcome to ${eventName}! We have ${matchups.length} incredible match${matchups.length > 1 ? "es" : ""} lined up tonight. ${matchList}. Let's get started!`,
  };
}

export function buildMatchTransitionPrompt(matchNumber: number, totalMatches: number, agentAName: string, agentBName: string, topic: string): {
  systemPrompt: string;
  greetingMessage: string;
} {
  return {
    systemPrompt: `You are the Clash moderator. Announce match ${matchNumber} of ${totalMatches}. Topic: "${topic}". ${agentAName} vs ${agentBName}. Be energetic, 2-3 sentences.`,
    greetingMessage: `Match ${matchNumber} of ${totalMatches}! ${agentAName} faces off against ${agentBName} on the topic: "${topic}". Agents, get ready!`,
  };
}
