/**
 * Agora RTC token generation and ConvoAI moderator lifecycle management.
 *
 * Required env vars for RTC:
 *   AGORA_APP_ID, AGORA_APP_CERTIFICATE
 *
 * Required env vars for ConvoAI:
 *   AGORA_CUSTOMER_ID, AGORA_CUSTOMER_SECRET — Agora REST API credentials
 *   AGORA_CONVOAI_CONFIG — JSON string with LLM/TTS/ASR config:
 *   {
 *     "llm": { "url": "...", "api_key": "...", "params": { "model": "..." } },
 *     "tts": { "vendor": "minimax", "params": { ... } },
 *     "asr": { "language": "en-US", "vendor": "ares", "params": {} }
 *   }
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
    process.env.AGORA_CUSTOMER_ID &&
    process.env.AGORA_CUSTOMER_SECRET &&
    process.env.AGORA_CONVOAI_CONFIG
  );
}

interface ConvoAIConfig {
  llm: Record<string, unknown>;
  tts: Record<string, unknown>;
  asr?: Record<string, unknown>;
}

function getConvoAIConfig(): ConvoAIConfig {
  const raw = process.env.AGORA_CONVOAI_CONFIG;
  if (!raw) throw new Error("Missing AGORA_CONVOAI_CONFIG env var");
  return JSON.parse(raw);
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
  const key = getEnv("AGORA_CUSTOMER_ID");
  const secret = getEnv("AGORA_CUSTOMER_SECRET");
  return "Basic " + Buffer.from(`${key}:${secret}`).toString("base64");
}

export async function startModerator(opts: StartModeratorOptions): Promise<string> {
  const appId = getEnv("AGORA_APP_ID");
  const url = `${CONVOAI_BASE_URL}/${appId}/agents`;
  const cfg = getConvoAIConfig();

  // Merge config with runtime values (channel, system prompt, greeting)
  const llm = {
    ...cfg.llm,
    system_messages: [
      { role: "system", content: opts.systemPrompt },
    ],
    greeting_message: opts.greetingMessage,
    max_tokens: 256,
  };

  const payload = {
    name: "clash-moderator",
    properties: {
      channel: {
        channel_name: opts.channelName,
        token: opts.token,
        uid: opts.uid,
      },
      llm,
      tts: cfg.tts,
      asr: cfg.asr || { language: "en-US", vendor: "ares", params: {} },
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
