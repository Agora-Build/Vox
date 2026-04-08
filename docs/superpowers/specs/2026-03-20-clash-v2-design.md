# Clash v2: Events + Matches Architecture

## Overview

Clash is a head-to-head AI voice agent duel system. Two AI agents debate a topic live while spectators watch. Clash v2 introduces **events** as the primary container, a **warm runner pool**, **live spectator dashboard** with real-time transcript and metrics, and a **central moderator** that orchestrates the entire match flow.

**Core principles:**
- Benchmark-first: measurement-grade audio for accurate latency comparison
- Every match belongs to an event (no standalone matches)
- Local PipeWire for agent-to-agent audio; Agora RTC for spectating + moderator
- Warm runner pool for near-instant match starts
- API-mode agents designed in, deferred (browser mode only for v2)

---

## Data Model

### New enum: `clashEventStatusEnum`

Values: `upcoming`, `live`, `completed`, `cancelled`

### New enum: `clashRunnerStateEnum`

Values: `idle`, `assigned`, `running`, `draining`

### New table: `clashEvents`

| Column | Type | Notes |
|--------|------|-------|
| id | serial PK | |
| name | text NOT NULL | "Friday Night Fights" or auto-generated "{AgentA} vs {AgentB}" |
| description | text | nullable |
| createdBy | FK → users | |
| region | regionEnum | |
| status | clashEventStatusEnum | default `upcoming` |
| visibility | visibilityEnum | public / private |
| scheduledAt | timestamp | nullable, when event starts |
| agoraChannelName | text | nullable, set on creation if Agora configured |
| moderatorAgentId | text | nullable, ConvoAI agent ID |
| startedAt | timestamp | nullable |
| completedAt | timestamp | nullable |
| createdAt | timestamp | default now |

Index: `status` column.

### Modified table: `clashMatches`

**Added columns:**
- `eventId` (FK → clashEvents, NOT NULL, ON DELETE CASCADE) — every match belongs to an event
- `matchOrder` (integer, NOT NULL, default 1) — position within event
- `winnerId` (FK → clashAgentProfiles, nullable) — explicit winner, null = draw

**Removed columns** (moved to event):
- `region` — lives on event
- `createdBy` — lives on event
- `scheduledAt` — lives on event
- `agoraChannelName` — lives on event
- `moderatorAgentId` — lives on event
- `broadcastChannelId` — replaced by event's agoraChannelName

### Modified table: `clashSchedules`

**Changed columns:**
- Remove `agentAProfileId`, `agentBProfileId`, `topic`
- Add `eventName` (text, NOT NULL) — template name for auto-created events
- Add `matchups` (jsonb, NOT NULL) — array of `{agentAProfileId, agentBProfileId, topic?}`

### New table: `clashRunnerPool`

| Column | Type | Notes |
|--------|------|-------|
| id | serial PK | |
| runnerId | text UNIQUE NOT NULL | Container hostname |
| tokenHash | text UNIQUE NOT NULL | Long-lived auth token (SHA256 hashed) |
| region | regionEnum | |
| state | clashRunnerStateEnum | default `idle` |
| currentMatchId | FK → clashMatches | nullable, set when assigned |
| lastHeartbeatAt | timestamp | nullable |
| metadata | jsonb | default `{}` |
| createdAt | timestamp | default now |

Index: `state` column.

### New table: `clashTranscripts`

| Column | Type | Notes |
|--------|------|-------|
| id | serial PK | |
| clashMatchId | FK → clashMatches ON DELETE CASCADE | |
| speakerLabel | text NOT NULL | "agent_a", "agent_b", "moderator" |
| text | text NOT NULL | Utterance content |
| startMs | integer NOT NULL | Offset from match start |
| endMs | integer | nullable |
| confidence | real | nullable, STT confidence |
| createdAt | timestamp | default now |

Index: `clashMatchId` column.

### Modified table: `clashAgentProfiles`

**Added column:**
- `adapterType` (text, default `"browser"`) — for future API mode. Values: `browser`, `websocket`, `webrtc`.

---

## System Architecture

```
Spectators (vox.agora.build/clash/event/:id)
│  Agora RTC (audio) + WebSocket (metrics/transcript)
▼
┌──────────────────────────────────────────┐
│   Agora Cloud                            │
│   • RTC Channel: clash-event-{eventId}   │
│   • ConvoAI Moderator (announce + STT)   │
│   • Cloud Recording                      │
└──────────┬───────────────────────────────┘
           │
┌──────────▼───────────────────────────────┐
│   Vox Server (Orchestrator)              │
│   • Event lifecycle management           │
│   • Runner pool management               │
│   • Moderator ConvoAI lifecycle          │
│   • RTC token generation                 │
│   • WebSocket hub (metrics + transcript) │
│   • Match scheduling cron                │
└──────────┬───────────────────────────────┘
           │  HTTP + WebSocket
┌──────────▼───────────────────────────────┐
│   Clash Runner (Docker, warm pool)       │
│   • PipeWire virtual sinks (A, B, Mixed) │
│   • Browser A + B (Playwright)           │
│   • Observer (VAD, turn detection, rec)  │
│   • Broadcaster (Mixed → Agora RTC)      │
│   • WebSocket to server (live metrics)   │
└──────────┬───────────────────────────────┘
           │  PipeWire cross-wire (sub-ms)
┌──────────▼───────────────────────────────┐
│   Agent A (Chromium)  ←→  Agent B        │
└──────────────────────────────────────────┘
```

---

## Event Lifecycle

### Phase 1 — Setup (status: `upcoming` → `live`)

1. Schedule fires or user creates event via API/console
2. Server creates `clashEvent` with status `upcoming`, creates all `clashMatches` (status `pending`)
3. Agora channel name set: `clash-event-{eventId}`
4. When `scheduledAt` reached (or manual start):
   - Event status → `live`
   - Moderator ConvoAI agent starts in Agora channel
   - Moderator announces event and first match lineup

### Phase 2 — Match Execution (sequential, per match)

For each match in `matchOrder`:

1. **Assign runner**: Server picks idle runner from pool in matching region, sets state `assigned`
2. **Runner setup**: Runner gets match config via `GET /api/clash-runner/assignment`, launches browsers, runs setup steps
3. **Moderator briefs**: Server updates moderator prompt to brief each agent
4. **Cross-wire + observe**: PipeWire links A↔B, observer starts recording + VAD, broadcaster publishes to Agora channel
5. **Moderator: "Begin!"**: Match status → `live`, debate runs
6. **Live data**: Runner streams metrics via WebSocket. ConvoAI provides transcript via callbacks. Server relays both to spectators.
7. **Match ends**: Timer expires. Runner stops observer, reports metrics + recording.
8. **Results**: Server computes winner, updates Elo, stores results. Moderator announces result.
9. **Runner returns**: Runner state → `idle`, ready for next match

### Phase 3 — Wrap-up (status: `completed`)

1. After last match completes, moderator announces final event results
2. Server stops moderator ConvoAI agent
3. Event status → `completed`
4. All recordings and transcripts available for replay

---

## API Endpoints

### Events (authenticated)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/clash/events` | List public + own events (filterable by status) |
| POST | `/api/clash/events` | Create event with matchups array |
| GET | `/api/clash/events/:id` | Event detail with all matches |
| POST | `/api/clash/events/:id/start` | Start event manually (owner/admin) |
| POST | `/api/clash/events/:id/cancel` | Cancel event (owner/admin) |

### Matches (mostly public)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/clash/matches/:id` | Match detail + results |
| GET | `/api/clash/matches/:id/stream-info` | Agora RTC token for spectator |
| GET | `/api/clash/matches/:id/transcript` | Transcript for completed match |

### Runner Pool (`/api/clash-runner/`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/clash-runner/register` | Runner joins pool (long-lived token) |
| POST | `/api/clash-runner/heartbeat` | Health check every 15s |
| GET | `/api/clash-runner/assignment` | Get assigned match config + secrets |
| POST | `/api/clash-runner/complete` | Report results, return to idle |

### Moderator (runner → server)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/clash/moderator/start` | Start moderator for event |
| POST | `/api/clash/moderator/announce` | Phase transition (brief_a, brief_b, start, end) |
| POST | `/api/clash/moderator/stop` | Stop moderator |

### WebSocket

| Path | Direction | Data |
|------|-----------|------|
| `/ws/clash-runner/:matchId` | Runner → Server | Live metrics (latency, VAD, speaker activity) every 500ms |
| `/ws/clash/:matchId` | Server → Spectators | Metrics + transcript + status + spectator count |

### Public

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/clash/feed` | Live + upcoming + recent events for /clash page |
| GET | `/api/clash/leaderboard` | Elo rankings |

### Profiles + Schedules (existing, modified)

| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/api/clash/profiles` | Agent profile CRUD (unchanged) |
| PATCH/DELETE | `/api/clash/profiles/:id` | Agent profile update/delete (unchanged) |
| GET/POST | `/api/clash/schedules` | Schedule CRUD (matchups JSONB instead of single pair) |
| PATCH/DELETE | `/api/clash/schedules/:id` | Schedule update/delete |

---

## Frontend Pages

### `/clash` — Event Feed

Three sections:
- **Live Now**: Events with status `live`, showing current match and progress
- **Upcoming**: Events with status `upcoming`, showing scheduled time and lineup
- **Recent**: Completed events with results summary

Each event card shows: name, region, match count, status badge, match lineup preview. Click → `/clash/event/:id`.

### `/clash/event/:id` — Event Detail

- Event header: name, description, status, region, timing
- **When live**: Current match spectator view (Agora audio + live transcript + live metrics), match lineup below
- **When upcoming**: Countdown, match lineup
- **When completed**: Final results, all match results, recordings, full transcripts

### `/clash/event/:id/match/:matchId` — Match Detail (existing clash-detail, rerouted)

Same as current `/clash/:id` but nested under event. Shows: metrics comparison, recording, transcript.

### `/console/clash` — Console

Three tabs:
- **Agent Profiles**: unchanged
- **Events**: replaces "My Clashes" — create events (quick 1v1 or multi-match), view own events
- **Schedules**: unchanged (but matchups JSONB for multi-match scheduling)

Quick 1v1 flow: pick 2 agents + topic + region → auto-creates event named "{AgentA} vs {AgentB}" with 1 match.

---

## Runner Pool Management

- Runners register on startup with long-lived tokens (like eval agent registration)
- Server maintains pool: configurable via `CLASH_RUNNER_POOL_MIN` / `CLASH_RUNNER_POOL_MAX`
- Health check: runners heartbeat every 15s; if missed for 45s → state `draining`
- Match assignment: server picks idle runner in target region, sets state `assigned`
- After match: runner returns to `idle`
- PipeWire is pre-started in warm containers (no cold-start setup time)

Runner states: `idle` → `assigned` → `running` → `idle` (loop) or → `draining` (unhealthy)

---

## Audio Architecture

**Agent-to-agent (measurement path):**
- PipeWire virtual sinks: Virtual_Sink_A, Virtual_Sink_B
- Cross-wired via pw-link: A.monitor → B.input, B.monitor → A.input
- Sub-millisecond latency, raw PCM access for accurate VAD and latency measurement

**Spectator broadcast:**
- Mixed_Sink captures both agent monitors (A=left, B=right)
- 3rd Playwright browser loads broadcast.html, captures Mixed_Sink, publishes to Agora RTC channel
- Spectators join as audience via agora-rtc-sdk-ng

**Moderator:**
- Agora ConvoAI agent joins the same RTC channel
- Announces, briefs agents, announces results
- Built-in STT provides transcript data via callbacks

**Recording:**
- Local stereo WAV via parec + sox (agent A = left, agent B = right)
- Agora Cloud Recording as backup/alternative

---

## Moderator System

The moderator is an Agora ConvoAI agent that serves three roles:

1. **Announcer**: Introduces matches, announces results, controls flow
2. **Transcriber**: ConvoAI's built-in STT provides real-time transcript
3. **Flow controller**: Determines when agents are briefed, when debate starts/ends

Moderator prompts are managed by the server via `POST /api/clash/moderator/announce` with phase parameter:
- `announce`: Event/match introduction
- `brief_a`: Brief Agent A on topic and opponent
- `brief_b`: Brief Agent B
- `start`: "Let the clash begin!"
- `end`: Announce results and wrap up

One ConvoAI agent per event (persists across all matches in the event).

---

## STT Pipeline

Uses Agora ConvoAI's built-in STT capabilities:
- The moderator ConvoAI agent listens to all audio in the channel
- Transcribes utterances with speaker identification
- Server receives transcript segments via ConvoAI webhook/polling
- Segments stored in `clashTranscripts` table
- Relayed to spectators via WebSocket in real-time

No separate STT service needed.

---

## Elo Rating System

Unchanged from current implementation:
- K-factor: 32
- Win threshold: agent's response latency median < 90% of opponent's
- Draw threshold: within 10% of each other
- New agents start at 1500
- Elo updated per match (not per event)
- Leaderboard shows public profiles only

Added: `winnerId` column on `clashMatches` for explicit winner tracking.

---

## Environment Variables (new)

| Variable | Required | Description |
|----------|----------|-------------|
| AGORA_APP_ID | For RTC | Agora App ID |
| AGORA_APP_CERTIFICATE | For RTC | Token generation |
| AGORA_CUSTOMER_KEY | For moderator | ConvoAI REST API |
| AGORA_CUSTOMER_SECRET | For moderator | ConvoAI REST API |
| AGORA_CONVOAI_LLM_URL | For moderator | LLM endpoint |
| AGORA_CONVOAI_LLM_API_KEY | For moderator | LLM API key |
| AGORA_CONVOAI_TTS_VENDOR | For moderator | Default: microsoft |
| AGORA_CONVOAI_TTS_KEY | For moderator | TTS API key |
| AGORA_CONVOAI_TTS_REGION | For moderator | Default: eastus |
| CLASH_RUNNER_POOL_MIN | Optional | Min warm runners (default: 2) |
| CLASH_RUNNER_POOL_MAX | Optional | Max runners (default: 10) |
