# Agent Credentials, Secret Execution, and Dispatch

Status: Implemented policy and living design; keep aligned with code and tests.
Last updated: 2026-11-05. Deployment and production acceptance are separate.

This is the single maintained design for credential ownership, Runtime/Brokered
execution, agent targeting, public trials, and secret-management safeguards.
Update this document in the same change as the implementation and its tests.
Historical design paths are compatibility pointers, not independent policies.

## 1. The Authorization Model

Decide three questions separately:

1. Who may run the flow?
2. Whose credentials may this run spend?
3. Which agent may receive the Runtime values or authenticated session?

Public visibility is not unlimited spending permission. Public flows, public
results, Mainline agents, and Shared marketplace agents are different concepts.

A personal flow uses its owner's personal secrets. An organization flow uses
only that organization's secrets, never its creator's personal secrets.
The immutable job snapshot freezes flow ownership, setup, scenario, transport,
secret requirements, and approved consent/trial context. Editing a flow after
admission cannot redirect an existing job to another owner's credentials.

## 2. Secret Types and Ownership

| Type | Stored model | Execution |
|---|---|---|
| Runtime | `brokerType = null` | Only the raw values required by the authorized job are delivered to its agent. |
| Brokered Auth Session | `brokerType = "auth-session"` | Core/broker uses login credentials and gives the authorized agent an authenticated browser session. |
| Brokered REST | `brokerType = "restful"` | A trusted broker executes the frozen REST operation; stored credentials are not delivered to the agent. |

Brokered raw credentials remain inside Core/trusted broker infrastructure on
every tier, including an owner's own agent. "Accept Brokered secrets" means
accept their authorized session or operation result, not the raw credentials.
An authenticated session may grant meaningful account access. A REST response
must be scrubbed; Brokered does not mean zero exposure.

Secrets use AES-256-GCM at rest with `CREDENTIAL_ENCRYPTION_KEY`. Secret names
match `^[A-Z][A-Z0-9_]*$`. Values must be at least four characters; each
multiline line containing letters or digits must also meet that minimum.
Short legacy values required by a job cause rejection, rather than unsafe
redaction. Listings and diagnostics show names/metadata, not raw values.

The name-based default for USERNAME/PASSWORD/ACCOUNT/EMAIL is a convenience,
not authorization. Explicit classification controls execution. Unknown broker
types are rejected. An existing Brokered secret cannot silently become Runtime
or change broker type; delete with confirmation and recreate it deliberately.

## 3. Agent Trust Matrix

Every "allowed" cell also requires caller authorization, a matching credential
scope, an active lease, and the eval-set trust rules in section 5.

| Agent operator and tier | Personal Runtime | Brokered session/operation | Organization Runtime |
|---|---|---|---|
| User's own Private agent | Own personal scope only | Own personal scope only | No; use Team or Mainline |
| User's own Shared agent | Own personal scope only | Own personal scope; no third-party session consent needed | No owner-personal exception |
| Someone else's Shared agent | Never, even with old Runtime consent | Authorized Brokered use only; authenticated sessions require fresh per-run owner consent | No raw values |
| Same-organization Team agent | Never | Same-organization scope only | Same-organization scope only |
| Trusted Public/Mainline fleet | Flow's authorized personal scope | Flow's authorized personal/organization scope | Flow's authorized organization scope |

A Shared agent does not become trusted with everyone else's raw secrets because
its operator also has an account. The owner exception requires that the
personal flow/credential owner and Core-authenticated token owner are the same
person. An organization flow's creator ID alone never satisfies that exception.
Global admin status is not personal-secret ownership.

Third-party Shared authenticated-session consent is targeted to the exact token
and stamped per run by the credential owner or same-org secret manager. A
borrower cannot consent for the flow owner. Old `runtimeSecretConsent` and
`isTestAccount` metadata do not override the trust matrix.

### Owner-first Manual Selection

When a user opens a run form for their own personal flow, prefer an available
own Private or Shared agent. The server advertises `preferredTokenId` from
eligible, recently seen idle agents; phone and session capability requirements
still apply. The UI selects that agent initially and lets the user choose
another authorized target. Refetches do not override an explicit selection.

Own Shared runs need no marketplace listing or self-payment/escrow. Runs on
another operator's Shared agent retain marketplace authorization and settlement.
Never silently reroute a submitted targeted job to a different operator.
Schedules and the versioned API retain their explicit pool selection.

## 4. Dispatch and Credential Delivery

Targeting has exactly one form:

- Targeted: `targetTokenId`; only that token may claim.
- Pooled: `region + targetTier`; `private`, `team`, or `public`.
  Pooled Shared dispatch is not implemented.

A region is a base ID such as `na-us-seattle`; a concrete site is
`na-us-seattle-02`. Pooled jobs start without a site; claim stamps the
actual site. Mainline uses the trusted token location. Other tiers use detected
location; an unverified/null region cannot match a region pool.

The private pool matches the caller's own agents. Team pools require same-org
authorization and an agent offered as Team/Public; another org member's Private
agent is not a Team offering. Mainline pools match platform-operated Public
tokens only. Credential restrictions compose with these pool rules, so an
organization flow cannot use the personal-only Private credential path.
Third-party Shared credential jobs are individually targeted. An owner's own
Shared agent may also serve their personal flow through their explicit private
(My agents) pool; that is not paid Shared pooling or third-party access.

`permissions.isClaimable` and both storage list/claim SQL predicates must
remain equivalent. Atomic claims use row locking/`SKIP LOCKED`. Phone jobs
require phone capability; session jobs require session-injection support and
compatible framework versions. Legacy site-pinned jobs retain their legacy
matching arm until drained.

Pooled jobs queue through normal empty-pool conditions (24-hour pending
backstop). Targeted jobs retain the shorter no-agent timeout (15 minutes).
Existing running/stale lease/retry limits remain independent of trial quotas.

Admission does not replace credential delivery checks. Runtime, session, and
trusted REST endpoints recheck the assigned token, current lease, running job,
frozen credential scope, caller authorization, and agent policy. A forged
snapshot or valid agent lease alone does not authorize credential spending.
Only Runtime values actually filled by this frozen job are released.

Trusted Mainline may serve authorized Brokered login jobs, including owner
schedules. For example, Scout's owner-authorized ElevenLabs schedule must not
be blocked merely because its login is Brokered and its pool is Public.
Do not automatically resume paused schedules or change production secrets.

The console permits accessible public flow runs; private runs require existing
owner/org authorization. The versioned run API remains flow-owner-only
(decision #200), with its existing pooled targeting contract. No borrowed
credentials are added to API keys or schedules.

## 5. Eval-Set Trust and Secret Substitution

Every job is Setup (flow), scenario (eval set), then Teardown (flow).
The scenario receives secrets only when both conditions hold:

1. Eval set and flow have the same credential owner: same personal owner or
   same organization.
2. The eval set's creator can currently edit the flow (flow owner or the
   flow organization's owner/admin).

A personal eval set never receives organization secrets. An arbitrary org
member's eval set is not trusted merely because it has the same org ID.
Membership/secret-management checks use the organization service boundary;
service outages fail closed without destructive schedule changes.

`secretGate` applies on browser/API runs, schedule creation/resume/run-now,
and scheduler ticks. It rejects missing required secrets and untrusted
secret references across the eval set's whole config, including indirect
`${config.*}` references. An untrusted eval set cannot supply a missing
Setup/Teardown config value that steers secret-bearing execution.
`mergeEvalConfig` strips caller trust/session flags and stamps the server's
decision. Borrowed trials additionally require an owner-controlled eval set,
even if the scenario contains no literal secret reference.

The agent fills parsed YAML values, not YAML text: config first, then secrets.
Setup/Teardown are filled; the scenario is filled only with the trusted stamp.
`restful.request` is not filled agent-side. Both web and phone use the shared
preparation code. After legitimate Brokered session injection, unresolved
required references stop execution with a name-only error.
The server's least-privilege release uses the same filling function.

Bound YAML expansion before walking or serializing: 200,000 expanded nodes
and depth 64. Alias bombs fail at admission and at delivery/agent preparation.

## 6. Borrowed Public-Flow Trials

A signed-in browser user may try an opted-in public flow with the flow
owner's credentials, on pooled trusted Mainline only.

### Defaults and Owner Controls

| Setting | Scope | Default |
|---|---|---|
| Per-user 24-hour limit | Caller + eval flow, rolling window | 5 |
| Per-user 30-day limit | Caller + eval flow, rolling window | 80 |
| Borrowing opt-in | Personal/organization credential scope | Off |
| Aggregate 30-day run budget | Credential scope, all callers and flows | 0 while disabled; owner must choose a positive budget to enable |

The flow owner sets `trialLimit24Hours` and `trialLimit30Days` when creating
a public flow or editing/publishing it. Existing flows receive 5 and 80.
Only same-org secret managers can change limits for organization flows.
Values are integers from 0 to 10,000; zero in either window disables this
flow's borrowed trials. Hiding a flow makes it ineligible; publishing it
retains configured limits. A clone starts with the defaults, not copied quota
usage. Existing policies remain off until explicitly enabled under Secrets.

The limits are per caller **per flow**, not across all of an owner's flows.
The separate credential-scope aggregate budget protects against multiplication
across flows/callers. It is a run cap, not a provider-dollar-cost guarantee.
Plan caps and credits remain independent. Owner/same-org authorized runs and
owner schedules do not consume borrowed-trial allowance.

### Atomic Admission and Accounting

- Both rolling caller limits and the owner's aggregate budget must pass.
- A database transaction takes submission, flow, and owner-scope advisory
  locks, reads the live public flow/limits under row lock, then inserts the
  job and durable usage together. All Core instances share this accounting.
- Flow ownership/config changes while waiting require refresh; live quota
  changes apply without resetting usage. Per-flow usage survives ownership
  transfers; prior aggregate charges stay with their original credential scope.
- Validation failures do not count. Admitted failures/cancellations count.
  Internal retries of the same job do not count again.
- Deleting a job does not refund usage. Flow deletion preserves owner accounting
  while nulling its flow reference.
- A browser submission UUID is unique per caller. Retrying a lost response
  returns the original job even at the quota limit or after ownership changes.
  Reusing it for a different/deleted job fails closed.
  Flow/eval-set IDs are validated and normalized before either replay lookup;
  numeric-string eval-set IDs cannot diverge from persisted numeric IDs when
  concurrent retries reach the transactional replay path.
- Borrowed credential release requires a durable usage record matching the
  exact job, caller, and frozen credential scope. Never trust a client stamp.

### Entry Point and Safe Alternatives

Require a browser session; reject API-key and Authorization-header requests
for borrowing. Web-only is not bot prevention: quotas remain authoritative.
Borrowers cannot override secret-bearing setup/config, provide an untrusted
scenario, target their own agent with borrowed credentials, or schedule runs.

Run forms show the actual configured limits, remaining allowance, and reason
when unavailable. Exhaustion never silently switches credential owners.
"Bring your own credentials" explicitly clones the flow through the existing
clone path; it copies references/config but no secret values. The caller
reviews the code, configures their own referenced secrets, and uses an
authorized agent. A dedicated cross-owner credential-binding API is not built.

## 7. Broker Infrastructure

Known broker types are `auth-session` and `restful`. The nullable text
`broker_type` replaces the historical login/protected enum; adding a supported
type requires an implementation/allowlist change, not a new enum.

Brokers are trusted operator infrastructure, not marketplace agents:

1. Admin issues a hashed registration token for trusted broker infrastructure.
2. Broker registers an internal advertised URL and reports a supported broker
   type using that token; Core validates the type against its allowlist.
3. Core issues an in-memory mint secret and lease. Registration tokens are
   stored hashed; plaintext mint secrets are not persisted.
4. Lease-fenced heartbeats maintain availability. Missing Core mint cache
   triggers re-registration; authorization failures evict stale mint secrets.
5. Routing picks an idle, fresh broker of the matching type with a cached secret.
   No usable broker means fail closed, never send raw Brokered credentials.

The URL guard requires HTTP on permitted private/internal hosts: loopback,
RFC1918, single-label network aliases, or internal/local suffixes; public URLs
are rejected. Do not expose broker observed IPs through listings.
Core-to-broker requests use the per-broker Bearer mint secret.
Broker health endpoints are not authorization to mint.

Auth Session requires both login references to be Brokered auth-session
credentials or neither; mixed pairs are configuration errors. Arbitrary
Runtime use of an auth-session credential is rejected. The daemon is forced
into storage/session mode when the immutable session-injection stamp exists.
Permanent login credentials never appear in the agent's secret payload.

REST executes only the authorized frozen leading setup operation. Core resolves
its credential references and constrains any allowed phone-number variable;
the agent cannot redirect the credential-bearing request via arbitrary overrides.
Responses/errors are scrubbed and bounded.

Broker environment includes `BROKER_REG_TOKEN`, `VOX_CORE_URL`,
`BROKER_ADVERTISE_URL`, optional `BROKER_NAME`, and `BROKER_PORT`. Each broker
binary reports its own fixed type (`auth-session` or `restful`), not an
operator-supplied `BROKER_TYPE` environment variable.
The old `SESSION_BROKER_URL/SECRET` addressing is retired. Cached mint
credentials are process-local; multi-Core broker-cache behavior remains an
infrastructure concern separate from database-backed trial quotas.

## 8. Redaction and Runner Boundaries

Never deliberately log/persist secret values in diagnostics, job errors,
results, or uploaded artifacts. Redact the values actually used, including
raw/YAML-escaped/URL-encoded forms and individual multiline lines.
The agent redacts streamed aeval output and all job errors in one place.

Scrub text artifacts by content, preserving bytes outside replacements.
Scan non-audio binaries fully, including chunk boundaries; delete a binary
containing a secret. Failure to check/rewrite/remove a file prevents upload.
Recognized recordings are excluded from random-byte scanning; this is not a
promise to remove secrets spoken in audio. Temporary filled YAML uses mode
0600 and is removed after execution.

The target platform, agent operator, and external DialF host can inspect
execution data on their own systems. Runtime delivery inherently trusts the
authorized machine; redaction cannot protect secrets from that machine.

Clash Runner is a separate execution surface, not a Shared-eval policy bypass.
It authenticates its own `cr...` token, requires the assigned running
match, resolves match -> event -> event owner, and fills profile setup values.
Eval Agentd uses an `ev...` token and the job's frozen flow scope instead.
Brokered values are withheld from raw runner payloads. Changes to one runner's
authorization must not silently grant access through the other.

## 9. Secret Management UX

Remove the "Dedicated test account" checkbox as an access gate. Keep legacy
metadata compatible, but use contextual guidance: limited test accounts,
minimal scopes, provider spending controls, and the real session/Runtime
exposure. A self-declaration does not verify isolation.

Every personal/org secret Delete action opens a name-and-scope confirmation.
Cancel is initially focused. Opening, canceling, or dismissing sends no delete.
Only explicit confirmation issues a request; disable repeat submissions while
pending. On failure, retain context and show the error. Do not silently delete
dependent flows/schedules.

Personal deletion is owner-only, with no global-admin bypass. Organization
deletion requires secret-management permission in that exact organization
(owner/admin), not ordinary membership, flow-running rights, or an admin role
outside it. Server authorization is required independently of UI confirmation.

## 10. Persistence, Rollout, and Verification

`0066_credential_trials.sql` is registered as Core schema version 67. It adds
per-flow limits, credential-scope trial policies, and durable trial usage with
submission uniqueness and flow/caller/time indexes. Use normal migration
execution, never `db:push`, for deployment. Apply migration before the new app.

Code responsibilities:

- `shared/credential-trials.ts`: defaults, input validation, allowance response.
- `server/credential-trials.ts`: durable accounting, locks, immutable trial auth.
- `server/credential-policy.ts`: ownership/tier matrix.
- `server/permissions.ts` and `server/storage.ts`: pure and SQL claim mirrors.
- `server/auth-session.ts`: secret gate, trust, least-privilege release.
- `server/routes.ts`: flow limits, run admission, targets, credential endpoints.
- `server/routes-api-v1.ts` and `server/scheduler.ts`: strict owner paths.
- `client/src/components/flow-trial-limits.tsx`: shared create/edit controls.
- `client/src/components/run-credential-notice.tsx`: shared run guidance.

Required regressions cover own Private/Shared Runtime and Brokered delivery,
third-party Shared hard rejection of Runtime (including old consent and REST),
targeted session consent, organization boundaries, pure/SQL claim equivalence,
5/80 defaults, custom/zero/invalid limits, owner permissions, rolling windows,
concurrent admission, independent flow quotas with a shared owner budget,
idempotency, ownership transfer, deletion without refund, and UI confirmation.

### Verification and Operator Handoff

Run `npm run check` and `npm run build` before rollout. The isolated PostgreSQL
and HTTP contracts in `tests/credential-policy-integration.test.ts` migrate a
fresh `vox_test_credential_policy_<pid>` database; supply a local maintenance
`DATABASE_URL` whose account may create test databases. Never use production.
Policy/allowance/design tests run without a database. Browser tests in
`tests/e2e/credential-policy.spec.ts` mock account APIs and use
`PLAYWRIGHT_BASE_URL` for a dedicated local Vite server.

The rollout procedure and post-deploy checks are maintained in
[`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md#credential-policy-rollout-schema-67).
Existing agents keep their protocol; this change requires no daemon upgrade.
Keep the encryption key, broker registrations, organization plugin and secret
classifications unchanged. Verify owner and third-party paths independently;
successful dispatch alone does not prove safe credential delivery.

Upgrade compatibility does not grandfather credential authorization. The
scheduler disables an existing schedule whose credentials no longer match its
Private/Team pool; its owner must correct the pool and explicitly re-enable it.
Legacy pending/in-flight jobs must satisfy the new delivery checks, including
durable trial admission for borrowed credentials. Drain/review incompatible jobs
before rollout rather than synthesizing authorization records. Organization
provider absence/outages remain temporary skip conditions, never a reason to
disable schedules.

No deployment, production credential changes, blanket schedule resumption,
or automatic borrowing opt-in is authorized by this document. Future work:
provider-cost measurement, exact next-capacity timestamps, cross-owner BYOC
binding, paid Shared pooling, and broker geo-routing.

## 11. Consolidated History

This document incorporates and supersedes the active policy in:

- 2026-08-20 secret-class Protected/Runtime design: the old Runtime consent
  bypass is replaced by the owner-only exception and third-party hard block.
- 2026-08-21 broker registry design: preserves dynamic internal broker trust;
  current capabilities include REST as well as Auth Session.
- 2026-08-24 tier targeting design: preserves targeting and queue invariants;
  the former blanket Mainline-session ban is removed.
- 2026-09-29 secret substitution design (PR #195, decisions #200/#203):
  preserves eval-set trust, least privilege, and redaction.
- 2026-11-05 agent credential/trial discussion: defaults changed from 3/10 to
  5/80, keyed per flow and owner-configurable; own Shared agents may use their
  owner's personal Runtime and Brokered credentials.

Old design paths remain links here for bookmarks. Historical implementation
plans are archives; do not apply their old permissions as current policy.
