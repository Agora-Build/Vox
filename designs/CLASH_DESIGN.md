# Clash — Design Document

Clash is Vox's **head-to-head arena for conversational AI voice agents**: two
agents hold a live, moderated voice debate on a topic, spectators listen in
real time on the website, and outcomes feed an Elo rating. It is the
competitive counterpart to Vox's benchmark-style evals — instead of measuring
one agent against a scripted scenario, Clash measures agents against *each
other* in a genuine conversation.

## 1. Goals

- Run **live matches** between two voice agents (Agent A vs Agent B) on a
  topic, orchestrated by an AI **moderator**.
- Make the **whole match voice — Agent A + Agent B + moderator — audible live**
  on the public event page (`/clash/event/:id`) and **captured** in the match
  recording.
- Rank agents via **Elo** from match outcomes.
- Scale via a **warm pool** of runner containers that execute matches
  back-to-back.

## 2. Components

| Component | Where | Role |
|---|---|---|
| Vox server | `server/routes.ts` (clash endpoints), `server/agora.ts`, `server/clash-ws.ts` | Events/matches/schedules, runner assignment, tokens, ConvoAI moderator control, WS relay |
| Clash runner | `vox_clash_runner/` (Docker, warm pool) | Executes matches: browsers, audio graph, RTC broadcast, recording, metrics |
| Moderator | Agora ConvoAI agent (`server/agora.ts:startModerator`) | LLM+TTS+ASR bot in the RTC channel; scripted announcements per phase |
| Spectator page | `client/src/pages/clash-event.tsx` + `client/src/components/agora-spectator.tsx` | Joins the RTC channel as audience and plays every publisher |
| WS hub | `server/clash-ws.ts` | Runner→spectator signalling relay (metrics ticks, spectator counts) — *not* the audio path |

## 3. RTC channel topology

**One Agora RTC channel per event**: `clash-event-{eventId}`
(`clashEvents.agoraChannelName`). All audio — agents, moderator, spectators —
flows through this single channel. UIDs ≤ 10,000 are reserved for system use.

| UID | Participant | RTC role | Publishes | Subscribes |
|---|---|---|---|---|
| 100 | Agent A broadcaster (`agora-broadcaster.cpp`) | publisher | Agent A's voice (from `Sink_A_Out.monitor`) | — |
| 200 | Agent B broadcaster | publisher | Agent B's voice | — |
| 300 | Receiver (`agora-receiver.cpp`) | audience | — | **moderator only** (`--filterUid <moderatorUid>`) |
| 500 | Moderator (ConvoAI) | publisher | Moderator TTS | `["*"]` — hears both agents |
| 10001+ | Spectators (web) | audience | — | every publisher (A + B + moderator) |

The moderator UID is defined once server-side (`MODERATOR_UID` in
`server/agora.ts`) and delivered to the runner in the assignment payload
(`agora.moderatorUid`), which passes it to the receiver's `--filterUid`. The
runner falls back to 500 if an older server omits the field.

## 4. Local audio graph (runner container)

No physical sound card. The runner uses **PipeWire** with the PulseAudio
compat layer (`pipewire-pulse`) and four virtual **null sinks** created at
container boot (`audio/pipewire-setup.sh`):

```
Sink_A_Out  — Browser A's speaker (PULSE_SINK)
Sink_B_Out  — Browser B's speaker
Sink_A_In   — Browser A's mic feed; exposed to the browser as source Mic_A (PULSE_SOURCE)
Sink_B_In   — Browser B's mic feed; exposed as source Mic_B
```

Each browser is a separate Chromium process launched with per-process
`PULSE_SINK` / `PULSE_SOURCE` env (`browser-agent.ts`), so A and B are fully
isolated. Setup waits for `pactl info` readiness (bounded retries) and
verifies all four sinks exist before declaring success.

**Mic exposure (critical).** Chromium/WebRTC does **not** enumerate a PipeWire
`.monitor` as a microphone, so pointing the browser at `Sink_A_In.monitor`
makes `getUserMedia` fail with `NotFoundError` — the agent's voice web app then
never starts its call and the agent is silent. Setup therefore remaps each
input-sink monitor into a real capture source (`module-remap-source` →
`Mic_A` / `Mic_B`), and the browsers use those as `PULSE_SOURCE`. The runner
also launches Chromium in **new headless** mode (`--headless=new`); old
headless has no audio stack, so browser audio never reaches `Sink_*_Out`.

### The full graph

```
                        ┌──────────────────────────  RTC channel clash-event-{id} ─┐
                        │                                                          │
Browser A ──► Sink_A_Out ──► parec ──► agora-broadcaster (uid 100) ──► publishes ──┤
     ▲              │                                                              │
     │              └──(loopback)──► Sink_B_In ──► .monitor ──► Browser B mic      ├──► Spectators
     │                                                                             │    (subscribe all)
Browser B ──► Sink_B_Out ──► parec ──► agora-broadcaster (uid 200) ──► publishes ──┤
     ▲              │                                                              │
     │              └──(loopback)──► Sink_A_In ──► .monitor ──► Browser A mic      │
     │                                                                             │
     └── pacat ◄── agora-receiver (uid 300, --filterUid=moderator) ◄── Moderator ──┘
         (into BOTH Sink_A_In and Sink_B_In)                          (uid 500, ConvoAI,
                                                                       hears * )
```

### Hearing-path matrix

| Path | Mechanism | Failure policy |
|---|---|---|
| A hears B / B hears A | 2× `module-loopback` (`Sink_X_Out.monitor → Sink_Y_In`, 20 ms) | **Fatal** — cross-wire failure fails the match (a debate where agents can't hear each other is garbage data) |
| A & B hear moderator | receiver (uid 300) subscribes channel, drops every frame except the moderator uid, pipes PCM → `pacat` → both `Sink_*_In` | Degraded — match continues without moderator; receiver has its own startup guard and failures are logged loudly |
| Moderator hears A & B | ConvoAI `remote_rtc_uids: ["*"]` + agents published at uids 100/200 | Degraded — depends on broadcasters running; per-broadcaster startup guards |
| Spectators hear everything | Web SDK audience joins the event channel and plays every publisher | Spectator-side only |

**Why no echo:** output and input are *separate* sinks. Broadcasters capture
only `Sink_*_Out` (what the agent said); the moderator and cross-wire audio
land only in `Sink_*_In` (what the agent hears). The receiver's uid filter
drops the agents' own published audio, so nothing an agent says is ever fed
back into any mic.

## 5. Match lifecycle

Warm-pool loop (`clash-runner.ts`): boot PipeWire + sinks once → register →
heartbeat (15 s) → poll for assignment (5 s) → execute match → report → poll again.

Per match:

1. Fetch secrets (non-fatal on failure).
2. Launch Browser A, then Browser B (setup steps per agent profile).
3. **Cross-wire** (after a settle delay): unload any stale loopbacks from a
   previous/crashed match, load the two new loopbacks, record their module IDs.
   Failure ⇒ match fails.
4. **Start observer + broadcast**: stereo recording (`parec` × 2 → sox),
   two agent broadcasters (uids 100/200), the moderator receiver (uid 300)
   piping to both In-sinks, and a tee of the moderator PCM to
   `moderator_out.raw` for the recording mix.
5. **Moderator phases** (`/api/clash/moderator/*`): `start` (ring-announcer
   greeting) → `brief_a` → `brief_b` → `start` announce → short pause so the
   "begin" line isn't talked over. Every phase is a scripted
   `speak(..., INTERRUPT)`; all failures are degraded, never fatal.
6. **Conversation window**: `maxDurationSeconds`. Metrics WS tick every 500 ms.
7. **Teardown**: stop observer/broadcast/receiver, **unload the loopback
   modules recorded in step 3**, close browsers, `end` announce, moderator stop.
8. **Finalize recording**: A = left channel, B = right channel, moderator
   mixed into both (skipped gracefully if the moderator file is empty).
9. Compute metrics (see §7) and `POST /api/clash-runner/complete`.

The error path performs the same teardown (including loopback unload) and
reports the match as failed.

### Scheduling & reaping (server)

- Events come from manual creation or `clashSchedules` (cron, every 60 s).
- The assignment scheduler (every 10 s) pairs one pending match per live event
  with an idle runner in-region; match → `starting`, runner → `assigned`.
- **Stuck-match reaper**: a match is considered stuck only after
  `maxDurationSeconds + 180 s buffer` (per-match, not a flat cutoff), covering
  briefing/setup/teardown overhead so healthy matches are never reaped mid-run.

## 6. Spectator listen path (`/clash/event/:id`)

`GET /api/clash/matches/:id/stream-info` issues an audience token with a
stable per-user/IP-derived uid (≥ 10001). `AgoraSpectator` joins the event
channel, subscribes to **every** published audio track (agents 100/200 +
moderator 500 = the whole match voice), and plays them. Mute is a local
toggle and is respected by publishers that join mid-match.

## 7. Metrics & outcome

- The observer records both agents (stereo WAV, moderator mixed in) and
  computes **audio-health metrics** from the raw captures: per-agent RMS and
  talk-time (share of frames above a silence threshold). A silent agent or a
  dead pipeline is detectable from the completed match record.
- **Known gap:** turn-level conversation metrics (response latency, interrupt
  behavior) are not yet computed — `responseLatencyMedian` etc. are null, so
  the latency-based winner rule currently yields draws. Full VAD/turn analysis
  is a future work item; until then Elo movement is minimal by design.

## 8. Failure-handling policy

| Failure | Policy |
|---|---|
| PipeWire/sink setup incomplete at boot | Fatal for the container — setup script exits non-zero after bounded readiness retries |
| Cross-wire load fails | **Fatal for the match** (reported as match error) |
| One agent broadcaster fails to start | Degraded — the other broadcaster and the receiver still run; logged loudly |
| Receiver fails to start / dies | Degraded — agents lose moderator audio; logged loudly; match continues |
| Moderator start/announce/stop HTTP failures | Degraded — match continues without that phase |
| `moderatorAvailable: false` (ConvoAI unconfigured) | Match runs agent-vs-agent only |
| Runner crash mid-match | Server reaper fails the match after `maxDuration + buffer`; next match's cross-wire defensively unloads stale loopbacks |

## 9. Testing strategy

Three layers:

1. **Unit (vitest, `tests/clash-audio.test.ts` + `clash-runner.test.ts`)**
   — audio config arg builders, loopback module-ID parsing, receiver
   `--filterUid` plumbing (incl. default), RMS/talk-time math on synthetic
   PCM, Elo, secret resolution.
2. **Integration (`tests/clash-runner-lifecycle.test.ts`, needs local server)**
   — tokens, registration, heartbeat, full match lifecycle incl. failure path,
   moderator endpoints, assignment payload carries `moderatorUid`, per-duration
   reaper cutoff logic.
3. **Docker audio pipeline (`vox_clash_runner/audio/test-audio-pipeline.sh`)**
   — runs inside the real container with real PipeWire: **real sox-generated
   tones with RMS non-silence assertions** (never `/dev/zero` byte counts),
   both cross-wire directions, the moderator path into both In-sinks, a true
   isolation test, and a warm-pool teardown test (wire → unload → count
   loopback modules → repeat) that guards against the module-leak class of bug.

## 10. File map

```
server/routes.ts           clash + clash-runner + moderator endpoints, schedulers
server/agora.ts            tokens, MODERATOR_UID, ConvoAI start/speak/stop, prompts
server/clash-ws.ts         runner↔spectator WS relay
shared/schema.ts           clashEvents/Matches/AgentProfiles/Runners/Schedules
vox_clash_runner/
  clash-runner.ts          warm-pool orchestrator (lifecycle above)
  browser-agent.ts         Chromium launch w/ per-process PULSE_SINK/SOURCE
  audio/pipewire-setup.sh  daemons + 4 null sinks + readiness verification
  audio/config.ts          16 kHz mono s16le; parec/pacat/sox arg builders
  audio/observer.ts        cross-wire (+unwire), recording, audio-health metrics
  audio/broadcaster.ts     agent broadcasters, moderator receiver, moderator tee
  audio/agora-broadcaster.cpp / agora-receiver.cpp   RTC publish / filtered subscribe
  audio/test-audio-pipeline.sh   Docker audio test suite
client/src/pages/clash-event.tsx + components/agora-spectator.tsx   live listening
```
