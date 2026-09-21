# Phone vs Agent — Phase B (restful.* Trusted Path + REST Broker) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the `restful` secret class and the trusted execution path — a lease-fenced Core endpoint that resolves a REST-trigger template from the frozen job snapshot and dispatches it to a new, independent REST broker on the existing registry. (Daemon-side step execution arrives with Phase C; this phase delivers and tests the server + broker halves the daemon will call.)

**Architecture (design §5, all decided):** routing by the secret's `brokerType` — `'restful'` joins `KNOWN_BROKER_TYPES`, which alone unlocks secret classification, broker registration, and `routeToBroker`. Withholding needs **zero changes**: `getSecretsForJob` / the org path already filter `brokerType != null`. Core resolves the request template from `snapshot.workflow.config.restfulTrigger` (never caller-supplied), decrypts referenced secrets, dispatches to a live `restful` broker (`executeViaBroker`, mirroring `mintViaBroker`'s abort/redaction discipline), and returns a sanitized `{status, ok, bodyExcerpt}`. The broker is a stateless sidecar (far simpler than auth-session: no browser/aeval/audio) carrying the SSRF hygiene.

**Spec:** `designs/2026-09-21-phone-vs-agent-design.md` §5; Libretto `restful.request` semantics in `designs/2026-09-21-unified-action-vocabulary-spec.md` §4.6.

## Global Constraints

- No schema change, no migration: `secrets.brokerType` and `brokers.brokerType` are free text; `workflows.config` is jsonb.
- Brokered secrets never reach an agent, and raw response bodies can echo credentials — every string returned to the daemon or persisted is redacted with Core's own copies (`redactValues` + `credentialForms`, the `mintViaBroker` pattern) **before** truncation.
- Caller-supplied request data is never trusted: URL/method/headers/body come from the frozen snapshot only; the caller may supply only whitelisted variables (`phoneNumber`).
- Integration tests hit the running dev server — restart after `server/` changes. Direct-DB tests follow the `tests/phone-transport.test.ts` idiom (env-guarded, self-cleaning).
- Branch `feat/restful-broker-phase-b`; commit signature per convention; PR at the end, **no merge** without the user's mark.

---

### Task 1: `restful` joins the broker-type universe + reclassification guard generalized

**Files:**
- Modify: `server/broker-registry.ts:1` (`KNOWN_BROKER_TYPES = ["auth-session", "restful"]`)
- Modify: `server/routes.ts:2909` and `server/routes.ts:3020` — the reclassify-to-runtime guard: `existingRow.brokerType === "auth-session"` → `existingRow.brokerType != null` (message: "A brokered secret cannot be reclassified to runtime — delete and recreate it instead")
- Test: `tests/restful-broker.test.ts` (new)

**Interfaces:**
- Produces: `POST /api/secrets` and org-secret upsert accept `brokerType: "restful"` (via existing `resolveBrokerType`); `GET /api/broker-types` includes it; registration `validateRegisterPayload` accepts a `restful` broker. Withholding is automatic (regression-locked here).

- [ ] **Step 1: Failing test** — HTTP as admin: create secret `{name: "PHA_TRIGGER_KEY", value: "v", brokerType: "restful"}` → 200 echoing `brokerType: "restful"`; `brokerType: "jetpack"` → 400; value-only re-POST preserves class; re-POST with `brokerType: null` → 400 (reclassify guard); storage-level: `getSecretsForJob`-style scope excludes it (seed a workflow+job for the owner, assert the restful row absent — mirrors `tests/session-secrets-class.test.ts`).
- [ ] **Step 2: Run — expect FAIL** (unknown brokerType 400 on create).
- [ ] **Step 3: Implement** (the two edits above — the create path needs no other change).
- [ ] **Step 4: Restart dev server; run — expect PASS. Also `npx vitest run tests/session-secrets-class.test.ts`** (withholding regression).
- [ ] **Step 5: Commit** (`feat(restful): restful secret class on the broker-type registry`).

---

### Task 2: `restfulTrigger` workflow-config shape + validation

**Files:**
- Modify: `server/routes.ts` — `validateWorkflowConfig` (grep it): accept optional `config.restfulTrigger`
- Modify: `shared/schema.ts` — exported type `RestfulTrigger`
- Test: `tests/restful-broker.test.ts` (extend)

**Interfaces:**
- Produces:
```ts
export type RestfulTrigger = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;                       // https only; may contain ${secrets.NAME} / ${phoneNumber}
  headers?: Record<string, string>;  // values may template
  body?: unknown;                    // JSON; string leaves may template
  expectStatus?: number[];           // default [200..299]
  timeoutMs?: number;                // default 30000, cap 120000
};
```
- Validation rules: `url` must parse and be `https:` (http allowed only for `localhost` — dev); method in the enum; `timeoutMs` within cap; unknown fields rejected. Template placeholders are NOT resolved here — shape only.

- [ ] **Step 1: Failing test** — workflow create (HTTP) with a valid `restfulTrigger` → 200; `method: "BREW"` → 400; `url: "ftp://x"` → 400.
- [ ] **Step 2: Run — expect FAIL.**  - [ ] **Step 3: Implement** in `validateWorkflowConfig` (follow its existing error-string style).
- [ ] **Step 4: Restart; run — expect PASS.**  - [ ] **Step 5: Commit** (`feat(restful): restfulTrigger workflow-config shape`).

---

### Task 3: `executeViaBroker` in the registry

**Files:**
- Modify: `server/broker-registry.ts` — new export next to `mintViaBroker`
- Test: `tests/restful-broker.test.ts` (extend — pure unit, injected `fetchImpl`)

**Interfaces:**
- Produces:
```ts
export interface RestExecRequest {
  method: string; url: string; headers?: Record<string, string>;
  body?: unknown; expectStatus?: number[]; timeoutMs?: number;
}
export interface RestExecResult { status: number; ok: boolean; bodyExcerpt: string }
export async function executeViaBroker(
  target: BrokerTarget, req: RestExecRequest, redactNeedles: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<RestExecResult>
```
- Semantics: `POST ${target.url}/execute` with `authorization: Bearer ${target.mintSecret}`; abort at `(req.timeoutMs ?? 30000) + 15000`; non-2xx from the broker itself → throw `broker exec failed: <status>[: detail]` with detail redacted-then-capped (500 chars) exactly like `mintViaBroker`; 2xx → parse `{status, bodyExcerpt}`, re-redact `bodyExcerpt` with `redactValues(…, credentialForms(redactNeedles))`, cap 2048, compute `ok` from `expectStatus ?? 200–299`.

- [ ] **Step 1: Failing unit test** — happy path (mock fetch returns `{status: 201, bodyExcerpt: "id=7"}`, expectStatus [201] → ok true); needle in body gets redacted; broker 500 with detail throws redacted message; timeout aborts.
- [ ] **Step 2: Run — expect FAIL.**  - [ ] **Step 3: Implement.**  - [ ] **Step 4: Run — expect PASS.**  - [ ] **Step 5: Commit** (`feat(restful): executeViaBroker dispatch`).

---

### Task 4: Core endpoint `POST /api/eval-agent/jobs/:jobId/restful`

**Files:**
- Modify: `server/routes.ts` — new route beside the session endpoint (grep `jobs/:jobId/session` for the auth/fence idiom to copy)
- Modify: `server/auth-session.ts` or a small helper — template resolution
- Test: `tests/restful-broker.test.ts` (extend — integration with a fake broker `http.createServer` on localhost, broker row seeded directly in `brokers` + `cacheBrokerMintSecret`)

**Interfaces:**
- Consumes: Task 2 `RestfulTrigger` in `snapshot.workflow.config`, Task 3 `executeViaBroker`, existing `routeToBroker`.
- Produces: agent-token-auth + lease-fenced endpoint; body `{ agentId, leaseId, variables?: { phoneNumber?: string } }`:
  - 403 wrong token/agent/lease (copy the session endpoint's fencing bit for bit); 409 job not `running` or not claimed by this agent;
  - 400 `no restfulTrigger on this job` when the snapshot has none;
  - resolves `${secrets.NAME}` from the workflow-ownership secret scope (personal owner secrets; org-owned workflow → org secrets through the existing R3-fenced decrypt tail — reuse `orgRuntimeSecretsForJob`'s fence shape but WITHOUT the runtime-class filter, since this path is Core-only) — a referenced name that doesn't resolve → 502 `unresolved secret reference` (name only, never values);
  - resolves `${phoneNumber}` from `variables` (the ONLY caller-suppliable input; absent → empty string is an error if referenced);
  - `routeToBroker("restful")` → 503 `{error: "No restful broker available"}`;
  - success → 200 `{status, ok, bodyExcerpt}` (already redacted with every resolved secret value as needle); broker failure → 502 with the redacted message.
- **This endpoint never reads the live workflow** — snapshot only (TOCTOU, same rule as the session endpoint).

- [ ] **Step 1: Failing integration test** — seed: user, `restful` secret (`TRIG_KEY=sekret123`), workflow with `restfulTrigger` (`url: http://localhost:<fakePort>/call`, header `Authorization: Bearer ${secrets.TRIG_KEY}`, body `{to: "${phoneNumber}"}`), phone job with snapshot built from it, claimed by a seeded agent; seed a `brokers` row (`brokerType: 'restful'`, url = second fake server acting as broker that echoes what it received) + `cacheBrokerMintSecret`. Assert: correct template resolution arrives at the broker (auth header carries `sekret123`, body carries the phoneNumber variable); response to the agent has `bodyExcerpt` with `sekret123` redacted if echoed; wrong lease → 403; no-trigger job → 400; no live broker (delete row) → 503.
- [ ] **Step 2: Run — expect FAIL (404 route).**  - [ ] **Step 3: Implement.**  - [ ] **Step 4: Restart; run — expect PASS. Also `npx vitest run tests/org-secret-fence.test.ts`** (fence regression).
- [ ] **Step 5: Commit** (`feat(restful): lease-fenced trusted REST execution endpoint`).

---

### Task 5: REST broker sidecar

**Files:**
- Create: `vox_rest_broker/rest-broker.ts` (single file, mirror the registration/heartbeat client code from `vox_eval_agentd/auth-session-broker.ts` — read it first and copy its register/heartbeat/env idioms: `VOX_CORE_URL`, `BROKER_REG_TOKEN`, `BROKER_ADVERTISE_URL`, `BROKER_NAME`, `BROKER_PORT`; it declares `brokerType: "restful"`)
- Create: Dockerfile target `rest-broker` (extend the existing multi-stage Dockerfile that has the `broker` target — same pattern, no aeval/browser deps, just Node)
- Test: `tests/rest-broker-sidecar.test.ts` (new — unit-test the exported guard + handler functions; no Docker in the gate)

**Interfaces:**
- Produces: `POST /execute` (Bearer mint-secret auth) accepting `RestExecRequest`, responding `{status, bodyExcerpt}`:
  - **SSRF guards** (exported `assertSafeTarget(url): void`): scheme http/https only; hostname must not be an IP-literal in RFC1918/loopback/link-local/0.0.0.0/IPv6-loopback ranges and must not be `localhost`, unless `REST_BROKER_ALLOW_PRIVATE=1` (dev);
  - `redirect: "manual"` — 3xx is returned as the status, never followed;
  - response body read capped at 64 KiB, `bodyExcerpt` = first 2048 chars;
  - per-request timeout `min(req.timeoutMs ?? 30000, 120000)` via AbortSignal;
  - wrong/missing bearer → 401; malformed body → 400; target fetch error → 502 `{error: "<sanitized message>"}` (no stack, no URL credentials).
- The sidecar performs **no redaction** (it never sees which values are secrets) — Core redacts; the sidecar only caps.

- [ ] **Step 1: Failing unit tests** for `assertSafeTarget` (rfc1918/loopback/link-local/dns-name-ok cases) and the handler (auth, cap, manual redirect) with an injected fetch.
- [ ] **Step 2: Run — expect FAIL.**  - [ ] **Step 3: Implement.**  - [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Docker build check** (per the docker-build-verification convention): `docker build --target rest-broker -f <the Dockerfile> .` from repo root — must succeed locally.
- [ ] **Step 6: Commit** (`feat(restful): stateless REST broker sidecar`).

---

### Task 6: Gate + docs + PR

- [ ] **Step 1: CLAUDE.md** — Environment Variables note (the REST broker reads the same broker sidecar env family; new image target) + one line in the Auth-Session Broker section: `brokerType 'restful'` = trusted REST execution, routed identically, secrets withheld identically. Reference design §5.
- [ ] **Step 2: Clean dev DB (documented SQL), restart server, `npm run check`, full `npm test` with env sourced** — classify any failure against the known pre-existing set before proceeding.
- [ ] **Step 3: `./scripts/full-tests-run.sh`** (background, tee to /tmp) — effective-green required.
- [ ] **Step 4: Push `feat/restful-broker-phase-b`, open PR** (body per convention, `Generated with SMT <smt@agora.build>`), **do not merge**.

---

## Self-review notes

- Spec coverage: §5 secret class (T1), template-from-snapshot + server-stamped discipline (T2/T4), broker-based trusted env + registry reuse (T3/T4/T5), sanitization both hops (T3 Core-side, T5 caps), failure-before-phone-resources ordering is Phase C's caller concern (noted there).
- Deliberately out: daemon step execution + `${phone.number}` sourcing (Phase C), UI secret-class picker (Phase D), `restful.poll` (reserved in Libretto).
- Execution-time reads required: `validateWorkflowConfig` body, session endpoint fencing block, `auth-session-broker.ts` register/heartbeat client, the Dockerfile target layout, `orgRuntimeSecretsForJob` fence shape. Anchors given; don't invent signatures.
