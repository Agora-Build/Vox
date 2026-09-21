# DialF Feature Requests — Vox "Phone vs Agent" Evaluation

Date: 2026-09-21 · From: Vox · Full design: `2026-09-21-phone-vs-agent-design.md` · Protocol spec: `2026-09-21-unified-action-vocabulary-spec.md` (**Libretto**, → `Agora-Build/libretto`)
Verified against DialF `main` (`docs/PROTOCOL.md`, `server/crates/dialf/src/jobs/schema.rs`, `jobs/runner.rs`).

## Context (what Vox is building)

Vox is adding a **Phone vs Agent** evaluation mode: a target AI voice agent is evaluated over a real carrier/PSTN call instead of a browser. **DialF is the delegated phone runtime** — it holds the call and executes the simulated-user side of the conversation; Vox's eval daemon (`vox-eval-agentd`, co-located on the same host) compiles the eval scenario into a DialF job, invokes it over the local control socket, then runs offline analysis (`aeval analyze`) over DialF's recordings to produce the three primary metrics:

- **Turn Success Rate (TSR)** — STT + judging on the agent's speech, per turn
- **Response Latency** — end of user speech (tx leg) → agent speech onset (rx leg)
- **Interrupt Latency** — barge-in playback onset (tx) → agent speech stops (rx)

How Vox drives DialF (existing primitives, no change requested):

- **Outbound** (Vox calls the agent): `job.run` with steps starting `call.dial` / `call.wait_answered`
- **Inbound** (the agent calls us, triggered by Vox via the target's web UI or REST API): `autoanswer.serve {numbers[], path}`
- One call at a time per phone; the far-end-hangup / cancel semantics of `run_job()` are exactly what Vox's failure policy needs (job fails, partial results never reported)
- Loops/corpus are unrolled by Vox before submission — jobs arrive as flat steps with host file paths
- DialF's **BlackHole virtual-audio mode** will be used for CI of the whole pipeline (FYI, no change requested)

What's already sufficient: the ten-vad turn engine (`audio.play`, `audio.wait_for_speech` with `end_timeout_ms` / `silence_duration_ms` / `onset_duration_ms`), call control both directions, `sms.send`, and the `rx`/`tx`/`mix` recordings (mix stereo left=tx/user, right=rx/agent matches Vox's convention; the separate mono legs are ideal for analysis).

## Relation to Libretto (the standalone script protocol)

DialF's job vocabulary is being formalized as **Libretto** (`Agora-Build/libretto`), a generic portable action-script protocol; DialF is a founding implementer with a maintainer seat on spec majors. What this means concretely for DialF:

- **Your existing steps are already spec-shaped** — `call.dial/wait_answered/answer/hangup`, `audio.play`, `audio.wait_for_speech`, `sms.send` are canonical Libretto forms. Bare `wait`/`log` map to `control.wait`/`control.log` (please accept both during 0.x).
- **R1 + R2 + R3 below are exactly the `convo-phone` conformance profile gaps** — landing them makes DialF Libretto-conformant, not just Vox-compatible.
- **Recording stays your way:** Libretto makes whole-session recording a normative *engine obligation* (no `start_recording` step; t=0 = recording start) — DialF's always-record behavior is the model the spec adopted, along with your `skipped`-steps reporting and `tx`/`rx`/`mix` leg convention (mix left=tx/user, right=rx/agent).
- A **manifest** (JSON: implemented steps + spec version + which orchestrated steps you support in-call) is the only genuinely new artifact Libretto asks of you beyond the R-items.

## Requested features

### R1 — Per-step timestamps (required)

`StepOutcome` is currently `{index, description, summary}`. Add timing so step outcomes align with the recording timeline:

```jsonc
{ "index": 3, "description": "RSP_BASIC-001 response",
  "summary": "...", "t_start_ms": 12340, "t_end_ms": 19870 }   // relative to recording start
```

Plus the recording-start reference in the `job.run` result (epoch or explicit "t=0 is recording start"), and pass-through of an optional per-step `id` field (Libretto outcome envelope: `{index, id?, type, t_start_ms, t_end_ms, end_reason, summary}`).

**Why:** offline analysis must segment the rx audio into eval turns (which agent-speech span answers which question → TSR judging), anchor interrupt onsets, and cross-validate latency. Without timestamps, turn attribution is guesswork.

**Please also confirm:** the `tx` and `rx` legs are timeline-aligned from recording start (tx appears to be written same-length as rx, silent where nothing plays). If confirmed, response latency is computable purely from the two legs, with timestamps used for segmentation/validation.

### R2 — `audio.wait_for_speech_start` (required; the one new engine behavior)

A new step mirroring **aeval's barge-in primitive** exactly:

```yaml
- type: audio.wait_for_speech_start
  timeout_ms: 15000            # give up if the far end never starts speaking
  wait_after_start_ms: 2000    # after speech onset, wait this long, then return
```

Semantics: block until far-end speech **onset** (reuse the existing ten-vad onset detection / `onset_duration_ms` debounce), then a further `wait_after_start_ms`, then return **while the far end is still speaking**. The next step (an ordinary `audio.play`) thereby lands mid-speech — that *is* the scripted interrupt; a following `audio.wait_for_speech` captures the agent's reaction:

```yaml
- type: audio.play                     # ask a question
  file: corpus/en_question1.wav
- type: audio.wait_for_speech_start    # agent starts answering; let it run 2s
  timeout_ms: 15000
  wait_after_start_ms: 2000
- type: audio.play                     # barge-in (agent still talking)
  file: corpus/en_Short05Wordswav1.wav
- type: audio.wait_for_speech          # capture the reaction
  end_timeout_ms: 40000
```

On timeout (agent never spoke): record it in the step outcome (e.g. `end_reason: timeout`) and continue the job — the turn simply yields no interrupt sample; it must not abort the call.

**Why this exact shape:** aeval scripts all its interrupt evals this way (`examples/interrupt/I00–I07`, smoke-test Phase 2). Matching the primitive keeps Vox's scenario→DialF compiler 1:1, so every existing interrupt eval set runs over the phone unchanged. Interrupt latency is unmeasurable without it.

### R3 — Call metadata in the `job.run` result (required, small)

Include in the result (rather than requiring a follow-up `call.list`):

```jsonc
"call": { "answer_latency_ms": 4200, "duration_ms": 63500,
          "end_reason": "completed|far_end_hangup|no_answer|busy|rejected",
          "sim": "...", "remote_number": "+1555…" }
```

**Why:** shown on the Vox result page (disposition, answer time, duration) and used by the failure policy; fetching it separately races the next call.

### R4 — Job-level `max_duration_ms` (nice-to-have)

A per-job hard cap that hangs up and ends the job with a distinct outcome. Vox can approximate it today (client-side timeout + `job.cancel` + `call.hangup`), so this is robustness, not a blocker.

### R6 — Busy guard for concurrent clients (nice-to-have)

The control socket is multi-client (correct — the CLI is a client too), and `autoanswer.serve` is already exclusive. But while a `job.run` is mid-call, mutating ops from **other** connections (`call.hangup`/`call.dial`/`audio.play`/a second `job.run`) are not rejected — a concurrent CLI command can kill a live eval. Interference fails *clean* (far-end-hangup path → steps `skipped`, Vox discards partials), so this costs wasted runs/PSTN minutes, not corrupt data — hence nice-to-have. Proposed: while a job or serve session is active, reject mutating ops from other connections with a `busy` error + an explicit force flag for operator rescue. (Vox's v1 mitigation regardless: per-user `dialfd` owned by the eval-agent user, CLI reserved for provisioning/diagnostics.)

### R5 — Future (not needed for v1; flagging direction)

- `call.dtmf {digits}` — IVR menu navigation *before* the conversation ("press 2 for support"), used in Vox workflow session-establishment.
- `sms.wait {from?, match?, timeout_ms}` — block until a matching SMS arrives (OTP retrieval); `sms.list` exists but there is no blocking step.
- **`app.*` (long-run direction, reserved in the Libretto spec):** native-app evaluation ("App vs Agent"). DialF is the natural engine candidate — the headset-jack audio bridge is app-agnostic (any app's audio produces the same `rx`/`tx` legs), the ten-vad conversation engine is unchanged, and adb integration exists (`devices share`); the missing capability is third-party-app UI automation (adb/uiautomator-driven `app.launch/tap/fill/wait_for`). Flagging direction only — no v1 action, and no commitment implied if an Appium/Maestro-class engine turns out to fit better (esp. for iOS).

## Priority

**R1 + R2 + R3 unblock the Vox phone-eval v1.** R2 is the only new engine behavior; R1/R3 are result-shape enrichments. R4/R5 can trail.
