# Phone vs Agent Evaluation — Design Discussion Draft

**Status: DRAFT for review — no code changes yet.**
Date: 2026-09-21

---

## 1. Goal

Add a second evaluation mode, **Phone vs Agent**, alongside the existing **Web vs Agent**:

| Mode | Transport | Trigger | Audio capture |
|---|---|---|---|
| Web vs Agent (today) | Browser / WebRTC | `platform.setup` opens the target web app | Virtual soundcard on the agent host |
| Phone vs Agent (new) | Carrier / PSTN / SIP gateway / call center | Workflow establishes the call: `browser.*`/`restful.*` (agent dials out) or `call.dial` (DialF calls the agent) | DialF controls the call and records the line (stereo) |
| App vs Agent (future) | Native app VoIP / RTC | TBD | TBD — explicitly out of scope, but the model must not block it |

Both modes produce the same primary metrics — **TSR, Response Latency, Interrupt Latency** — through the same analysis model, so results are comparable at the platform level.

**Architectural goal:** separate *evaluation semantics* (conversation script, metrics, analysis) from the *transport* (how audio travels and how the session is established).

## 2. What the codebase already gives us

Three existing seams carry most of this design:

1. **Eval-set scenarios are already transport-agnostic.** Steps like `audio.play`, `audio.wait_for_speech`, `control.for_each` describe conversation semantics, not browsers. The browser-specific part (`platform.setup`) is session establishment, which is exactly the part that changes per transport. An existing eval set should be runnable over the phone transport without modification (with an audio-quality caveat, §9).
2. **The broker registry is generic.** `brokers` rows carry a free-text `brokerType` declared at registration; Core dispatches work lease-fenced to a live broker of the requested type. Adding a second trusted-execution verb does not require new registry machinery.
3. **The daemon's metric mapping reads a fixed `metrics.json` shape** (`response_metrics.latency.turn_level[]`, `interruption_metrics...`). If `aeval analyze` on a phone recording emits the same shape, the entire daemon→`evalResults`→UI metric path is reused untouched.

## 3. Evaluation model (D1)

**Add `transport` to `workflows`:** enum `('web', 'phone')`, default `'web'`, extensible to `'app'` later.

Why on the workflow (not the eval set, not the job):

- The workflow already owns "how to reach the target" (`platform.setup` YAML, provider, secrets). The transport is a property of the target, i.e., workflow territory.
- Eval sets stay transport-agnostic: one conversation script, runnable over web or phone. No forking of the eval-set library.
- The job **snapshot** freezes `transport` at creation (consistent with the existing immutable-snapshot rule) — everything downstream (dispatch gating, provenance UI, tiering) reads the frozen value.

`evalResults` needs no new metric columns — TSR/latency columns are shared. It gains one nullable jsonb, `callMetadata` (§7), populated only for phone jobs.

**Naming rationale.** `web | phone | app` is a **shared endpoint-transport vocabulary**, not a convo-specific channel list: it names the access technology of a simulated endpoint (browser/WebRTC, PSTN, native RTC stack). The eval *kind* is the orthogonal axis — and **it already exists in the schema**: `providers.sku` (`provider_sku` enum, `convoai | rtc`, `shared/schema.ts:10`). Every workflow carries a `providerId` FK and the job snapshot already freezes provider attribution, so the kind rides existing plumbing — **no new `evalKind` column, reserved or otherwise**. The two kinds use the transport vocabulary in different shapes:

- **convoai (this design):** `transport` **vs agent** — one scalar field; the far side is always the agent under test (implicit in the kind). Web vs Agent, Phone vs Agent, App vs Agent.
- **rtc (future):** `transport` **vs** `transport` — an endpoint *pair* (app vs app, app vs web, web vs web), a different config shape on workflows whose provider has `sku: rtc`, reusing the same values. Today's scalar field does not block this.

Rejected names: `evalChannel` (squats on the kind slot; "channel" collides with Agora RTC's room/session meaning), `convoChannel` (strands the shared vocabulary under convo — RTC wants the same words), `evalMode` (as a column: "mode" is semantically empty and would flatten both axes into one combinatorial enum once RTC pairs arrive), `browserMode`/`isPstn` (transport-coupled).

**"Evaluation Mode" is the official user-facing term** — the UI label for the derived kind+transport compound: sku `convoai` + transport `phone` renders "Phone vs Agent"; a future sku `rtc` + pair renders e.g. "App vs Web". Humans read modes; machines branch on the normalized fields (`providers.sku` × `workflows.transport`). See §11.

## 4. Call flow

**Call setup is workflow territory, in either direction.** The workflow's session-establishment section establishes the call using one of three instruction families — this is the phone analog of `platform.setup`:

| Trigger | Direction | Who dials | Number flow |
|---|---|---|---|
| `browser.*` (existing) | agent → DialF | Target agent (user clicks "Call me" in its web app) | DialF's `${phone.number}` injected into the web UI |
| `restful.*` (new, §5) | agent → DialF | Target agent (API triggers its outbound call) | `${phone.number}` interpolated into the request body |
| `call.dial` (new) | DialF → agent | DialF calls the target's number | Target number stored in workflow config |

`call.dial` covers the practically dominant case — call-center agents that *answer* rather than place calls — and needs no trigger machinery at all. The symmetry: outbound-from-agent injects *our* number into the trigger; inbound-to-agent stores *their* number in the workflow.

```
Vox Core ──dispatch──▶ vox-eval-agentd
                          │ run workflow session-establishment steps:
                          │   A) arm DialF, then browser.*/restful.* trigger  → agent dials out, DialF answers
                          │   B) call.dial                                    → DialF dials, agent answers
                          ▼
              ══ active call between DialF and target agent ══   (directions converge here)
                          ▼
                    DialF runs the simulated-user side (eval set's conversation block), records stereo
                          │ recording.wav (L=user, R=agent) + events.jsonl + call.json
                          ▼
                    daemon runs `aeval analyze` → metrics.json
                          ▼
                    daemon reports evalResults (existing mapping, unchanged)
```

Everything downstream of the converged state — conversation block, recording, analysis, metrics — is direction-blind. `${phone.number}` is resolved by the daemon locally at run time; it is never stored in the workflow.

## 5. `restful.*` instructions and trusted execution (D2)

New step family, **transport-agnostic** (**decided**): `restful.*` is available wherever a REST call is needed — phone-call triggering, seeding test data before a web eval, post-eval cleanup — not gated to any evaluation mode:

```yaml
- type: restful.request
  method: POST
  url: https://api.target.example/v1/calls
  headers:
    Authorization: "Bearer ${secrets.TARGET_API_KEY}"
  body:
    to: "${phone.number}"
  expect_status: [200, 201]
```

(A `restful.poll` variant — repeat GET until a condition — is deferred until a real target needs it. YAGNI.)

### Execution paths, decided by the secret's class

This mirrors the auth-session pattern exactly:

- **No secret, or secret with `brokerType == null` (runtime class):** the daemon executes the request directly from the normal eval environment. Nothing new — runtime secrets already reach the agent via the job-secrets path.
- **Secret with `brokerType == 'restful'` (new class):** the secret is **structurally withheld** from the job-secrets path at every dispatch tier, same as `auth-session` secrets today. The daemon instead calls a lease-fenced Core endpoint:

```
POST /api/eval-agent/jobs/:jobId/restful/:stepIndex   → 200 {status, sanitizedBody} | 502 {cause}
```

Core resolves the step from the **frozen job snapshot** (never from caller-supplied request data — same server-stamped discipline as `sessionInjection`), then **dispatches it to a broker** — it does not execute the request itself. The result returned to the agent is **sanitized**: HTTP status plus an allowlisted response projection. Raw response bodies can echo credentials; they never reach the agent.

### The trusted environment: an independent REST broker (**decided**)

**Broker-based from day one, routed by the secret's `brokerType`.** A new broker declares `brokerType: 'restful'` at registration (same value as the secret class — routing is a direct match, exactly how `auth-session` works today), and rides the existing registry unchanged: hashed registration token, internal-only advertise URL, per-broker mint secret, `(brokerType, state)` dispatch, lease fencing, cold-cache reregister after Core restarts. Core's role is snapshot resolution + secret decryption + dispatch; the broker executes the templated HTTP request and returns the sanitized projection.

Why broker over Core-direct (considered and rejected):

- **No SSRF surface added to Core.** Core never fetches attacker-influenceable URLs; the broker is network-isolated like the auth-session broker, and outbound-request hygiene (no RFC-1918/link-local targets unless configured, no cross-host redirects, response size caps) lives there.
- **Deployment is the flexibility mechanism.** No strict fixed-egress-IP requirements exist today, so a standard deployment is fine — and if a target system later requires an isolated environment or a fixed/allowlisted IP, the answer is *deploy this broker into that network*, with zero code change. Environment requirements are solved by broker placement, not by Core configuration.
- The registry machinery is already built and battle-tested; the marginal cost is one stateless sidecar image (far simpler than the auth-session broker — no browser, no aeval, no audio: plain HTTP execution).

**Failure ordering matters:** a failed brokered REST trigger fails the job **before** any phone resources are engaged (mirror of "a failed mint fails the job before any eval runs"). No wasted PSTN minutes, escrow refund semantics unchanged.

## 6. DialF integration (D3, D4)

*(This section was updated after reviewing the actual `Agora-Build/DialF` repo; the earlier assumed-HTTP contract is replaced by DialF's real interfaces.)*

### What DialF actually is

DialF drives a **real Android phone on its own SIM** — true carrier path, not a SIP trunk:

```
dialf (CLI) ──▶ dialfd (host daemon, Rust) ──WiFi/WebSocket──▶ DialF Phone app ── places/answers calls on the SIM
                     │
                     └─ USB sound card ◀── physical wire ──▶ phone headset jack   (all call audio)
```

- **Call control:** dial / answer / hang up / reject, auto-answer allow-list, dual-SIM, works while locked.
- **Scripted conversations:** YAML jobs with **ten-vad** voice-activity detection — DialF *already ships the simulated-user turn engine*.
- **SMS** send + live inbox, call log, voicemail control, MMI/USSD. The §14 `sms.*` namespace (incl. OTP retrieval) is already implementable.
- **Recording:** per-direction legs — `tx.wav` (user prompt audio), `rx.wav` (agent), plus `mix.wav` **stereo by direction: left = tx (user), right = rx (agent)** by default — exactly the L/R convention this design specified, and separate mono legs are even better for analysis (zero cross-talk by construction, modulo bridge bleed which DialF's config addresses with `remix` channel pinning).
- Linux & macOS, arm64 & x86_64; also a **BlackHole/virtual-audio mode** that runs the same job engine against a *local* agent with no phone or carrier — a free end-to-end test path for the phone pipeline in CI.

### Topology: co-located, confirmed

Co-location (recommended earlier as (a)) is now effectively **dictated**: `dialfd`'s control API is a **local Unix socket** (line-delimited JSON; `dialf` CLI is a thin client), and the phone must share WiFi with the host. `vox-eval-agentd` and `dialfd` run on the same host; the agent advertises phone capability + the SIM's country at registration. The daemon runs one job at a time, and DialF allows a single auto-answer serve session at a time — the one-line-one-call constraint is enforced at both ends naturally.

Provisioning per phone-capable host (answers former Q4): an Android 9+ phone with a SIM, the DialF Phone APK (default-dialer role), a USB sound card wired to the headset jack, and `dialfd` with the shared key. No SIP trunk, no carrier API account. Operator-managed, matching the §8 owner-operated restriction.

### Daemon ↔ DialF contract (real)

| Vox flow | DialF primitive |
|---|---|
| Inbound arm ("expect the agent's call") | `autoanswer.serve {numbers[], path}` — connection-scoped auto-answer override, streams `{event}` lines as the call is handled; override drops when the connection closes (crash-safe disarm for free) |
| Outbound (`call.dial` trigger) | `job.run` with a job whose first steps are `call.dial {number}` / `call.wait_answered {timeout_ms}` |
| Conversation + recording | the same `job.run` job body; returns `{steps:[...], recording:{rx,tx,mix}}` |
| Call metadata | `call.list` (call log) + job step results |

DialF's **native job vocabulary is nearly identical to aeval's and to §14's proposal**: `call.dial` / `call.wait_answered` / `call.answer` / `call.hangup`, `audio.play {file}`, `audio.wait_for_speech {end_timeout_ms, silence_duration_ms, onset_duration_ms}`, `sms.send`, `wait`, `log`. Sample jobs in the repo even tag turns with aeval-style eval IDs (`RSP_BASIC-001`). The §14 unified vocabulary is therefore not aspirational — it is substantially implemented across the two engines already, and the "turn manifest" compiler reduces to a **nearly 1:1 translation** from eval-set steps to a DialF job YAML.

### Who drives the conversation (D4 — resolved to baseline)

DialF already ships the VAD-paced turn engine the baseline assumed, with step semantics matching aeval's (`silence_duration_ms` pacing etc.). **Decision: baseline (i) — DialF drives the live conversation; metrics come from offline `aeval analyze` over the recordings.** The alternative (aeval gains a phone `audio_io.mode`) is no longer worth its cost given the engines already converge; the drift risk is managed by the shared compiler (eval-set → DialF job) rather than a shared runtime.

### How `vox-eval-agentd` calls DialF (process integration)

`dialfd` is an **independent daemon** (own systemd/launchd service, `dialf service install`; Vox never spawns or supervises it). Its control surface is a local **Unix domain socket**, line-delimited JSON (`{id, op, ...}` → `{id, ok, data|error}`); the `dialf` CLI is a thin client over the same socket. `vox-eval-agentd` speaks the **socket directly** (not the CLI): `autoanswer.serve` is connection-scoped — the inbound arm lives as long as the connection and streams `{event}` lines over it, so a held socket gives live progress *and* crash-safe disarm (daemon dies → connection drops → DialF reverts) for free.

Per-job sequence:

1. **Capability gating (continuous):** at startup + each heartbeat, check socket + `devices` (phone paired?). Present → advertise `phone` capability; absent → withdraw it, phone jobs stop being claimable. Self-healing, same pattern as GeoIP-absent → Unverified.
2. **Claim:** compile eval set → flat DialF steps; write corpus wavs where `dialfd` can read them.
3. **Run:** outbound = blocking `job.run {steps}` wrapped in the daemon's timeout (+ `job.cancel` on abort); inbound = hold a connection with `autoanswer.serve {numbers, steps}`, then execute the browser/restful trigger, read streamed events, close to disarm.
4. **Collect:** result carries step outcomes + `recording:{rx,tx,mix}` paths → `aeval analyze` → report.

**Deployment:** `dialfd` runs on the host (USB sound card + mDNS/WiFi to the phone); a dockerized `vox-eval-agentd` needs three mounts — the control socket, a shared corpus dir (step file paths must be valid on `dialfd`'s filesystem), and `record_dir` — plus `dialf`-group membership for the socket. Same host-coupling category as the existing `snd-aloop` / `--device /dev/snd` requirements; provisioning-script territory (`dev-local-run.sh` / `vox-upgrade.sh`), not architecture.

**Concurrent clients:** the socket is multi-client (the `dialf` CLI is just another client); read-only ops and the exclusive `autoanswer.serve` are safe, but mutating ops from a second connection during a live job are not guarded today — a stray `dialf call hangup` kills the eval (cleanly: hangup path → job failed, partials discarded — wasted run, never corrupt data). v1 mitigation: per-user `dialfd` owned by the eval-agent user; CLI reserved for provisioning/diagnostics. Structural fix requested as **R6** (busy guard) in the DialF requirements doc.

### Gap analysis: can DialF run the eval today? (verified against source, `jobs/schema.rs` + `jobs/runner.rs`)

**Supported today — sufficient as-is:**

| Need | DialF today |
|---|---|
| Sequential turn script with VAD pacing | `run_job()`: fail-stop runner over `audio.play` / `audio.wait_for_speech` (`end_timeout_ms`, `silence_duration_ms`, `onset_duration_ms` — same knobs as aeval) |
| Both call directions | `call.dial`/`call.wait_answered` (outbound) and `autoanswer.serve` inbound mode, which auto-skips call-setup steps |
| Far-end hangup mid-eval | Runner stops, records `caller hung up — remaining steps skipped` + marks every unrun step — exactly the evidence the failure policy needs |
| Cancellation | `job.cancel` op checked between steps — the daemon's job-timeout wrapper can bound a runaway call |
| Recordings | `rx`/`tx`/`mix` legs; `tx.wav` is written same-length as `rx` (silent where nothing played), i.e. the legs appear **timeline-aligned** — if confirmed, response latency is computable *fully offline* (end of speech in tx → onset in rx) with no runtime timing help |
| Per-step outcomes | `StepOutcome {index, description, summary}` streamed/returned |
| SMS, call log, dual-SIM | Already in the control API |

**Gaps — proposed DialF additions (in priority order):**

1. **Step timestamps** — `StepOutcome` today carries no timing. Add `t_start_ms`/`t_end_ms` (relative to recording start, plus the recording-start epoch in the job result) so step outcomes align with the audio timeline. Even with aligned legs making latency computable offline, timestamps are needed for **turn segmentation** (which rx span belongs to which eval turn → TSR judging) and validation.
2. **Scripted barge-in — add aeval's exact primitive: `audio.wait_for_speech_start {timeout_ms, wait_after_start_ms}`** ("block until agent speech onset, then a further delay"). This is how aeval scripts interrupts today (smoke-test Phase 2, `examples/interrupt/I00–I07`): after this step returns, an ordinary `audio.play` *is* the barge-in, because the agent is guaranteed mid-speech; the following `audio.wait_for_speech` captures the reaction. Mirroring the primitive (rather than inventing a fused `audio.interrupt`) keeps the eval-set → DialF compiler 1:1 — **existing interrupt eval sets compile to phone unchanged** — and it's cheap for DialF: onset detection already exists in its ten-vad path (`onset_duration_ms`); this step returns at onset+delay instead of trailing silence. The timeout covers the never-spoke edge case (turn yields no interrupt sample). Interrupt latency = barge-in play onset (tx leg / step timestamp) → agent speech stop (rx leg).
3. **Call metadata in the job result** — answer latency, end reason, SIM used. Mostly derivable from `call.wait_answered` + `call.list` today; folding it into `job.run`'s response saves a second round-trip and races.
4. *(nice-to-have)* **Job-level `max_duration_ms`** — currently enforceable client-side via the daemon's timeout + `job.cancel`; a native cap is cleaner.
5. *(future, not v1)* **`call.dtmf {digits}`** for IVR navigation in workflow session-establishment (§9), and **`sms.wait {from?, match?, timeout_ms}`** for OTP flows — `sms.list` exists but there is no blocking wait-for-SMS step.

**Not needed in DialF:** loops/corpus resolution (`control.for_each` — the Vox compiler unrolls to flat steps and resolves corpus files to host paths before `job.run`); metrics computation (offline `aeval analyze` owns it); any HTTP API (co-located Unix socket is the contract — one deployment note: a dockerized `vox-eval-agentd` needs the control socket and the corpus/recording dirs volume-mounted).

## 7. Analysis and metrics (D5)

- `aeval analyze` over DialF's outputs — `rx.wav`/`tx.wav` (or `mix.wav`) plus the per-step timing results (§6 gap 1) — must emit **the same `metrics.json` shape** as `aeval run` does today (flag shape TBD by aeval). This is the load-bearing compatibility requirement: the daemon's existing mapping (`turn_level[].latency_ms` medians/SDs, fallback chain, negative-latency filter, ≥2-sample SD rule) is reused byte-for-byte.
- **Response latency:** end of user speech (tx leg) → start of agent speech (rx leg), per turn. Separate mono legs make attribution deterministic — stronger than the web case (no echo ambiguity).
- **Interrupt latency:** scripted barge-in playback start (per-step timestamp, §6 gap 1/2) → agent speech stops on the rx leg. Only measurable because interrupts are scripted and their onsets logged — this is why per-step timestamps are a hard requirement on the DialF contract, not an optional extra.
- **TSR:** STT on the rx leg + the same judging pipeline as web.
- **Failure policy unchanged:** non-zero analyze exit, missing recording, or call-failed disposition → job failed, partial results never reported.

New result data (phone jobs only), stored in `evalResults.callMetadata` (jsonb): `{callId, disposition, answeredAfterMs, durationMs, fromRedacted, sim}`. Phone numbers stored redacted (last 4), consistent with the existing credential-hygiene posture. The recordings (`mix.wav` for playback; legs optionally) are artifacts (same artifact handling as today's outputs), linked from the result.

## 8. Dispatch and tiering (D6)

- Eval agent registration gains a capability declaration: `capabilities: ['phone']` plus the DialF number's country. Claim SQL for phone-transport jobs (read from the frozen snapshot) filters on it — a phone job is simply invisible to web-only agents. Mirrors the existing region filter, no new mechanism.
- **v1 restriction: phone jobs dispatch to owner-operated/private-tier agents only.** Marketplace phone agents raise questions the shared-tier attestation model doesn't yet answer (who pays PSTN minutes, caller-ID trust, whether a marketplace host can observe call audio). Defer exactly the way `credentialConsent` gated login secrets — a later attestation, not a v1 blocker.
- Metric classification (Mainline/Community/My Evals) is unchanged — **decided:** the transport does not affect classification. If the snapshot's workflow and eval set are mainline (and `tokenVisibility` public, creator plan principal/fellow), phone results publish to Mainline exactly like web results; `transport` is a dimension on the result, not a gate. This composes with the marketplace restriction above: admin-minted **public** agents are owner-operated (platform-run fleet), so Mainline phone results come from platform-operated phone agents; only third-party marketplace hosts are excluded in v1, which is orthogonal to the mainline gate.

## 9. Audio-quality caveat

PSTN is typically 8 kHz narrowband (G.711). Latency and TSR are robust to that; STT word-error and any naturalness scoring are not directly comparable with 48 kHz web captures. Implication: analysis presets get a phone variant (thresholds tuned for narrowband, STT model chosen for 8 kHz), and the UI labels results with the evaluation mode so nobody reads a cross-transport naturalness comparison as apples-to-apples. This is a preset + labeling concern, not a schema concern.

**Decision (was open question): v1 reuses existing eval sets as-is + the narrowband preset. No phone-specific eval sets.**

- **DTMF/IVR navigation is not eval-set content** — it is the phone analog of `platform.setup`: *how you reach the agent* ("press 2 for support…"), which is workflow territory (eval sets are the same, workflows are different). When it arrives, it arrives as `call.dtmf` / `call.wait_for_prompt` control-plane steps in the workflow's session-establishment section — the eval-set library never forks. (Evaluating an IVR *itself* — menu-traversal success — is a different evaluation objective, closer to a future `evalKind` than a convo eval set.)
- Phone-only eval-set vocabulary in v1 would create the first transport-locked eval set and drag in eval-set × transport compatibility validation on day one; universal eval sets keep that machinery out of v1.
- Corpus audio needs no fork: 48 kHz corpus files get codec-downsampled in the call — exactly what a real caller sounds like.
- Caveat: some `audio.wait_for_speech` silence/timeout parameters may need **transport-tuned defaults** (PSTN comfort noise and codec artifacts vs VAD thresholds calibrated on clean web audio). This lives in the media-plane compiler as per-transport defaults, not in eval-set edits.

## 10. Data model changes (summary)

| Change | Where |
|---|---|
| `transport` enum (`web`,`phone`) on `workflows`, default `web` | `shared/schema.ts` + hand-written migration (0038+, registered in `MIGRATIONS`) |
| `transport` frozen into `evalJobs.snapshot` | `buildJobSnapshot()` |
| `callMetadata` jsonb (nullable) on `evalResults` | schema + migration |
| `capabilities` on eval agent registration/heartbeat | `evalAgents` + claim SQL |
| Secret class `brokerType: 'restful'` | value only — column is free text; withholding logic extended |
| Workflow config: `phone` trigger section (browser steps or restful template) | workflow YAML, validated server-side |

No changes to: metric columns, the 3-tier endpoints' shape, eval-set schema, the snapshot immutability rule.

## 11. UI (D7)

- **Terminology:** the UI calls the compound "**Evaluation Mode**" — "Web vs Agent", "Phone vs Agent" (future "App vs Agent", "App vs App"). It is a presentation label derived from the normalized fields (§3); no schema column is named `mode`.
- **Mode badge** (Web vs Agent / Phone vs Agent) on workflow list, job list, results, provenance dialog. Distinct visual treatment, not just text.
- **Workflow creation:** Evaluation Mode selector up front. Phone branch asks how the call is established: "**Agent calls us — via web UI**" (reuses the existing browser-steps editor), "**Agent calls us — via REST API**" (method/URL/headers/body template + secret picker; brokered secrets shown with a shield badge, mirroring how login-class secrets are surfaced today), or "**We call the agent**" (target phone number field → `call.dial`).
- **Results:** identical TSR / Response Latency / Interrupt Latency cards. A phone-only panel adds: call disposition, answer time, duration, redacted numbers, and a stereo recording player with L/R channel labels.
- **Metrics pages:** web and phone are **separate data categories, never mixed in one view** (decided) — an Evaluation Mode switch selects the category; see the realtime design below.

### Realtime page (web + phone)

**Decided: no mixed view.** Web and phone results are different measurement categories (different transport physics, different audio band — §9); a combined chart or blended median invites exactly the cross-transport comparison the design forbids. Therefore:

- **Evaluation Mode is a top-level switch, not a filter:** a segmented control above the page — `Web vs Agent | Phone vs Agent` — selects the category. Everything below it (Mainline/Community tabs, time range, region scope, refresh, stat cards, charts) operates within the selected mode, **unchanged from today's implementation**. Default: Web vs Agent; the Phone segment shows a data-point count badge and an empty state ("No phone evaluations in this range") rather than being hidden, so the mode is discoverable.
- **No dual keying, no blended numbers:** chart series stay keyed by provider exactly as today — within one mode that's unambiguous. Stat cards keep their single values. Nothing on the page ever aggregates across modes.
- **Out of scope for this page:** call disposition, duration, recording playback — per-result detail on the job/result views (above). The realtime page's entire phone surface is the mode switch.
- **Plumbing:** `/api/metrics/realtime` (and community/my-evals) accept a `transport=` query parameter (default `web` for compatibility); rows carry `transport` read from the frozen snapshot. The client fetches one mode at a time — switching modes is a refetch, not a client-side filter.

## 12. Failure modes

| Failure | Handling |
|---|---|
| Brokered REST trigger fails (4xx/5xx/timeout) | Job fails **before** DialF engages; sanitized cause on the job error (same diagnosis pipeline as failed mints) |
| Trigger succeeded but no inbound call within `maxWaitForCallMs` (browser/restful path) | Job failed: `call never arrived`; trigger response attached as evidence |
| `call.dial` unanswered within `maxRingMs`, busy, or rejected (inbound-to-agent path) | Job failed with DialF's disposition (`no answer` / `busy` / `rejected`) |
| Line busy / call rejected / carrier error | Job failed with DialF's disposition |
| Mid-call drop | Job failed (partial results never reported — existing policy) |
| `aeval analyze` non-zero exit | Job failed (existing policy) |
| Timeout ordering | trigger timeout < DialF answer-wait < max call duration < daemon job poll — one clamped reader, same discipline as `shared/mint-timeout.ts` |

## 13. Future: App vs Agent

The model extends along two axes without rework. Within conversational evals, `transport` gains `'app'`; the transport-specific pieces are (1) a session-establishment namespace — `app.*` (launch/tap/fill/wait_for), **reserved in the Libretto spec** as the mobile sibling of `browser.*` — and (2) an audio transport. The likely engine path: **DialF's rig is already most of it** — the headset-jack/USB-sound-card bridge is app-agnostic (any app's audio yields the same `rx`/`tx` legs), the ten-vad `audio.*` engine is unchanged, and adb integration exists; the missing piece is third-party-app UI automation (adb/uiautomator), with an Appium/Maestro-class engine as the alternative if iOS or device farms become requirements. Beyond convo, a future **RTC eval** hangs off the already-existing kind axis — providers with `sku: rtc` (`provider_sku` enum, in production today) — with its own metrics and an endpoint-*pair* config (app vs app, app vs web, web vs web) that reuses the same transport vocabulary (§3 naming rationale). No schema groundwork needed beyond what exists. Eval sets, `metrics.json`, `evalResults`, and the UI result presentation are already transport-neutral by construction. Nothing in this design stores or branches on "is this a browser" outside the trigger step executor and the transport adapter.

## 14. Libretto — the unified action vocabulary (D8)

> **Promoted to a standalone protocol** (decided): **Libretto** — a *generic, portable action-script protocol*, not an evaluation format. Full step-level detail lives in `2026-09-21-unified-action-vocabulary-spec.md` (draft v0.1), which seeds the **`Agora-Build/libretto`** repo. Evaluation is Libretto's first consumer: Vox compiles eval sets into Libretto scripts and computes metrics offline from the outcomes/recordings the protocol mandates; other consumers (synthetic monitoring, IVR regression, OTP automation) need no spec changes. Governance: the spec is owned in the `libretto` repo; majors require aeval + DialF + Vox maintainer sign-off; minors merge on standard review. This section keeps the design-level rationale — the spec is normative where they differ.

The final namespace set (spec §4):

```
control.*   — wait / log / for_each (for_each is compile-time unrolled)   (orchestrator)
browser.*   — goto / wait_for / click / fill                              (engine: aeval)
audio.*     — play / wait_for_speech / wait_for_speech_start              (engines: aeval AND DialF — the shared core)
call.*      — dial / wait_answered / answer / hangup (+ dtmf reserved)    (engine: DialF)
sms.*       — send (+ wait reserved for OTP flows)                        (engine: DialF)
app.*       — launch / tap / fill / wait_for (RESERVED — App vs Agent)    (engine: TBD; DialF rig is the leading candidate, §13)
restful.*   — request; routed direct or brokered by the secret's class    (orchestrator, or REST broker)
```

Deliberately **excluded from the protocol**: aeval's `platform.setup`/`platform.enter` (engine-owned composite presets over `browser.*`) and `audio.start_recording` (recording is a normative engine obligation for the whole session block — never a script step; t=0 = recording start).

End users author Libretto scripts; Vox dispatches each namespace to the right executor. This replaces the current de-facto contract (raw aeval scenario YAML passthrough).

**Why:** the namespace becomes the unit of everything Vox already needs to reason about — agent capability declaration and claim gating, security class (`restful.*` brokered; `call.*`/`sms.*` cost money and consume numbers), and authoring-time validation. Executors become swappable: an aeval format change becomes a compiler update in Vox, not a breaking change to user eval sets. New capabilities arrive as vocabulary, not architecture — `sms.*` buys OTP retrieval in login flows; `call.dial` unlocks testing *inbound* agents with no trigger step at all; `app.*` is one namespace away, not a new system.

**Structural requirements (normative detail in the spec):**

1. **Execution classes + the session-block rule** (spec §3): `media` steps (`audio.*`) are millisecond-sensitive and MUST run inside a session engine's real-time loop — the compiler hands a maximal contiguous session block to one engine whole, never interpreting it over IPC (this generalizes the D4 turn manifest). `session-ctl` (`call.*`, `browser.*`) executes in the owning engine; `orchestrated` (`control.*`, `sms.*`, direct `restful.*`) runs between blocks in the orchestrator — or inside a block only where the engine's manifest declares native support (DialF: `sms.send`, `control.wait`, `control.log` in-call); `brokered` (`restful.*` with a broker-class secret) runs only in the trusted broker.
2. **Spec, not language.** Flat, declarative, versioned (`spec_version` per script); `control.for_each` is the ceiling for flow control. Validation at authoring time (Vox server-side, surfaced in the UI) and again pre-dispatch. Executors declare implemented steps + spec version in a **manifest** (capability negotiation, no silent partial support); conformance profiles: `convo-web` (aeval), `convo-phone` (DialF — reached by landing R1/R2/R3), `orchestrator` (vox-eval-agentd), `trusted-rest` (REST broker), future `convo-app`.

**Cost acknowledged:** a translation layer per executor (Libretto → aeval YAML, → DialF job) that doesn't exist today. v1 keeps both compilers nearly 1:1 — DialF's **native job vocabulary already matches the protocol** (`call.dial/wait_answered/answer/hangup`, `audio.play`, `audio.wait_for_speech`, `sms.send`; §6), and aeval's scenario steps are already spec-shaped. Libretto is consolidation of two convergent implementations, not green-field invention. Divergence accumulates behind the compilers instead of in user scripts.

## 15. Open questions (need your input)

1. ~~**DialF contract**~~ — **LARGELY RESOLVED** after reviewing `Agora-Build/DialF` (§6 rewritten against the real interfaces: `dialfd` Unix-socket control API, `autoanswer.serve` for inbound arm, `job.run` for outbound + conversation, `rx`/`tx`/`mix` recordings with the L=user/R=agent layout already the default). **Three concrete asks remain for the DialF owners:**
   a. **Step timestamps** (`t_start_ms`/`t_end_ms` on `StepOutcome` + recording-start epoch) — needed for turn segmentation/TSR and validation (§6 gap 1);
   b. **`audio.wait_for_speech_start {timeout_ms, wait_after_start_ms}`** — aeval's barge-in primitive, mirrored into DialF; the one real turn-engine gap, and without it interrupt latency is unmeasurable (§6 gap 2);
   c. **Call metadata in `job.run`'s result** + confirm the `tx`/`rx` legs are timeline-aligned (if so, response latency is computable fully offline) (§6 gaps 1/3). Job-duration cap and `call.dtmf`/`sms.wait` are nice-to-have/future (§6 gaps 4/5).
2. ~~**D4 — turn engine ownership**~~ — **RESOLVED (user decision): DialF drives the phone conversation**; metrics come from offline `aeval analyze` over DialF's recordings + step timings (§6). DialF already ships the ten-vad turn engine with aeval-compatible step semantics; drift is managed by the shared eval-set→DialF-job compiler, not a shared runtime. aeval needs no phone `audio_io` mode.
3. ~~**Trusted REST egress**~~ — **RESOLVED (user decision): broker-based from day one**, routed by the secret's `brokerType: 'restful'`, deployed as an independent broker on the existing registry. No fixed-egress-IP requirement today (standard deployment); future isolated-network/fixed-IP needs are met by deploying the broker into those networks — no code change. Core-direct rejected to keep SSRF risk off Core (§5).
4. ~~**Telephony provisioning**~~ — **RESOLVED by DialF's architecture:** no SIP trunk/DID — a phone-capable host needs an Android 9+ phone with a SIM, the DialF Phone APK, a USB sound-card bridge, and `dialfd` (§6). Per-host, operator-managed; matches the co-located v1 topology and the §8 owner-operated restriction.
5. ~~**Scope check on `restful.*`**~~ — **RESOLVED:** transport-agnostic; any eval that needs a REST API call can use it (§5).
6. ~~**Mainline policy**~~ — **RESOLVED:** transport-neutral classification. Mainline workflow + mainline eval set ⇒ results publish to Mainline regardless of transport; web vs phone is a labeled dimension (§8, §11).
7. ~~**Narrowband presets (§9)**~~ — **RESOLVED:** v1 reuses existing eval sets as-is with the narrowband preset; DTMF/IVR belongs in the workflow's session-establishment steps, not eval sets (§9).

---

*Draft for discussion — no schema, code, or migration changes made.*
