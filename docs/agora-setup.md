# Agora Setup Guide

## Required Environment Variables

### RTC (audio streaming)
```
AGORA_APP_ID=<app id>
AGORA_APP_CERTIFICATE=<app certificate>
```

### ConvoAI Moderator
```
AGORA_CUSTOMER_ID=<REST API customer ID>
AGORA_CUSTOMER_SECRET=<REST API customer secret>
AGORA_CONVOAI_CONFIG=<JSON with LLM/TTS/ASR config>
```

## Getting Credentials with atem CLI

```bash
# List projects
atem list project

# Set active project (use ConvoAI-enabled project)
atem project use <app_id>

# Get app ID and certificate
atem project show --with-certificate

# Generate RTC token for testing
atem token rtc create --channel test-channel --uid 100 --role publisher

# Decode a token
atem token rtc decode <token>
```

## AGORA_CONVOAI_CONFIG Format

Single-line JSON containing LLM, TTS, and ASR configuration:

```json
{
  "llm": {
    "url": "https://api.groq.com/openai/v1/chat/completions",
    "api_key": "gsk_...",
    "params": { "model": "openai/gpt-oss-120b" }
  },
  "tts": {
    "vendor": "minimax",
    "params": {
      "key": "...",
      "group_id": "...",
      "model": "speech-02-turbo",
      "url": "wss://api-uw.minimax.io/ws/v1/t2a_v2",
      "english_normalization": true,
      "voice_setting": { "voice_id": "...", "emotion": "angry" },
      "audio_setting": { "sample_rate": 44100 }
    }
  },
  "asr": {
    "language": "en-US",
    "vendor": "ares",
    "params": {}
  }
}
```

Note: Coolify may escape quotes in env vars (`\"` instead of `"`). The server handles this automatically.

## UID Reservation

| Role | UID | Notes |
|------|-----|-------|
| Agent A broadcaster | 100 | Fixed |
| Agent B broadcaster | 200 | Fixed |
| Moderator | 500 | Fixed |
| Reserved | 1-10,000 | Internal system use |
| Spectators | 10,001+ | Per-user, stable across refresh |

## ConvoAI API Endpoints

Base URL: `https://api.agora.io/api/conversational-ai-agent/v2/projects/{appId}`

| Action | Method | Path |
|--------|--------|------|
| Start agent | POST | `/join` |
| Stop agent | POST | `/agents/{agentId}/leave` |
| Speak (TTS) | POST | `/agents/{agentId}/speak` |

Auth: Basic (base64 of `AGORA_CUSTOMER_ID:AGORA_CUSTOMER_SECRET`)
