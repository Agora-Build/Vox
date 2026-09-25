# Unified Steps Model Implementation Plan (PR 2 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Setup Steps / Teardown Steps become the universal evalflow shape for every Evaluation Mode; phone specifics dissolve into Libretto steps; `phoneDial`/`restfulTrigger` config keys are deleted (clean cut, approved).

**Spec:** `designs/2026-09-25-unified-workflow-steps-design.md` §1–7 (§8 rename shipped as PR #175). Branch `feat/unified-steps`; merge only on the user's mark.

## Global Constraints

- Web path behavior is UNCHANGED — `platform.*`/`audio.*` pass through to aeval exactly as today; the only web-visible change is save-time vocabulary validation.
- Frozen historical snapshots are NOT rewritten (provenance content). Only live `evalflows.config` rows migrate. A pre-deploy PENDING phone job (snapshot carries `phoneDial`) would fail post-deploy — acceptable, none expected; noted for the deploy.
- The restful TOCTOU guarantee is preserved: Core resolves the `restful.request` step out of the frozen snapshot's `stepsPrefix` by index; the caller supplies only `variables.phoneNumber`.
- Every commit typechecks (`npm run check` = both tsconfig projects); full gate before PR.

## Task 1: Server — transport-aware steps validation, clean-cut keys, run gate, restful endpoint

**Files:** `server/storage.ts` (validateEvalflowConfig, validateRestfulTrigger reuse), `server/routes.ts` (create/PATCH evalflow callers, phone run gate ~4630, restful endpoint ~4531), `shared/schema.ts` (RestfulTrigger type stays — it is now the shape of a `restful.request` step's fields).

- [ ] `validateEvalflowConfig(config, transport)`:
  - REJECT `phoneDial` / `restfulTrigger` keys with pointer errors ("phoneDial was replaced by a call.dial step in Setup Steps (stepsPrefix)"; likewise restfulTrigger → a restful.request step).
  - Parse `stepsPrefix`/`stepsSuffix` as YAML step lists (when parseable; a non-list/未-YAML string is rejected with the YAML error). Vocabulary per transport:
    - phone: `call.*` (dial/wait_answered/answer/hangup), `audio.*` (play/wait_for_speech/wait_for_speech_start/start_recording/stop_recording — recording steps dropped at compile, legal to write), `restful.request`, `control.*`, bare `wait`/`log`, `lab.trace`. `platform.*`/`browser.*` rejected.
    - web: `platform.*`, `browser.*`, `audio.*`, `control.*`, bare `wait`/`log`, `lab.trace`. `call.*`/`restful.*`/`sms.*` rejected.
  - `restful.request` step fields validated by the existing `validateRestfulTrigger` shape (method/url/headers/body/expectStatus/timeoutMs — `type` key allowed on top); `call.dial` requires a `number` matching the old phoneDial regex.
- [ ] Both evalflow create + PATCH routes pass the RESULTING transport (PATCH may change transport and config together — validate against the post-patch pair; also re-validate steps when only transport changes).
- [ ] Phone run gate (run route + scheduler tick if it re-checks): Setup steps must contain a call-establishment step — `call.dial`, or a trigger (`restful.request`/`browser.*`). No `call.dial` + trigger present → 400 naming the R7 gap ("agent-outbound trigger mode pending DialF R7"). Neither → 400 "phone evalflow Setup Steps establish no call (add call.dial)".
- [ ] Restful endpoint `POST /api/eval-agent/jobs/:jobId/restful`: body gains `stepIndex`; Core parses the FROZEN `snapshot.evalflow.config.stepsPrefix` YAML, takes `steps[stepIndex]`, requires `type === 'restful.request'`, shape-validates, strips `type`, then resolves/dispatches exactly as today. `config.restfulTrigger` read deleted.
- [ ] Tests: `tests/phone-transport.test.ts` (gate messages), `tests/restful-broker.test.ts` (stepIndex contract, wrong-index/wrong-type 400s), `tests/storage.test.ts`/validation cases (vocabulary accept/reject per transport, key rejection).

## Task 2: Daemon — Libretto splitter, extended compiler, enforced hangup, safety net

**Files:** `vox_eval_agentd/phone-eval.ts`, `vox_eval_agentd/vox-agentd.ts`, `tests/phone-eval.test.ts`.

- [ ] Extend `compilePhoneConversation` vocabulary with `call.dial` (requires `number`), `call.wait_answered` (default `timeout_ms` = answer default), `call.answer`, `call.hangup` — pass-through steps with generated ids.
- [ ] New `splitPhoneScript(prefix, conversation, suffix)` (all parsed step arrays): full sequence = prefix ++ conversation ++ suffix. Leading `restful.request` steps (Setup only, before any `call.*`) split off as orchestrated pre-call actions, each carrying its ABSOLUTE index within `stepsPrefix` (the Core endpoint addresses by that index); a `restful.request` after the session block starts is a compile error (session-block rule). Remainder compiles as one contiguous DialF session block.
- [ ] Enforced hangup: if the compiled session block doesn't END with `call.hangup`, append one (`id: 'bye'`). (The teardown may legitimately place it earlier followed by `log` — only guarantee presence at the end when absent.)
- [ ] Delete `buildInboundJob`. `runPhoneJob` cfg: `prefixSteps`/`suffixSteps` (parsed YAML arrays, may be empty) replace `phoneDial`/`hasRestfulTrigger`. Gates inside: session block must contain `call.dial` (else: R7 error when a trigger step exists, "Setup establishes no call" otherwise — mirrors the server gate for orphaned/legacy jobs).
- [ ] Pre-call: execute the split-off `restful.request` steps in order via new dep `executeRestful(stepIndex)` — non-ok result fails the job before any dial.
- [ ] Safety net: when `job.run` throws (timeout, transport error) or returns a non-`completed` disposition, best-effort `job.cancel` then `call.hangup` over the same control connection (short timeouts, all errors swallowed) so a script/daemon failure never leaves a carrier call off-hook. On success the script's own (or enforced) hangup already ran — no extra op.
- [ ] `executePhoneJob`: parse `config.stepsPrefix`/`stepsSuffix` YAML (absent ⇒ empty lists), keep scenario parse; provide `executeRestful` dep = POST Core `/api/eval-agent/jobs/:id/restful` with `{leaseId, stepIndex, variables: {phoneNumber: probe.phoneNumber}}`.
- [ ] Tests: splitter partitioning (restful prefix + session block + absolute indices), hangup enforcement (absent/present/mid-teardown), R7 + no-call gates, safety-net hangup on job.run failure AND on non-completed disposition, pass-through of call.* steps, unchanged conversation compile.

## Task 3: Client — identical dialogs, per-mode placeholders

**Files:** `client/src/pages/console-evalflows.tsx`, `tests/e2e/phone-ui.spec.ts`.

- [ ] Delete `phoneNumber`/`editPhoneNumber` state + inputs + `config.phoneDial` writes (create ~148–153/172, edit ~196–206/284, JSX ~399–407/~590–598).
- [ ] Steps textareas show for `framework === "aeval"` in BOTH modes (drop the `transport === "web"` condition at 148/474/edit-equivalent); placeholders per mode — phone Setup: `- type: call.dial\n  number: "+1 555 010 1234"\n- type: call.wait_answered`, phone Teardown: `- type: call.hangup`; web keeps today's.
- [ ] `tests/e2e/phone-ui.spec.ts`: create the phone evalflow through the Setup textarea; assert persisted `config.stepsPrefix` contains call.dial; badge assertions unchanged.

## Task 4: Data migration — evalflow 18 (migration 0040, schema v41)

- [ ] `migrations/0040_steps_model.sql` + `{version: 41}` in `server/migrate.ts`: for every `evalflows` row `WHERE config ? 'phoneDial'`, EXACT-parity rewrite — append to any existing `stepsPrefix` is not needed (phone rows have none): `stepsPrefix` = `- type: call.dial\n  number: "<number>"\n- type: call.wait_answered`, `stepsSuffix` = `- type: call.hangup`, then `config - 'phoneDial'`. (Parity with the deleted auto-wrap: dial → wait_answered → conversation → hangup; the design §1 `audio.wait_for_speech` line was illustrative, not parity.) Rows with `restfulTrigger`: none exist anywhere; still `config - 'restfulTrigger'` for hygiene. Frozen job snapshots untouched.
- [ ] Apply locally by hand + stamp v41 (db:push doesn't run it); verify a local phoneDial fixture converts and evalflow validation passes on the converted shape.

## Task 5: Docs

- [ ] CLAUDE.md: phone-transport bullet (run-route gate wording, phoneDial→steps), DialF-over-Docker bullet if it names phoneDial, restful section (`config.restfulTrigger` → `restful.request` step in stepsPrefix, stepIndex contract).
- [ ] `vox_eval_agentd/README.md` + `docs/openapi.yaml` (evalflow config docs if they name the deleted keys).

## Task 6: Gate + PR

- [ ] Pre-gate DB cleanup (evalflows/projects/secrets owner 1, plugin_organizations user 1 + r2-org rows); `npm run check`; dev server restart; full `./scripts/full-tests-run.sh` with isolate-rerun flake classification; PR `feat: unified Setup/Teardown steps model for every evaluation mode (no phoneDial/restfulTrigger)`; **no merge without the mark**. Post-deploy: evalflow 18 runs e2e on the NixOS phone host (the real proof — job completes, metrics land in My Evals Phone).

## Self-review notes
- The subtle contract is the restful step INDEX: it must be the index within the evalflow's `stepsPrefix` as stored (snapshot), not within the concatenated script — the daemon computes it from the prefix it parsed, which is byte-identical to the snapshot's (both come from the same frozen config).
- Server + daemon both gate "no call.dial" because orphaned jobs (evalflow deleted) reach the daemon with only the snapshot config.
- `scripts/seed-data.ts` and daemon-local `evalflows/*.yaml` configs: check for phoneDial fixtures and convert.
