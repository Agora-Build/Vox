# Secret Class "Protected / Runtime" + Shared-Agent Exposure Warning — Design

**Date:** 2026-08-20
**Status:** Draft for review

## Goal

Rename the secret class `login` → `protected` end-to-end (UI **and** code **and**
database), default the secret-creation picker to **Protected**, and make the
data-exposure trade-off explicit at run time: when a user chooses to run a
workflow on a **shared** agent and that workflow (or its eval sets) references
**Runtime**-class secrets, warn and **require an explicit acknowledgement**
before the run proceeds.

## Mental model (the copy this design implements)

- **Protected (Recommended)** — *Processed securely by Core. The raw secret is
  never exposed to agents.* → **Core sees it, the agent doesn't.**
- **Runtime** — *Sent directly to the agent at runtime. Only use with agents you
  trust.* → **The agent sees the raw value.**

Warning shown when a shared agent is selected and the workflow/eval sets use
Runtime secrets:

> ⚠️ **This workflow uses runtime secrets**
> The selected shared agent will receive the raw values of these secrets.

## Decisions (locked with the requester)

1. **Deep rename** `login` → `protected`: DB enum value, server, daemon, client
   — not just labels.
2. **Default Protected** in the secret-creation UI.
3. **Protected keeps its real meaning (resolution "A")**: Protected == a
   Core-brokered **login credential** (session-broker mints a `storageState`).
   There is no mechanism for Core to use an arbitrary secret on an agent's
   behalf, so a Protected secret that is referenced anywhere other than a
   `platform.setup` login is a misconfiguration and must surface as a **clear
   validation error**, never a silently broken run.
4. **Run-flow agent picker**: add explicit target-agent selection to the run
   dialog, built on the **existing `targetTokenId`** dispatch path (no new
   target-tier column).
5. **Require acknowledgement** (not merely advisory, not a hard block) when a
   Runtime secret would be exposed to a shared-tier agent.

## Background — current state (verified in code)

### Secret class already exists

- Enum: `shared/schema.ts:13`-area — `secretClassEnum = pgEnum("secret_class",
  ["runtime", "login"])`, applied to user secrets (`schema.ts:467`) and org
  secrets (`schema.ts:678`), default `runtime`.
- Picker UI already built in `client/src/pages/console-secrets.tsx`
  (personal form ~lines 244–258, org form ~388–402); a `login` choice reveals a
  "Dedicated test account" checkbox (`isTestAccount`).
- Create/upsert routes accept and validate `secretClass`: `POST /api/secrets`
  (`server/routes.ts:2450`) and `POST /api/org-secrets` (`routes.ts:2543`).
  Both **reject a `login`→`runtime` reclassification** on upsert
  (`routes.ts:2486`) — a protected secret can't be silently downgraded to
  runtime.
- `GET /api/secrets` / `GET /api/org-secrets` already return each secret's
  `class` to the client.

### Protected (login) withholding is structural

- Login-class secrets are filtered out of the agent's job-secrets payload at the
  **storage layer**, so it holds on every dispatch tier:
  `storage.ts:2014` (personal: `.filter(s => s.class !== "login")`) and
  `storage.ts:2482` (org: `if (s.class === "login") continue`).
- Session requirement is decided by `evaluateSessionRequirement()`
  (`server/session-broker.ts:85`), which reads only the **first** `platform.setup`
  step's `email`/`password` `${secrets.NAME}` refs (`parsePlatformSetup`,
  `session-broker.ts:22`) and their class (`getLoginSecretNames`,
  `session-broker.ts:104`). `none | need | misconfigured`.
- The daemon only forces `mode: storage` and strips credentials when
  `config.sessionInjection` is present (`vox-agentd.ts:1868`;
  `session-inject.ts:24`). Absent it, the workflow's authored `platform.setup`
  mode runs as-is (agent logs in itself, in `account` mode).

### Dispatch tier + shared path

- `dispatchTierEnum = ["private","team","public","shared"]`
  (`shared/schema.ts:13`); lives on **`evalAgentTokens.dispatchTier`**
  (`schema.ts:210`), **not** on `evalAgents` and **not** as a target column on
  `evalJobs`. `evalJobs.tokenDispatchTier` (`schema.ts:357`) records only the
  tier of whoever **claimed** the job.
- The run route **already accepts `targetTokenId`** (`routes.ts:3665`,
  branch `3728`–`3798`): a run can be aimed at one specific token, and region is
  taken from that token.
- Shared dispatch is authorized in that branch: when the target token is
  `shared`, `authorizeDispatch()` (`server/marketplace.ts:45`) places an escrow
  hold and returns a `settlementContext` folded into the snapshot
  (`routes.ts:3745`); `credentialConsent` is required + attested for
  session-injected shared jobs (`routes.ts:3735`); settlement runs on complete
  (`routes.ts:3301`) and via the reap sweep (`index.ts:315`).
- Claim-time tier matching (`server/permissions.ts:130` `isClaimable`): a
  **shared** token can only claim a job whose `targetTokenId` equals that token
  — i.e. shared runs are **always targeted**. There is no untargeted
  "route to any shared agent" path today.

**Consequence:** a shared agent that claims a targeted job **does** receive all
Runtime-class secrets raw (only Protected/login secrets are withheld). That
exposure is currently **ungated** — the existing consent gate fires only for
login/session secrets. This design adds the missing gate for Runtime secrets.

## Design

### Part 1 — Rename `login` → `protected`

**Database (migration, hand-authored — do NOT rely on `drizzle-kit generate`,
which may drop/recreate the enum):**

```sql
ALTER TYPE secret_class RENAME VALUE 'login' TO 'protected';
```

- Postgres renames the value in place; existing rows keep their identity. The
  enum type name (`secret_class`) and the column name (`class`) stay.
- New migration file `migrations/00NN_secret_class_protected.sql` (next number,
  ~`0029`), **registered in the `MIGRATIONS` array in `server/migrate.ts`** (an
  unregistered file never runs). Keep the SQL plain (no `IF EXISTS` tricks).
- `shared/schema.ts`: `secretClassEnum = pgEnum("secret_class",
  ["runtime", "protected"])`. Column default stays `runtime` (see Part 2 for the
  UI default vs DB default distinction).

**Code rename (mechanical, but security-load-bearing — every occurrence):**

- `shared/schema.ts` enum + any `SecretClass` type.
- `server/storage.ts` filters: `s.class !== "login"` → `!== "protected"`
  (`~2014`), `s.class === "login"` → `=== "protected"` (`~2482`); attestation
  helper `areLoginSecretsAttested` (`~2517`) predicate.
- `server/routes.ts` secret create/upsert validation + the
  reclassification-guard (`protected`→`runtime` now the blocked downgrade)
  (`~2472`, `~2486`, `~2566`).
- `server/session-broker.ts`: `getLoginSecretNames` → `getProtectedSecretNames`
  (keep behavior); `evaluateSessionRequirement` class checks.
- `vox_eval_agentd/*` / `session-inject.ts`: any `"login"` literal.
- `client/src/pages/console-secrets.tsx`: option value/labels, badge, state.

**Naming note:** internal identifiers that say `login` specifically because the
secret is a *login credential used by `platform.setup`* (e.g. `emailSecret`,
`passwordSecret`, `sessionInjection`) are **not** renamed — those describe the
login mechanism, not the class. Only the *class* token (`login` → `protected`)
and helpers named after the class (`getLoginSecretNames`) are renamed.

### Part 2 — UI default Protected + Protected-scope validation

- Secret-creation form **defaults the class select to `protected`** (personal
  and org). DB column default stays `runtime` so API callers that omit `class`
  are unaffected; the UI always sends an explicit class.
- Labels/help text per the mental model above; `protected` is tagged
  **(Recommended)**. The "Dedicated test account" (`isTestAccount`) checkbox
  stays bound to the Protected class.
- **Validation — Protected must be a login credential.** A Protected secret is
  only meaningful when referenced as a `platform.setup` `email`/`password`.
  Enforce at the authoritative choke point (**pre-run**, when the job is built)
  and advise earlier (workflow editor):
  - Extend the session-requirement evaluation so that if a **Protected** secret
    is referenced by the workflow/eval sets **anywhere other than** the
    `platform.setup` login pair, the run is rejected with a clear message
    ("Secret X is Protected but is used as a runtime value in step … — Protected
    secrets can only be login credentials. Mark it Runtime or remove the
    reference."). This reuses the new reference-enumeration helper (Part 3).
  - Advisory (non-blocking) surfacing of the same condition in the workflow
    detail UI is a nice-to-have, not required for correctness.

### Part 3 — Reference enumeration helper (new)

No helper today lists every `${secrets.NAME}` a workflow uses (only the login
pair). Add one:

- **Location:** `shared/secrets.ts` (already owns
  `SECRET_PLACEHOLDER_REGEX = /\$\{secrets\.([A-Z][A-Z0-9_]*)\}/g`), so both
  server and any shared consumer can use it.
- **Signature (proposed):**
  `collectSecretRefs(configs: string[]): Set<string>` — runs the global regex
  over the workflow `config` (stepsPrefix/scenario) and each eval-set `config`,
  returning the set of referenced names.
- **Server join:** a small function that takes the referenced names + the
  owner/org scope and returns `{ name, class, present }[]` by joining against the
  existing secrets rows (class already available). Used by:
  - Part 2 validation (find Protected refs outside the login pair),
  - Part 5 gate (find Runtime refs when target is shared),
  - the pre-run info endpoint below.

### Part 4 — Run-flow agent picker (built on `targetTokenId`)

The run route already accepts `targetTokenId`; the client just doesn't offer a
picker. Add one.

- **New endpoint** `GET /api/workflows/:id/run-targets?region=…` (auth) →
  `{ agents, referencedSecrets }`:
  - `agents`: the tokens this user may target, each with the fields the UI needs
    to group and warn — `{ tokenId, name, region, dispatchTier, price? }`, split
    into **My agents** (own tokens, any tier) and **Shared marketplace**
    (`dispatchTier === "shared"`, and `public` where applicable). Region-filtered.
  - `referencedSecrets`: the workflow's referenced secrets with class
    (`{ name, class, present }[]`, per Part 3) — folded in so the Part 5 banner
    needs no second call.
- **Run dialogs** (`console-workflow-detail.tsx` run dialog ~129–184;
  `run-your-own.tsx` run section) gain an **Agent** selector. Selecting an agent
  sets `targetTokenId` on the run mutation (region derives from the token, as the
  server already does). "Any available in region" stays the default (untargeted
  pool, current behavior).
- The client learns the selected agent's `dispatchTier` from the endpoint, which
  is what drives the Part 5 warning. (Today the client knows nothing about tier
  at run time — this endpoint is the new signal.)

### Part 5 — Runtime-secret → shared-agent warning + required acknowledgement

- **Pre-run info** (drive the banner without guessing): the `run-targets`
  response also carries the workflow's referenced secrets with class (folded in,
  per the resolved decision) so the client can compute "does this run expose
  Runtime secrets?" from the same single call. Reuses Part 3.
- **Client:** when the selected agent's tier is `shared` **and** the workflow /
  eval sets reference ≥1 Runtime secret, render the ⚠️ banner listing the
  exposed secret names and require an explicit **"I understand"** confirmation —
  an **inline checkbox in the run dialog that gates the Run button** (disabled
  until ticked) — before the run can be submitted.
- **Server (authoritative gate):** in the run route's shared branch, after the
  existing `credentialConsent` handling, add: if the workflow references Runtime
  secrets and the target token is `shared`, require
  `req.body.runtimeSecretConsent === true`; otherwise **400** with a message
  naming the exposed secrets. This mirrors the existing `credentialConsent`
  gate (`routes.ts:3735`) and must live on the server so a direct API caller
  can't bypass the UI.
- **Provenance:** record `runtimeSecretConsent: true` on the job snapshot
  (alongside `credentialConsent`) so the acknowledgement is auditable on the
  immutable per-job record.

## Data model changes

| Change | Where | Migration |
| --- | --- | --- |
| Enum value `login` → `protected` | `secret_class` type | `ALTER TYPE … RENAME VALUE` (00NN) |
| `snapshot.runtimeSecretConsent?: boolean` | `JobSnapshot` type (`shared/schema.ts`) | none (jsonb; additive, no DDL) |

No new columns/tables. `runtimeSecretConsent` rides in the existing snapshot
jsonb, exactly like `credentialConsent`.

## API changes

| Endpoint | Change |
| --- | --- |
| `POST /api/secrets`, `POST /api/org-secrets` | class value `protected` (was `login`); downgrade guard now `protected`→`runtime` |
| `GET /api/secrets`, `GET /api/org-secrets` | class value `protected` in responses |
| `GET /api/workflows/:id/run-targets` | **new** — targetable agents (tier, region) **and** the workflow's referenced secrets + class (folded in, one round-trip) |
| `POST /api/workflows/:workflowId/run` | new pre-run validation (Protected-outside-login → 400); new `runtimeSecretConsent` gate for Runtime-on-shared |

## UI changes

- `console-secrets.tsx` — relabel to **Protected (Recommended) / Runtime**,
  default Protected, help text per mental model.
- `console-workflow-detail.tsx` + `run-your-own.tsx` — Agent picker, ⚠️ Runtime
  banner, required "I understand" before shared+runtime runs.

## Security considerations

- The Runtime-on-shared exposure is **real and currently ungated**; Part 5 is the
  mitigation. The server gate is authoritative — the UI banner is convenience.
- Protected withholding stays structural at the storage layer (`storage.ts`),
  unchanged in behavior by the rename — verify the rename doesn't alter the
  filter predicate semantics (test: a `protected` secret is never in an agent's
  payload, any tier).
- Downgrade guard (`protected`→`runtime`) preserved — a protected secret can't be
  silently reclassified to expose it.
- Protected fails **closed**: a Protected login secret with no broker configured
  fails the job (existing behavior), never downgrades to account-mode.

## Non-goals / out of scope

- No untargeted "route to any shared agent" dispatch (shared stays
  target-token-based). If wanted later, that needs a target-tier column on
  `evalJobs` + claim-SQL arms + a tokenless `authorizeDispatch` — explicitly out
  of scope here.
- No generic "secret proxy" that would let Core broker non-login secrets
  (resolution "C", rejected).
- No change to escrow/settlement mechanics beyond recording the new consent.

## Testing strategy

- **Unit:** `collectSecretRefs` over representative configs; the
  Protected-outside-login validator (`none`/`need`/`misconfigured`/`protected-misuse`);
  the Runtime-on-shared gate predicate.
- **Migration:** applying `00NN` on a DB with existing `login` rows yields
  `protected` rows and preserves `isTestAccount`; app boot marks it applied via
  `server/migrate.ts`.
- **Integration (api.test.ts):** create secret → class `protected`; downgrade
  `protected`→`runtime` still 400s; run with `targetTokenId` = shared + a
  Runtime secret and no `runtimeSecretConsent` → 400; with consent → job created
  and `snapshot.runtimeSecretConsent === true`; Protected secret referenced as a
  runtime value → run 400s with the misuse message.
- **Agent payload:** eval-agent-daemon test confirms `protected` secrets are
  withheld from the fetched payload while `runtime` are delivered.
- Update any fixtures/strings referencing the `login` class.

## Resolved decisions

- **Acknowledgement UX** — an inline "I understand" checkbox in the run dialog
  that gates the Run button (disabled until ticked). *(Confirmed 2026-08-20.)*
- **Referenced-secrets delivery** — **folded into `GET
  /api/workflows/:id/run-targets`** (one round-trip); no standalone
  `referenced-secrets` endpoint. The run-targets response carries both the
  targetable agents and the workflow's referenced secrets + class.
  *(Confirmed 2026-08-20.)*
- **Advisory Protected-misuse hint in the workflow editor** — **deferred**;
  the pre-run validation (Part 2) is the correctness guarantee. The editor may
  gain an advisory hint later, but it is out of scope for this work.
  *(Confirmed 2026-08-20.)*

All open questions are resolved; no items remain outstanding.
