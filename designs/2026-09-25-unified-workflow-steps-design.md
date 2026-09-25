# Unified Evalflow Model — Setup/Teardown Steps for Every Mode + the workflow→evalflow Rename

**Status: APPROVED — §8 rename shipped in PR #175; §1–7 built on `feat/unified-steps` (plan: `2026-09-25-unified-steps-plan.md`).** Date: 2026-09-25.
Two changes in one reviewable place, shipped as **separate PRs** (rename first, per §8):
1. **Unified steps model** — direction set by review: *keep Setup Steps and Teardown Steps as the model, identical for phone and web; empty when not needed; the step vocabulary is [Libretto](https://github.com/Agora-Build/libretto)* (supersedes the rejected "Connection section" sketch).
2. **workflow → evalflow** — full rename, no legacy compatibility (§8).

---

## 1. The model

Every workflow, regardless of Evaluation Mode, has exactly the two script fields it has today:

| Field | Role | Stored as |
|---|---|---|
| **Setup Steps** (`stepsPrefix`) | Establish the session: log in / dial / trigger / wait for greeting | YAML step list |
| **Teardown Steps** (`stepsSuffix`) | End the session cleanly | YAML step list |

The eval set stays the conversation; the workflow stays "how we reach the agent and how we leave." What changes: **phone workflows stop having special config keys** (`phoneDial`, `restfulTrigger`) and express everything as steps in the shared vocabulary.

### Web (unchanged — everything in use today keeps working)

```yaml
# Setup Steps
- type: platform.setup
  platform_id: elevenlabs
  params:
    mode: account
    email: ${secrets.ELEVEN_CONSOLE_EMAIL}
    password: ${secrets.ELEVEN_CONSOLE_PASSWORD}
    storage_file: .auth/elevenlabs.json
- type: audio.start_recording
- type: platform.enter
- type: platform.wait_for_active
- type: audio.wait_for_speech
  timeout_ms: 30000
  silence_duration_ms: 3000
  description: Wait for agent greeting

# Teardown Steps
- type: audio.stop_recording
- type: platform.exit
```

> **Terminology convention:** call direction is
> **always from the AGENT's perspective**, never ours/DialF's.
> **Inbound** = the agent *receives* a call — we dial it (`call.dial`).
> **Outbound** = the agent *places* a call to us — we trigger it (REST/web page) and answer.
> Earlier Vox docs/comments sometimes used DialF's endpoint-centric framing (inverted);
> the rename + steps PRs sweep those (CLAUDE.md, phone design §4/§6, DialF requirements R7
> wording, code comments like `buildOutboundJob`). DialF's own docs keep DialF's
> perspective — that's its domain; the flip happens at the Vox boundary.

### Phone — inbound to the agent (we call it; replaces `phoneDial`)

```yaml
# Setup Steps
- type: call.dial
  number: "+1 408 837 5890"
- type: call.wait_answered
- type: audio.wait_for_speech
  timeout_ms: 30000
  silence_duration_ms: 3000
  description: Wait for agent greeting

# Teardown Steps
- type: call.hangup
```

### Phone — outbound from the agent (it calls us after a trigger; replaces `restfulTrigger`, adds web-page trigger)

```yaml
# Setup Steps — REST trigger
- type: restful.request           # brokered when the referenced secret is broker-class
  method: POST
  url: https://api.target.example/v1/calls
  headers: { Authorization: "Bearer ${secrets.TARGET_KEY}" }
  body: { to: "${phoneNumber}" }
# (answering + result acquisition still gated on DialF R7 — authorable now, labeled)
```

A web-page trigger is the same idea with `browser.*` steps. Anything new the future brings ("some other way to make this easier") is a new step type in Libretto, not a new workflow mechanism.

## 2. Execution: the daemon becomes a real Libretto splitter

Setup + eval-set conversation + teardown form **one script**. The daemon partitions it by Libretto's execution classes (spec §3):

- **`restful.request`** (orchestrated/brokered) — executed daemon-side *before* the call, via the existing lease-fenced Core endpoint. Never sent to DialF.
- **Contiguous `call.*` / `audio.*` block** — compiled and handed to DialF **whole** (the session-block rule).
- **Web mode** — `platform.*`/`audio.*` pass through to aeval exactly as today; zero behavioral change.

The current auto-wrapping (`buildOutboundJob` injecting dial/wait/hangup around the conversation) is deleted — **the script says what happens**. One safety override stays: the daemon **always ensures a `call.hangup` at job end** even if teardown omits it. A script bug must never leave a carrier call off-hook.

## 3. Security: brokered REST keeps its TOCTOU guarantee

Today the Core endpoint reads `restfulTrigger` from the **frozen job snapshot**. Under this model it reads the `restful.request` step out of the snapshot's `stepsPrefix` (workflow config is already snapshot-frozen), addressed by step index. Same property: the executed template can never differ from what was dispatched; the caller still supplies only the `phoneNumber` variable.

## 4. Migration: clean cut (proposed)

Only workflow 18 uses `phoneDial`; nothing uses `restfulTrigger` yet. Proposal:

1. Rewrite workflow 18's config to the setup/teardown form (one DB update).
2. Delete the `phoneDial`/`restfulTrigger` keys, their validation, and the run-route special-casing.
3. New run-route gate for phone: **Setup Steps must contain a `call.dial` or a trigger step** ("empty Setup" on a phone workflow is rejected at run — nothing would establish a call). Empty stays legal wherever it's meaningful (e.g., a web target needing no login).

Alternative (not preferred): keep legacy key readers indefinitely — two code paths forever for one workflow's worth of data.

## 5. UI: identical by construction

The create/edit dialogs show the **same two textareas for every mode** — the phone-number field disappears; per-mode placeholder text shows the right example (web: `platform.setup…`; phone: `call.dial…`). Mode still gates *validation* (web vocabulary rejected in phone scripts and vice-versa, at save time with clear errors), not *layout*.

## 6. Drag-and-drop / visual builder: later, and not a graph

Recommendation: **park it for this effort**, and when built, make it a **sortable step list** (drag to reorder; each step expands into a small typed form), *not* an n8n-style node canvas. Two reasons:

- Libretto scripts are deliberately **flat sequences** — no branching, `control.for_each` is the ceiling. A node-graph canvas visually promises a DAG the model forbids; a reorderable list is the honest visual form of the actual model.
- Sequencing: the YAML textareas already work and remain the source of truth either way. Building the list-builder **after** Libretto issue #2 (JSON Schemas for scripts) means each step's form is *generated from the schema* rather than hand-maintained per step type — strictly less code, always in sync with the spec.

Form ⇄ YAML stays two views of one config: the builder edits the same stored steps; scripts hand-written in YAML that the builder can't represent keep the editor in YAML mode rather than losing anything.

## 7. Scope of the build (when approved)

| Area | Change |
|---|---|
| Daemon | Script splitter (setup+conversation+teardown; restful pre-call via Core; session block to DialF; enforced hangup); delete `buildOutboundJob` auto-wrap; extend the phone compiler with `call.*` in setup/teardown |
| Server | Run-route phone gate on setup contents; Core restful endpoint reads the step from snapshot `stepsPrefix`; validation for `call.*`/`restful.*` in step scripts; delete `phoneDial`/`restfulTrigger` |
| Client | Remove phone-number field; show Setup/Teardown for phone with placeholders |
| Data | Migrate workflow 18 |
| Docs/tests | CLAUDE.md, phone-eval + validation suites, E2E touch-up |

## 8. Rename: workflow → evalflow (decided: full rename, NO legacy compatibility)

**Why:** every other noun in the product is already eval-prefixed — eval sets, eval jobs, eval agents, eval schedules — and "workflow" is the one generic outlier, colliding with n8n/GitHub-Actions/CI vocabulary (a collision that worsens if a visual step builder ever lands). `Evalflow → eval set → eval job → eval agent` reads as one coherent family. **Why now:** with one production user and a young product, this rename is the cheapest it will ever be; partial renames linger (the UI still says "workers"/"testSets" in places from earlier ones), so full and immediate beats staged.

**The two landmines, and how no-compat resolves them:**

1. *Frozen job snapshots* — every historical job carries `snapshot.workflow.{...}` as immutable JSONB, and the metrics-tier SQL indexes into `snapshot->'workflow'`. Leaving them would make all history vanish from the metrics views under single-path readers. Resolution: migrate the **key spelling** once, content preserved byte-for-byte — the immutability invariant protects provenance *content*, not key names.
2. *Public API surface* — `/api/workflows` and the v1/OpenAPI docs. Resolution under no-compat: old paths removed outright, docs updated; any external caller updates with us.

Full rename, no compat shims:

- **API:** `/api/workflows*` → `/api/evalflows*` — old paths removed, not aliased. OpenAPI/v1 updated.
- **Database:** migration renames `workflows` → `evalflows` and every `workflow_id` column → `evalflow_id` (plain `ALTER ... RENAME`, cheap in Postgres). Drizzle schema, claim SQL, tier SQL, boundary tests follow.
- **Snapshots:** one-time migration rewrites the key — `snapshot.workflow` → `snapshot.evalflow` — content preserved byte-for-byte (`snapshot - 'workflow' || {evalflow: snapshot->'workflow'}`). This is a key *spelling* change, not a provenance rewrite; the immutability invariant protects content, and single-path readers beat a forever dual-read. Tier SQL's `snapshot->'workflow'` expressions (and any expression indexes) update in the same migration.
- **Code/UI/docs:** identifiers (`canRunWorkflow` → `canRunEvalflow`, `workflowNeedsSession` → `evalflowNeedsSession`, `workflowId` → `evalflowId`, …), client pages/routes (`/console/evalflows`), placeholders, CLAUDE.md, tests.
- **Sequencing:** the rename ships as its **own PR** — a pure-rename diff with zero behavior change, reviewable as such — separate from the unified-steps change. Order: rename first (steps work then lands on clean names).

## 9. Decisions & open questions

**Decided in review:**
- Setup/Teardown Steps are the model for every mode; no "Connection" section (§1).
- Step vocabulary = Libretto (+ engine-native `platform.*`); "rest and more" per the [libretto repo](https://github.com/Agora-Build/libretto).
- workflow → **evalflow**: full rename, no legacy compatibility, own pure-rename PR shipped **first** (§8).

- **Clean cut** on `phoneDial`/`restfulTrigger`: migrate workflow 18, delete the keys and their special-casing. *(Q1, approved.)*
- **Auto-`call.hangup` safety net**: the daemon guarantees the call ends whenever the job finishes **without the script's own hangup having run** — teardown omitted it, a step timed out, or the job aborted before the task completed. *(Q2, approved with that scope.)*
- Empty Setup on a phone evalflow → **rejected at run** ("nothing establishes a call"). *(Q3, approved.)*
- Visual builder **parked**: sortable step list later, after Libretto JSON Schemas; not an n8n graph. *(Q4, approved.)*

All questions resolved — implementation plans follow (rename PR first, then the steps model).
