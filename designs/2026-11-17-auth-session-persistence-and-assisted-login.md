# Encrypted Account Sessions And Assisted Login

Status: Vox implementation and validation complete for PR #285 against released aeval v0.5.1.
Updated: 2026-11-23. Runtime and Brokered live two-host qualification passed with
the ElevenLabs provider-profile correction below. Not deployed to production.
Coordination: [Vox #284](https://github.com/Agora-Build/Vox/issues/284) and its
[current owner contract](https://github.com/Agora-Build/Vox/issues/284#issuecomment-6957046486).
v0.5.1 supersedes the comment's old v2 identifier with `schema: auth.checkpoint.v3`;
there is no v2 alias or negotiation.

This is the maintained implementation design. Credential ownership and agent
eligibility remain governed by [Agent Credentials](agent-credentials-design.md).
The browser UI/authority contract is in [Live Browser Assistance](../docs/browser-assistance.md).
The engine's consolidated design remains
`docs/specs/2026-11-10-browser-assistance-and-evalflow-recording.md` in aeval.

## 1. Decisions

Both Runtime and Brokered account sessions persist encrypted in Core's database.
Use the existing `CREDENTIAL_ENCRYPTION_KEY` and AES-256-GCM; never give that key
to an agent or broker. All replicas and deployments must retain the same key.
An undecryptable state is an operational recovery error, not permission to
replace it with a new state. Database backups need the matching encryption key.

Plaintext exists only in authorized memory/network operations and private,
temporary working files. No persistent agent auth volume, host key file or
extra agent environment setting is required. Image upgrades, compatible
rollbacks and eligible host changes reuse Core state, subject to the provider's
own device/IP restrictions.

| Setup | Credentials at execution | Session behavior |
| --- | --- | --- |
| Runtime account, explicit nonempty storage_file | Email/password still reach an eligible eval agent. | Vox restores authorized Core state to a private path; aeval tries it before account login and publishes confirmed checkpoints. |
| Runtime account, no explicit storage_file | Existing Runtime credential rules. | Previous account behavior; no automatic Core persistence or default-file discovery. |
| Brokered account | Email/password remain in Core/trusted broker infrastructure. | Trusted broker restores/revalidates state first, then logs in only when necessary. Agent receives state only and stays storage-only. |
| Storage-only | No new credentials or account fallback. | Existing behavior, including Brokered injection, is unchanged. |

Only account authentication is supported. Do not cache arbitrary Runtime
variables, API keys, REST credentials, environment maps or browser profiles.
The initial provider profile is ElevenLabs. Adding another provider requires a
reviewed cookie/origin profile and engine/integration qualification, not new
provider-specific Core endpoints or login automation.

Runtime persistence currently binds one unambiguous top-level platform setup
with scoped email/password secret references. Ambiguous/multiple setups and
literal credentials do not gain Core persistence. Explicit Runtime account
files are still isolated per invocation, rather than reusing a shared container
path. Existing unscoped/default files are not discovered, imported or uploaded.

## 2. Implementation Ownership & Contract

| Area | Vox | aeval v0.5.1 |
| --- | --- | --- |
| Persistent state | Encrypt, authorize and isolate owner/org/provider/tenant/credential revision/source. | No Core database or encryption key. |
| Execution identity | Generate a unique expected session ID per engine invocation; bind it to current job claim or broker mint. | Accept --session-id and propagate the identity. |
| Working file | Map logical storage_file to an absolute private temporary path outside artifacts; supply prior state and clean up. | Preserve the explicit path and derive its checkpoint sidecar. |
| Restore/account fallback | Keep Runtime account mode; do not retry whole jobs or emulate fallback by mode switching. | Restore and validate first when account storage_file is explicit; missing/corrupt/positively rejected state falls back within that setup. |
| Checkpoints | Lock/copy immutable snapshots; authorize and commit encrypted state plus an idempotent receipt. | Confirm authentication and publish snapshot, working file and ready record in that order. |
| Additional credentials | Require authorized controller and explicit current-stage consent. | Recognize provider stages, consume one stage token and fence the credential destination. |
| Provider extensibility | Provider-neutral transport and storage with reviewed scope profiles. | Shared lifecycle plus provider definitions/adapters; unknown stages stay human-assisted. |

Only generic `--session-id` is added to launch. Browser-control socket and
bounded assistance timeout are independent. Do not add `--auth-setup-id`,
`--auth-checkpoint-dir`, `--client-protocol`, `--auth-checkpoints` or legacy
translation. Correlation IDs are not authorization.

## 3. Runtime Pipeline

```text
active claimed job + current eligible agent
  -> Core resolves frozen setup, current secret rows and credential revision
  -> authorized read + database refresh generation + short-lived scoped grant
  -> agent writes prior state to private 0600 file under a 0700 root
  -> aeval account setup restores first; account login only when needed
  -> confirmed immutable checkpoint, independent of later evaluation outcome
  -> exact snapshot upload; Core reauthorizes and commits encrypted state + receipt
  -> terminal snapshot reclamation; final flush; private-root removal
```

Each chunk is a separate engine execution with its own expected ID/private root.
The previous chunk's committed state can be restored by the next one.
The configured `.auth/elevenlabs.json` is a logical opt-in, never authority to
read another account's container file.

Runtime endpoints under `/api/eval-agent/jobs/:id/account-session`:
POST prepares restore/refresh authority; POST `/checkpoints` uploads a v3 record
and exact state bytes; POST `/release` releases the current refresh fence.
Bearer agent token, current lease, running claim/start stamp, frozen owner,
current secret classes/revision and current eligibility are checked.
The original Runtime secret response carries a non-secret
`X-Vox-Account-Revision` marker derived from the same locked ciphertext rows as
the delivered account pair. Prepare must match that revision through both read
and refresh claim; rotation after credential delivery cannot mix old credentials
with a new cache binding. Without the marker the private invocation can still
run, but does not restore or upload Core state. Agents do not send passwords
back to Core for persistence; grants contain no credential values.
The upload grant is authenticated/encrypted, bounded to the execution and
deadline, and cannot be reused for another job, credential revision or source.

A cache outage/unsupported setup does not invalidate an otherwise authorized
Runtime evaluation. The private account file starts empty and aeval can perform
normal account login; no persistence grant means no upload. Do not erase last
good state or discard an authorized evaluation result on cache failure.

## 4. Brokered Pipeline And Canonical State

```text
Core derives current scoped Brokered binding
  -> claim web_sessions mint and record current broker lease/operation/deadline
  -> validate existing encrypted canonical state; claim refresh generation
  -> route small mint command + scoped grant to connection-owning Core/broker
  -> broker fetches prior state directly from Core /account-session/restore
  -> aeval account restore/login + independent immutable checkpoint
  -> broker pushes checkpoint to any Core replica; database fence + atomic receipt
  -> Core observes committed receipt and marks mint ready
  -> authorized eval agent receives only canonical state in storage mode
```

`account_sessions` is canonical for checkpoint-managed providers.
`account_session_checkpoints` contains scoped idempotency receipts.
`web_sessions` retains mint status/browser routing and `account_session_key`,
not a second independently writable copy. The older cache is not silently
imported into this stronger binding. Providers outside the reviewed profile
retain their existing broker path and do not gain this new lifecycle.

Broker endpoints `/api/brokers/account-session/{restore,checkpoints,release}`
require Core's short-lived mint-scoped grant. Its binding includes broker lease,
mint claim/start, operation, source and expected engine session. Engine records
and caller-supplied IDs alone grant nothing. Agents cannot write Brokered state.

Large restore/checkpoint payloads go directly between broker and authorized Core
endpoints. They do not raise the general inter-Core command limit. Core routing
still selects whichever replica owns the broker connection. Session persistence
works with one Core or multiple replicas sharing database/encryption settings.

A failed preview does not undo an already committed authentication checkpoint.
Core decides persistence from the database receipt, not a mutable final file,
exit code or returned storageState. A mint without an accepted checkpoint cannot
claim success in the new path. Cache age triggers prior-state revalidation, not
unconditional password login. Broker login remains bounded by the existing
600-second maximum; viewing never extends that deadline.

## 5. Scope, Revocation And Concurrent Writers

Cache identity includes personal owner XOR organization, source, platform,
reviewed provider tenant/origin and credential revision. Revision hashes current
row identities/names/classes and randomized ciphertext, never a low-entropy
plaintext password or just secret names. Rotation/deletion/recreation invalidates
the old binding. Runtime-derived state never becomes Brokered by being persisted.

Runtime delivery requires Mainline, the personal owner's own Private/Shared
agent, or an eligible same-organization Team agent. Third-party Shared agents
require Brokered state. Current caller ownership or valid trial admission is
checked separately; an agent lease is not spending permission.

Every store operation obtains live authority under a database transaction and
reauthorizes before commit. Job/agent/token/user/secret/mint rows are locked as
appropriate. Generation and refresh-owner checks reject late/out-of-order saves.
Receipt and encrypted state commit atomically. A historical receipt acknowledges
its original save but never restores old state over a newer generation.

Organization reads stay behind the provider seam. The bundled organizations
provider advertises `accountSessionFencing: postgres-advisory-v1` and takes
same-database transaction advisory locks for membership and secret mutations.
Core holds corresponding shared locks while reading through the seam and
committing session operations. The provider's `accountSessionReader` performs
read-only, schema-qualified membership/secret queries on Core's existing fenced
transaction connection, without acquiring another pool slot or altering its
search path. Core never names plugin tables or performs plugin writes. A
provider lacking either the fencing or transaction-reader contract fails closed
for org/Team session authority; personal flows on their own Private agents do
not need org reads. A future external provider needs equivalent revocation
fencing and a non-blocking authority-read contract.

## 6. Immutable File Contract And Retention

Canonical database sessions have a 30-day inactivity window. Authorized,
validated restores and refresh operations renew it; failed/unauthorized reads
do not. Core sweeps at startup and every minute, deleting at most 500 inactive
sessions per batch while preserving unexpired refresh claims. Session deletion
cascades its receipts. A separate 500-receipt batch expires receipts older than
30 days even when the session remains active. Row locks and `SKIP LOCKED` allow
multiple Core replicas to sweep safely. Cleanup does not require credentials,
an encryption key or a live organization provider, and covers old revisions and
orphaned org scopes. Idle sessions may require reauthentication after 30 days;
provider cookie validity remains independent of this retention policy.

An undecryptable state remains fail-closed. Restore the original Core encryption
key first; if recovery is impossible, an authorized operator may reset only the
verified binding and its matching `web_sessions` metadata with jobs/mints stopped.
See [deployment recovery](../docs/DEPLOYMENT.md#account-session-retention-and-recovery).

Example Vox-owned file layout:

```text
/tmp/vox-account-sessions-<uid>/run-<uuid>/     # 0700, lifetime owner.lock
  storage-0.json                           # Runtime; broker uses session.json
  storage-0.json.checkpoints/              # 0700
    .writer.lock
    snapshots/<session_id>/<snapshot_id>.json
    ready/<session_id>/<sequence:010d>-<snapshot_id>.json
```

Exact v0.5.1 record:

```json
{
  "schema": "auth.checkpoint.v3",
  "session_id": "vox-40112-run-01",
  "snapshot_id": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "sequence": 1,
  "snapshot": "snapshots/vox-40112-run-01/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json",
  "storage_format": "playwright.cookies-localstorage.v1",
  "byte_length": 1234
}
```

Reject old/unknown schemas, unexpected identities, duplicate/unknown fields,
unsafe traversal/links/types/permissions, mismatched lengths and unsupported
cookie/origin scopes. Cookies must be secure and unpartitioned; storage origins
must be canonical approved HTTPS origins. No arbitrary Runtime maps.

aeval holds the exclusive writer lock through snapshot -> working file -> ready
publication. Vox takes a real nonblocking shared lock while validating/copying
exact immutable bytes, releases it before network calls, and reclaims terminal
snapshots under an exclusive lock. A busy lock defers a scan. No unlocked fallback.
The consumer requires Linux procfs/POSIX descriptors and util-linux flock, supplied
in the images. Windows/network filesystem behavior is not qualified.

| Resource | Bound |
| --- | --- |
| Discovery | Approximately once per second, plus final scan after engine exit. |
| Snapshot | 2 MiB. |
| Pending outbox | 32 snapshots / 16 MiB. |
| Retained ready records | 1,024, at most 4 KiB each. |
| Pending plaintext | Ten minutes from local discovery, shortened by authority/deadlines. |
| Final flush | At most five seconds; release call has a separate one-second bound. |

Unknown upload/commit responses retry identical snapshot identity while
authorized. Only a matching Core receipt is persisted acknowledgment. Terminal
outcomes remain separate from evaluation results. Ready records remain until
root cleanup to preserve sequence/manifest semantics.

Success, failure and cancellation finalize private files. Shutdown waits for
bounded engine/session finalization; broker writers stop before root removal.
Private lifetime locks prevent the crash sweeper deleting a live workspace.
Startup and minute sweeps reclaim manager-created inactive private roots older
than one minute, without uploading leftovers. SIGKILL/power loss cannot run normal
cleanup; official container replacement clears the old process tree. Prefer
tmpfs; it is not assumed and may use swap. No secure-erasure guarantee or
protection from a compromised same-user/root host administrator is claimed.

## 7. Staged Assistance And Privacy

Ordinary `assistance.continue` (Check & continue), passive checks, viewer release
and disconnect never submit credentials. Recognized additional forms expose
safe stage_id/page_id/stage_token status. Explicit Sign in & continue sends
`authentication.continue` with session/browser/lease/selected-document/wait and
stage fences. aeval chooses its tracked stage destination and consumes one grant.
Unknown stages remain human-assisted; no generic form guessing or automatic retry.
The selected viewer tab does not decide where credentials are submitted.

ElevenLabs is the initial multi-stage provider. New providers use the same
shared engine lifecycle with reviewed definitions/adapters; no ElevenLabs-only
Core endpoint, credential exception or UI branch is needed.

Private sessions/grants never enter ordinary request-body/response logging,
screenshots, reports, diagnostics, traces or artifact archives. Endpoint replies
are no-store and body-size-bounded. aeval v0.5.1 suppresses authentication console/
network diagnostics and masks exported credentials; Vox retains existing secret
redaction and keeps working files outside artifacts. Authorized live viewer
frames remain sensitive and follow the separate browser-access policy.

## 8. Code And Validation

Core: account-session-binding/store/service/broker, routes-account-sessions,
schema/migration 0071 (runner version 72), current broker serving/authorization.
Agent/broker: account-checkpoints, account-session-runtime, account-workspace,
per-engine IDs, broker grant restore/checkpoint transport and bounded cleanup.
Shared: strict v3 records, duplicate-key/state validation, reviewed provider scope
and frozen-job setup parsing. Existing storage-only injection is unchanged.

Focused tests exercise encryption/atomic receipts, two-store concurrency,
unknown commit responses, stale generations, token/lease/claim revocation,
credential rotation, owner/org/source isolation, unsafe files/locks, plaintext
bounds, finalization and ordinary browser-assistance/staged consent.

The real released Linux x86_64 v0.5.1 binary + Chromium fixture
`scripts/test-account-session-persistence.ts` exercises the actual Core HTTP,
PostgreSQL, Runtime adapter, trusted broker and immutable file consumer. It checks
that confirmed authentication survives subsequent evaluation/preview failure,
that later Runtime jobs and Brokered refreshes restore with no new credential
submission, and that state is encrypted/source-isolated, private roots disappear
and password/session canaries stay out of artifacts. It runs only in an isolated
container with a local synthetic HTTPS provider and no external network.

Focused gates: 287 persistence/security tests, 210 browser-assistance
tests, 17 legacy broker tests, 17 migration tests, 10 independent-Core routing
tests and 15 browser UI tests passed. Both actual Docker targets, production
build, production/test/script type checks, focused lint and whitespace checks
passed. These are not live-provider results.

Full-repository validation on 2026-11-23 used disposable Docker/PostgreSQL
instances, the built Core, read-only shared dependencies and separate test
databases for destructive plugin fixtures. Existing dev services and production
were not used or changed.

| Gate | Result |
| --- | --- |
| Entire Vitest discovery, including DB/HTTP integration and migration tests | 4,129 passed; 78 opt-in/environment-dependent tests skipped; zero failures. |
| Notification automation and local GeoIP data, separate opt-in run | 21 passed. |
| Personal billing integration with mocked payment/email providers, separate disposable DB | 21 passed. |
| Manager permission checks that root skips, separate non-root container | Two passed. |
| Entire Playwright discovery | 288 passed; 36 skipped; zero failures or flaky tests. |
| Personal Usage opt-in browser suite, including real Core TOTP enrollment and protected grants | 20 passed; zero skipped, failures or flaky tests. |
| Clash audio pipeline in a disposable container | 29 passed; zero failures. |
| TypeScript, packaging-test lint and whitespace checks after the test correction | Passed. |

The additional runs cover 44 of the Vitest skips and 20 of the Playwright skips:
4,173 distinct unit/integration checks and 308 distinct browser cases passed.
The remaining 34 Vitest skips require real Agora credentials or S3/analysis
infrastructure. The remaining 16 browser skips are two manual Google OAuth
cases, two S3/analysis cases, and twelve existing fixture gaps: eleven Run Your
Own cases and one job snapshot case. The Run Your Own setup still submits the
obsolete eval-set `framework` field and lacks a built-in fixture; the snapshot
case has no existing job in the fresh database. These skips are not coverage.

The first full run exposed a packaging-test fixture that only recognized
single-source Dockerfile `COPY` instructions. It now recognizes multi-source
TypeScript copies and explicitly asserts all account-session modules are
bundled without Core code. The actual Docker images already built successfully.
Missing OAuth fixture settings, a Chromium-cache mount and a real daemon-health
fixture were corrected only in the isolated harness; production behavior and
test expectations were not weakened. The complete Vitest rerun passed.

The engine advertises development authentication capabilities with an empty
providers map; a version pin or component capability alone is not provider
qualification. The seven account/multi-stage synthetic cases and 15 browser UI
cases remain separate upgrade coverage. Live ElevenLabs qualification is recorded
below. ARM64 execution, native audio hardware and production deployment are not
covered by these results.

### Live Acceptance Gate On 2026-11-23: Passed

The owner authorized a real ElevenLabs account, supplied its verification link
and approved the current machine plus the separate Volumetric SSH host. Tests
used a disposable Core/PostgreSQL instance, fresh encryption keys, real Runtime
and trusted Brokered adapters, the released x86_64 v0.5.1 engine and Chromium.
Authentication-only flows stopped after `platform.setup`; no provider
conversations or evaluation calls were started.

#### Provider Correction Required

The stock v0.5.1 ElevenLabs profile matched its email-only credential stage on
the email-verification page: that page retains the email input beside a Resend
button. Live runs failed before assistance with `AUTH_STAGE_CHANGED` or
`AUTH_BROWSER_OPERATION_FAILED`. The runtime-data profile now requires the
actual Sign in button when matching the email-only stage. Other stages and
credential submission rules are unchanged. The seven packaged-engine regression
scenarios now include retained-email verification and use the shipped email
stage selector, rather than a duplicate synthetic selector.

The passing live tests used the same tested image on both hosts with this
corrected provider profile mounted read-only. They do not qualify the original
stock profile. Vox now pins published runtime-data commit
`51c0c810e5716c6edbf3c7bc3d8cc1ebad567cfe`, whose provider YAML is byte-identical
to that qualified file; no unpublished nested patch is required. Upstream
[published the regression results and release handoff](https://github.com/Agora-Build/Vox/issues/284#issuecomment-7094992183).
The v0.5.1 tag moved from `c88fb57` to `51c0c81`; binary assets and their
checksum manifest remain unchanged. Vox pins the full commit, not the movable
tag, and retains the tested binary checksums. The only other runtime-data
changes between these commits are release notes.

After pinning the published commit, both daemon and broker Docker targets were
rebuilt successfully. Their embedded ElevenLabs YAML hashes match, and their
x86_64 engine hashes match the original tested checksum and GitHub's current
release-asset digest. All eight release-pin/packaging checks and seven packaged
account scenarios passed against the published pin; the latter ran without a
provider-file override. No additional live verification was needed because the
published provider file is byte-identical to the one qualified above.

#### Observed Results

| Path | Host A: fresh account login | Host B: new execution on Volumetric |
| --- | --- | --- |
| Runtime | Real email verification completed through the private browser; explicit current-stage credential continuation succeeded; exit 0 and one committed checkpoint. | Restored through Core; exit 0, zero credential submissions, no assistance/verification prompt and one committed checkpoint. |
| Brokered | Fresh trusted-broker mint submitted credentials once; no additional email challenge was required; ready with one committed checkpoint. | Forced cache expiry and a new broker/lease; restored through Core; exit 0, zero credential submissions, no assistance/verification prompt and a second committed checkpoint. |

Runtime verification also confirmed that ordinary `assistance.continue` returns
`AUTH_CREDENTIAL_CONTINUATION_REQUIRED` on the post-verification sign-in form
without submitting credentials. One explicit `authentication.continue` action
then completed the recognized current stage. The additional verification link
was not consumed.

No raw storage file, browser profile or auth volume was copied between hosts.
Host B fetched authorized state from Core over loopback-only SSH forwarding.
Runtime and Brokered used separate disposable databases/keys and each ended
with one encrypted canonical state plus two atomic receipts. Brokered
`web_sessions` contained no second mutable storage-state copy. Credentials
remained within Core/trusted brokers for that path. Completed private workspaces
were removed, and only sanitized counters/results are retained in this design.
After qualification, the disposable test databases, Core/broker processes and
SSH tunnels were stopped. Task-private token files, account screenshots and
remote bootstrap directories were deleted; no shared development or production
service was changed.

These tests exercised the actual engine private-browser protocol and Vox
persistence adapters through a private test harness, not a deployed production
Vox UI. Automated browser tests cover the UI separately. Provider policy may
still require a new-device/IP challenge on future runs; restoration is not a
promise to bypass a provider's security controls. No production deployment or
issue closure is implied by this qualification.

## 11. PR Review Resolution And Final Rerun (2026-11-23)

PR #285 review identified missing database retention, unawaited daemon
supersession cleanup, and broker binding/read failures that lacked terminal
agent feedback. These are fixed: bounded 30-day retention with replica-safe
locking and read touches; awaited bounded shutdown; recorded failed mints even
for invalid bindings; safe no-store 403/503 serve responses; and exact-binding
undecryptable-state recovery instructions. Parent-before-receipt locking avoids
inverting the save/cascade order. Restore holds its row lock until its inactivity
touch commits, preventing a concurrent sweep from deleting the restored state.

The second review identified a same-pool connection-starvation cycle: Core held
one connection while its organization-provider reads attempted to borrow another.
The provider now supplies read-only, schema-qualified `accountSessionReader`
operations using the caller's already-fenced connection. No plugin writer or
search-path change is introduced, and missing contracts fail closed for org/Team
authority. Four real-database regressions occupy every pool slot before releasing
simultaneous authorization, covering personal/org and Runtime/Brokered flows;
they complete without a second checkout. Existing mutation-fence tests still
pass. A transient binding lookup failure also preserves an otherwise fresh
web-session row instead of needlessly discarding it.

The final unchanged implementation passed the full Vitest discovery again:
**4,162 passed, 78 skipped, zero failures** across 224 passing files and six
skipped files. This includes the final restore-versus-retention interleaving
regression. The isolated affected suites separately passed **241/241** checks,
including real PostgreSQL, two Core stores, unsupported organization fencing,
disabled/deleted credentials, safe route errors, single-flight retention and
execution of the actual daemon supersession method without its CLI entrypoint.
Production build, Core/daemon TypeScript, explicit test/script TypeScript and
focused lint passed (no lint errors; existing console warnings remain in larger
legacy modules). Migration 72 was exercised against fresh disposable databases.
The earlier opt-in, browser, audio, packaged-engine and live two-host evidence
remains as recorded above; those external/opt-in suites were not rerun for these
server-side review corrections. No additional provider login was performed.
