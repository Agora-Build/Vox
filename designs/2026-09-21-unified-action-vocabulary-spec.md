# Libretto — A Portable Action-Script Protocol, Draft Spec v0.1

**Status: DRAFT** — seed document for the standalone repo **`Agora-Build/libretto`** (npm `@agora-build/libretto`) — name decided 2026-09-21.
Date: 2026-09-21 · Origin: Vox Phone-vs-Agent design (`2026-09-21-phone-vs-agent-design.md`, §14).

**Scope: this is a generic script protocol, not an evaluation format.** It defines declarative scripts that drive real-world interactions — browser sessions, phone calls, SMS, HTTP, scripted audio conversation — executed by heterogeneous engines. **Evaluation is the first consumer, not part of the protocol:** Vox compiles eval sets into scripts and computes metrics offline from the outcomes and recordings the protocol mandates. Other consumers (synthetic monitoring, IVR regression, call-center QA, OTP-flow automation) use the same scripts and engines with no spec changes; anything metric- or judgment-related is a consumer concern.

**First implementers:** aeval (web/browser engine), DialF (phone engine), `vox-eval-agentd` (orchestrator), Vox REST broker (trusted `restful.*`). Each implements the subset matching its capabilities and declares it in a manifest (§7). The vocabulary is a consolidation of two already-convergent implementations (aeval scenario steps and DialF job steps), not a green-field invention.

---

## 1. Concepts

| Term | Meaning |
|---|---|
| **Script** | An ordered list of steps (YAML), plus `spec_version` and optional `params`. Flat and declarative — not a programming language. |
| **Step** | One action: `type` (namespaced, `snake_case` after the dot) + typed fields + optional `id`, `description`. |
| **Executor** | A component that runs steps: a **session engine** (aeval, DialF) owning a real-time session, or the **orchestrator** (`vox-eval-agentd`) / **trusted broker** for out-of-session steps. |
| **Session block** | A maximal contiguous run of steps bound to one session engine (e.g. all `call.*`+`audio.*` of one phone call). Compiled and handed to that engine **whole** — never interpreted step-by-step over IPC. |
| **Manifest** | An executor's machine-readable declaration of the steps + spec version it implements (§7). |

## 2. Conventions

- All step types are `namespace.verb`. All durations are integers in **milliseconds**, field names end in `_ms`.
- Envelope fields on every step: `type` (required), `id` (optional, unique in script — referenced by outcomes and analysis), `description` (optional, logged).
- Unknown step type or field at validation time = **hard error** (no silent skip). Executors never receive steps they didn't declare.
- Timeout fields always have spec-defined defaults so scripts stay terse.

## 3. Execution classes

Every step has a class, fixed by this spec:

- **`media`** — millisecond-sensitive; MUST execute inside a session engine's real-time loop (all `audio.*`).
- **`session-ctl`** — call/session lifecycle; executes in the engine owning the session (`call.*`, `browser.*`).
- **`orchestrated`** — seconds-tolerant; may execute in the orchestrator or engine (`control.*`, `sms.*`, `restful.*` direct).
- **`brokered`** — executes only in a trusted environment, routed by secret class (`restful.*` with a broker-class secret).

**Block rule:** within a session block, only steps the owning engine declares may appear (validated pre-run). `orchestrated` steps between session blocks run in the orchestrator. An engine MAY natively support some orchestrated steps inside its blocks (DialF supports `sms.send`, `control.wait`, `control.log` in-call); the manifest says so.

## 4. Namespaces and steps

### 4.1 `control.*` — flow & utility (class: orchestrated)

| Step | Fields (defaults) | Semantics |
|---|---|---|
| `control.wait` | `ms` | Sleep. *(DialF today: bare `wait` — alias, §10.)* |
| `control.log` | `message` | Emit a log line into the run record. *(DialF today: bare `log`.)* |
| `control.for_each` | `items` (inline list) \| `corpus_set` (named set); `steps` | Repeat `steps` per item; `${item}` / `${item.<key>}` available inside. **Compilers unroll this before dispatch** — session engines never see it. The only flow construct; no conditionals, no expressions. |

### 4.2 `browser.*` — browser automation (class: session-ctl; engine: aeval)

Canonical forms for what aeval app-configs do today with `action:` entries (mapping in §10):

| Step | Fields (defaults) | Semantics |
|---|---|---|
| `browser.goto` | `url` | Navigate the session page. |
| `browser.wait_for` | `selector`, `timeout_ms` (30000) | Wait for element (CSS or `xpath//` prefix). |
| `browser.click` | `selector` | Click element. |
| `browser.fill` | `selector`, `value` | Type into element. `value` may template `${phone.number}` / `${secrets.*}` (runtime-class only). |

### 4.3 `audio.*` — conversation media (class: media; engines: aeval **and** DialF)

The shared core — identical semantics over WebRTC capture and PSTN capture:

| Step | Fields (defaults) | Semantics |
|---|---|---|
| `audio.play` | `file` \| `corpus_id` | Play user audio into the session. Blocks until playback ends. `corpus_id` is resolved to a file by the compiler. |
| `audio.wait_for_speech` | `end_timeout_ms` (45000), `silence_duration_ms` (3000), `onset_duration_ms` (100) | Block until the far end speaks and then falls silent for `silence_duration_ms` (VAD; onset debounce `onset_duration_ms`). Outcome carries `end_reason: completed\|timeout`. |
| `audio.wait_for_speech_start` | `timeout_ms` (15000), `wait_after_start_ms` (2000) | Block until far-end speech **onset**, then a further `wait_after_start_ms`, returning **while the far end still speaks** — the next `audio.play` is thereby a barge-in. Timeout is **non-fatal**: `end_reason: timeout`, job continues (turn yields no interrupt sample). *(aeval: exists. DialF: requested — R2.)* |

### 4.4 `call.*` — PSTN call control (class: session-ctl; engine: DialF)

| Step | Fields (defaults) | Semantics |
|---|---|---|
| `call.dial` | `number`, `sim` (default SIM) | Place an outbound call. `number` may template `${phone.target}` from workflow config. |
| `call.wait_answered` | `timeout_ms` (30000) | Block until active; timeout → job fails with `no_answer`. |
| `call.answer` | — | Answer the ringing call. (In auto-answer/arm mode the engine answers itself; call-setup steps are skipped with a warning — existing DialF behavior.) |
| `call.hangup` | — | End the call. |
| `call.dtmf` | `digits`, `inter_digit_ms` (120) | **Reserved (future):** send DTMF — IVR navigation in session establishment. |

### 4.5 `sms.*` — SMS (class: orchestrated; engine: DialF or SMS gateway)

| Step | Fields (defaults) | Semantics |
|---|---|---|
| `sms.send` | `to`, `body` | Send a text from the endpoint's number. |
| `sms.wait` | `from?`, `match?` (regex), `timeout_ms` (60000) | **Reserved (future):** block until a matching SMS arrives; outcome carries the message (enables OTP retrieval). |

### 4.6 `app.*` — native-app automation (class: session-ctl; **RESERVED, future**)

The mobile sibling of `browser.*`: drive a real Android/iOS app to establish a conversation session (launch, log in, start the call/chat), after which the shared `audio.*` steps carry the conversation. Candidate steps (outline only — finalized when implementation starts):

| Step | Fields (sketch) | Semantics |
|---|---|---|
| `app.launch` | `package` \| `bundle_id` | Launch (and foreground) the target app. |
| `app.wait_for` | `selector`, `timeout_ms` | Wait for a UI element (accessibility-id / text / resource-id). |
| `app.tap` | `selector` | Tap an element. |
| `app.fill` | `selector`, `value` | Type into an element (templating rules of §5 apply). |
| `app.stop` | — | Terminate the app / end the session. |

Engine candidates: **DialF is most of the engine already** — its headset-jack/USB-sound-card audio bridge is app-agnostic (the phone routes any app's audio to the wired headset, so the same rig yields the same `rx`/`tx` legs for a VoIP app as for a PSTN call), its ten-vad `audio.*` engine is unchanged, and it already integrates adb (`devices share`); the missing capability is third-party-app UI automation (adb/uiautomator). Alternative: a dedicated Appium/Maestro-class engine, likelier if iOS (no adb, stricter audio routing) or device farms become requirements. Either way the engine declares `app.*` + `audio.*` in its manifest and satisfies the `convo-app` profile (§8) — nothing else in the spec moves.

### 4.7 `restful.*` — HTTP (class: orchestrated **or** brokered)

| Step | Fields (defaults) | Semantics |
|---|---|---|
| `restful.request` | `method`, `url`, `headers?`, `body?`, `expect_status` ([200–299]), `timeout_ms` (30000) | Execute an HTTP request. **Routing is decided by the referenced secrets' class**, not by the script: no secret / runtime-class → orchestrator executes directly; broker-class secret (`brokerType: 'restful'`) → the request template is resolved server-side from the frozen job snapshot and executed by the trusted REST broker; the script author writes the same step either way. Outcome carries `status` + a sanitized response projection — never raw bodies when brokered. |

Transport-agnostic: valid in web evals (data seeding, cleanup) and phone evals (call triggering) alike.

## 5. Variables & templating

`${...}` interpolation, resolved by the **compiler/orchestrator** before an engine sees the step — engines receive literals:

| Variable | Source | Notes |
|---|---|---|
| `${secrets.NAME}` | Secret store | Runtime-class only in agent-visible steps. **Broker-class secrets never interpolate client-side** — a script placing one outside a brokered `restful.request` fails validation. |
| `${phone.number}` | The controlled endpoint's own number | Injected into `browser.fill` / `restful.request` ("call me at…"). |
| `${phone.target}` | Workflow config | The number `call.dial` calls. |
| `${item}`, `${item.<key>}` | `control.for_each` | Compile-time unrolled. |
| `${params.<key>}` | Script `params` | Static configuration. |

## 6. Outcomes, recordings, results

**Per-step outcome** (every executor, every step):

```jsonc
{ "index": 3, "id": "rsp-001-answer", "type": "audio.wait_for_speech",
  "t_start_ms": 12340, "t_end_ms": 19870,        // relative to session recording start
  "end_reason": "completed",                      // completed | timeout | skipped | cancelled | call_ended | error
  "summary": "speech 4.1s then 3.0s silence" }
```

`t_*_ms` are REQUIRED for `media` and `session-ctl` steps (DialF: R1). Steps after an aborting event are reported `skipped` (existing DialF behavior, adopted spec-wide).

**Recording is an engine obligation, not a step** (normative): a session engine MUST capture both legs for the entire session block — there is no `start_recording` step a script could forget or misplace. `t=0` of the outcome timeline is recording start = session block start.

**Session result envelope:** step outcomes + `recording` + session metadata. Recording convention: per-direction legs `tx` (simulated user, as played) and `rx` (far end), timeline-aligned to `t=0` = recording start, plus optional `mix` (stereo, **left = tx/user, right = rx/agent**). Phone sessions add `call` metadata `{answer_latency_ms, duration_ms, end_reason, sim, remote_number}` (DialF: R3).

**Failure policy (normative):** a failed step (other than non-fatal timeouts defined above) fails the session; the engine still returns all outcomes and recordings produced up to the failure, marked as a failed session. What to do with partial output is a **consumer** decision (Vox's policy: discard — no partial metrics are ever reported).

## 7. Capability manifests & validation

Each executor ships a manifest:

```jsonc
{ "executor": "dialf", "spec_version": "0.1",
  "steps": ["call.dial", "call.wait_answered", "call.answer", "call.hangup",
            "audio.play", "audio.wait_for_speech", "audio.wait_for_speech_start",
            "sms.send", "control.wait", "control.log"],
  "inline_orchestrated": ["sms.send", "control.wait", "control.log"],   // allowed inside its session blocks
  "extensions": [] }
```

Validation happens **at authoring time** (Vox server-side, surfaced in the UI) and again pre-dispatch: unknown steps, steps outside the target engine's manifest inside a session block, broker-class secrets in agent-visible positions, and `media` steps outside any session block are all rejected before anything runs.

## 8. Conformance profiles

| Profile | Required steps | Reference implementation |
|---|---|---|
| **convo-web** | `browser.*`, `audio.*` (all three) | aeval |
| **convo-phone** | `call.dial/wait_answered/answer/hangup`, `audio.play/wait_for_speech/wait_for_speech_start` | DialF (pending R1/R2/R3) |
| **orchestrator** | `control.*`, `restful.request` (direct), compile/unroll, validation | `vox-eval-agentd` |
| **trusted-rest** | `restful.request` (brokered execution + sanitization) | Vox REST broker |

A future **convo-app** profile needs only: implement `audio.*` + the reserved `app.*` namespace (§4.6). The `audio.*` core and everything downstream stay untouched — that is the point of the spec.

## 9. Versioning & extensions

- Scripts declare `spec_version` (this document: `0.1`). Executors reject majors they don't support.
- Additive changes (new steps, new optional fields) bump minor; semantics changes bump major. Field removal requires a major + deprecation cycle.
- Vendor extensions use `x-<vendor>.` prefixed types, declared in the manifest, ignored by conformance tooling.

## 10. Migration from current formats

| Today | Spec form |
|---|---|
| DialF `wait {ms}` / `log {message}` | `control.wait` / `control.log` (engines SHOULD accept both during 0.x) |
| aeval app-config `action: wait/click/sleep` + `url:` | `browser.wait_for` / `browser.click` / `control.wait` / `browser.goto` |
| aeval legacy `action: speak / wait_for_voice / wait_for_silence` | `audio.play` / `audio.wait_for_speech` (compiler shim) |
| aeval `type:`-style scenario steps | Already spec-shaped — adopt field defaults above |
| aeval `platform.setup` / `platform.enter` | **Not part of this spec** — engine-owned composite presets (bundles of `browser.*` behavior for known platforms). aeval keeps them native (or exposes as `x-aeval.*`); scripts using them target aeval by definition. |
| aeval `audio.start_recording` | **Not part of this spec** — recording is a normative engine obligation for the whole session block (§6), never a script step. aeval keeps its native step, invoked from its session-establishment presets (or by the compiler shim) until it becomes implicit; DialF already records unconditionally. |
| DialF job YAML | Already spec-shaped for its namespaces; add `id` passthrough + outcome timing (R1) |

Compilers (Vox-side) own these shims; engines converge on the canonical forms at their own pace behind their manifests.

## 11. Repo & governance (decided) + open items

**Repo: `Agora-Build/libretto`. Governance:** the spec is owned in the standalone repo, not by any implementer. **Major** versions (semantics changes, field/step removal) require review sign-off from the aeval, DialF, and Vox maintainers; **minor** versions (new steps, new optional fields — purely additive) merge on standard repo review. Engines track the spec at their own pace behind their manifests (§7/§9); an engine advertising `spec_version` it doesn't fully honor for its declared steps is a conformance bug, caught by the conformance suite (open item 1 below).

Open items:
1. Conformance test suite: golden scripts per profile + expected outcome shapes (DialF's BlackHole mode and aeval's local mode make both engines CI-testable without carrier/network costs).
2. JSON Schema for scripts + manifests (machine validation shared by all implementers).
3. `restful.poll`, `sms.wait`, `call.dtmf`, and the `app.*` namespace finalization (currently reserved).
