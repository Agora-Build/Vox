# Phone vs Agent — Phase C (DialF Integration) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `vox-eval-agentd` executes phone-transport jobs by delegating the call to DialF (≥ v0.3.8, verified released with R1/R2/R3), running offline analysis over its recordings, and reporting metrics + callMetadata — with the `phone` capability advertised only while a healthy DialF with a connected phone is present.

**Architecture (design §6, DialF `docs/INTEGRATION.md` as the contract):**
- **`dialf-client.ts`** — Unix-socket line-JSON client: socket resolution (config → per-user → system), one-shot `call(op)`, sequential-per-connection semantics respected, `probe()` = `server.info` (ten_vad ≠ "stub") + `server.manifest` (spec 0.1 + required steps) + `devices.list` (≥1 phone). Probe result drives the `capabilities: ["phone"]` field on register/heartbeat (self-healing per Phase A).
- **`phone-eval.ts`** — pure compiler + adapters: eval-set scenario steps → flat DialF job steps (unroll `control.for_each`, resolve `corpus_id` → absolute wav path, pass `audio.wait_for_speech(_start)` params, reject `platform.*`/`browser.*` in the conversation, stamp step `id`s); DialF result → aeval-style session dir (recordings + `dialf/steps.json` + `dialf/call.json`); `call` → `callMetadata` mapping.
- **Daemon wiring** — `executeJob` branches on `job.transport === "phone"` → `executePhoneJob`: outbound mode (workflow config `phoneDial.number` → `job.run` starting `call.dial`/`call.wait_answered`); trigger mode (config `restfulTrigger` → arm `autoanswer.serve` with a written job file on a dedicated connection, then `POST /api/eval-agent/jobs/:id/restful` with `variables.phoneNumber`, await the serve event); then `aeval analyze <sessionDir>` → existing `tryParseMetricsJson` mapping → `completeJob(results + callMetadata)`. Non-zero analyze / failed call disposition → `failJob` (partial results never reported).
- **One job at a time** is already the daemon's model; DialF's sound-card lock and single serve session align — no new concurrency machinery.

**External-facts basis (verified this session):** DialF v0.3.8 released 2026-09-21 with the Libretto convo-phone conformance commit (step envelope `id/type/t_start_ms/t_end_ms/end_reason` on the **recording clock**, `audio.wait_for_speech_start` hop-based, call metadata in `job.run` result, `control.*` aliases, `server.manifest`); `aeval analyze <session_dir>` exists in the pinned aeval. Whether analyze accepts the DialF-constructed session layout end-to-end is the one remaining external item — the daemon treats a non-zero analyze exit as job failure (existing policy), and all tests stub the analyze invocation.

## Global Constraints

- All DialF interaction via the documented socket contract; **never** parse `autoanswer.serve` event strings for data (human-only per the contract) — outcomes come from `job.run` results / result files.
- Absolute paths in every DialF step `file` (inline steps have no job-file directory).
- Read timeout for a blocking `job.run` = sum of the job's own step timeouts + 60s slack, not a default.
- Phone capability must drop on the next heartbeat when DialF/phone disappears (Phase A semantics: send `capabilities: []`).
- Tests: fake `dialfd` (node `net` Unix-socket server) + injected exec for analyze; no Docker/hardware in the gate.
- Branch `feat/dialf-integration-phase-c`; signature convention; PR without merge.

## Tasks

### Task 1: `vox_eval_agentd/dialf-client.ts` + probe
Socket resolution order from INTEGRATION §2 (config `control_socket` → `$XDG_RUNTIME_DIR/dialfd.sock` / `/tmp/dialfd-<uid>.sock` → system path), `DialfClient` (connect, `call(op, fields)` matching terminal frames per §3/§4 including the `id:""` unparseable case), `probeDialf()` returning `{ ok, phoneNumber?, version }` — manifest check requires `spec_version: "0.1"` and steps `call.dial, call.wait_answered, call.answer, call.hangup, audio.play, audio.wait_for_speech, audio.wait_for_speech_start`; ten_vad ≠ "stub"; ≥1 device. `phoneNumber` from env `VOX_PHONE_NUMBER` (SIM numbers are commonly absent from `sims.list` — env is the reliable source, documented).
**Tests** (`tests/dialf-client.test.ts`): fake dialfd over a temp Unix socket — resolution order, one-shot call, ok:false as error not disconnect, probe pass/fail matrix (stub VAD, missing step, no devices).

### Task 2: `phone-eval.ts` compiler + adapters (pure)
`compilePhoneConversation(scenarioSteps, opts { corpusDir })` → DialF steps or `{error}` (web-only steps rejected; `for_each` unrolled; `corpus_id`→`${corpusDir}/<id>.wav` absolute; ids stamped `s<n>`); `sumStepTimeouts(steps)` for the read timeout; `buildSessionDir(dialfResult, destDir)` writes `recordings/` links/copies + `dialf/steps.json` + `dialf/call.json`; `toCallMetadata(call)` → `{disposition: end_reason, answeredAfterMs: answer_latency_ms, durationMs: duration_ms, sim, fromRedacted: last4(remote_number)}`.
**Tests** (`tests/phone-eval.test.ts`): compile matrix incl. rejection + unroll + interrupt steps; timeout summation; callMetadata mapping incl. number redaction.

### Task 3: daemon wiring
`register`/`sendHeartbeat`: probe (cached ~30s) → `capabilities: ["phone"]` or `[]`. `executeJob`: `transport === "phone"` → `executePhoneJob(job, deps)` with injectable `{ dialf, analyze, coreFetch }`: outbound via `phoneDial.number`; trigger mode arms serve (job YAML written to temp, dedicated connection, disconnect = disarm) then calls the Phase B restful endpoint with `variables.phoneNumber`; failed trigger (`ok:false`/non-2xx) → failJob BEFORE any call (escrow-refund ordering); result → session dir → `analyze` → parse → completeJob with callMetadata; DialF `end_reason` ≠ completed on the call → failJob with the disposition.
**Tests**: extend `tests/phone-eval.test.ts` with an `executePhoneJob` happy-path + trigger-fail-first + bad-disposition using fake dialfd + stub analyze + stub core fetch.

### Task 4: config + validation + docs
`validateWorkflowConfig` accepts `phoneDial: { number: string }` (E.164-ish check) — mutually exclusive with `restfulTrigger`? No: **exactly one of them is required for phone-transport workflows at run time**, both may be absent on web workflows; the run route rejects a phone-transport run whose workflow config has neither (`400 "phone workflow needs phoneDial or restfulTrigger"`). CLAUDE.md: Eval Agent Daemon section — DialF prerequisites (dialfd ≥ 0.3.8, per-user service, `VOX_PHONE_NUMBER`), capability behavior, one-call-at-a-time note.
**Tests**: config validation cases + run-route rejection (HTTP).

### Task 5: gate + PR
`npm run check`; clean DB; full `npm test`; `./scripts/full-tests-run.sh` (background, tee); classify failures against the known set; push branch; PR (no merge). Docker: daemon image needs no new deps (socket client is Node builtins) — no Dockerfile change expected; verify by grep that no new imports leak into the daemon bundle beyond builtins.

## Self-review notes
- The inbound/trigger flow's structured result: v1 takes it from the `job.run`-equivalent result the serve job produces on disk only if DialF writes one — **the contract says read recordings keyed by label**; v1 SCOPES the trigger mode to arm + trigger + wait-for-serve-event + then locate `recording` files by label prefix and steps via the daemon log? NO — too fragile. **v1 decision: trigger mode requires DialF's serve flow only to hold the call; the conversation runs as the SERVE JOB — outcomes come from the recording dir result file if present, else the run is completed with recordings-only analysis (no step outcomes → analyze computes from wavs alone; interrupt metrics may be absent).** Flag in PR as the one soft edge; outbound mode is fully structured.
- Everything else consumes verified v0.3.8 contract fields.
