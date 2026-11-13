# Live Browser Assistance

Vox integrates aeval v0.4.4's private inspection protocol into the existing
evaluation job page. It views the **already running browser**; it does not launch
a second login, replay a scenario, expose CDP, or move Brokered passwords onto
an eval agent. The binary and runtime-data submodule are pinned to the same
release, with architecture-specific binary checksums.

## Using It

1. Open an active web evaluation's job page. **Open browser** appears when an
   authorized, supported browser is available, including a broker-side login.
2. The view starts **read-only**. Viewing does not pause automation. Tabs show
   origins, never full URLs, page titles, cookies, or browser storage.
3. Multiple authorized viewers share one live capture. The header shows the
   viewer count and whether you or another viewer has control. At a supported
   authentication, element, or URL wait, explicitly choose **Take control**.
   Exactly one viewer may control the browser. Mouse, dragging, wheel, typing, paste, and a native text
   field for touch keyboards are supported. Coordinates use the original CSS
   viewport; the evaluated page is not resized to fit the viewer.
4. Only the controller can switch the shared tab, open verification links,
   send input, or check/continue the evaluation. A verification link can open a new tab in the same browser context. Tabs
   share cookies; the original login page remains intact. Navigation and tab
   selection revoke control. Refresh status and explicitly take control again.
5. **Check & continue** releases input and checks the original readiness
   condition. It does not resubmit the login or retry a failed step. The normal
   job result remains authoritative.
6. **Release control** revokes input and resumes automation without closing
   other viewers. It uses aeval's native release operation: it ends the current
   assistance hold, rather than reserving it for another viewer. A viewer can
   explicitly take control again at a subsequent supported wait. There is no
   forced takeover or automatic control transfer.
7. **Close view** detaches only your viewer. Backgrounding the Vox tab also closes its view.
   A disconnect/expiry/revocation of the controller releases input and the hold;
   other authorized viewers keep watching. The last viewer leaving stops capture.
   If a command's outcome is unknown, inspect the page before a fresh action;
   it is never automatically replayed. A retained receipt may be queried while
   the same viewer lease is still alive.

There is no recording, preparation-action recorder, generated eval flow, LLM
interaction, arbitrary JavaScript, or general action retry in this release.
Phone evaluations and Tools > Analyze do not have a live browser viewer.

## Authority Is Stronger Than Job Visibility

Live authenticated pages can contain credentials and account data. Both viewing
and control require a signed-in, enabled **browser-session user**:

- Personal flow: the same user must be the **frozen flow/credential owner AND
  the job launcher** (`job.createdBy`). Neither ownership alone nor launching
  alone is enough. A borrowed personal run exposes no live browser to either
  party, even when its automatic credential use is authorized.
- Organization flow: an **owner/admin of that exact organization**, using the
  existing organization secret-management predicate. Its managers need not
  have launched the job. An ordinary member cannot view or control the browser,
  even if they created the flow or launched the job. Flow and credential scope
  come from the frozen job snapshot; membership and management roles are live.
- Public visibility, operating an agent, and global-admin moderation are
  **not** browser authority. Missing personal launch identity fails closed.
- API keys do not authorize these endpoints.

Agent targets must also meet the existing **Runtime-credential trust policy**:
Mainline agents, the personal owner's own Private/Shared agent, or a Team agent
whose token operator currently belongs to the frozen organization. Third-party
Shared agents cannot offer a live browser, even with brokered-session sharing
consent: an operator could spoof a login frame and capture typed credentials.
This gate does not block a broker's independently trusted login-mint browser.
Agent-advertised capability alone is never sufficient.

The same eligibility rule grants viewing and the ability to explicitly request
control; there is no wider job-visible spectator role. All admitted views start
read-only, and only one admitted viewer may hold control at a time. Existing job
result visibility and job-cancellation permissions are unchanged.

Current user, credential-use authorization, job state, token revocation, agent
lease, claim timestamp, and broker mint operation are checked on each request.
Changed authority or execution invalidates that viewer. If it was the controller,
its control is released; capture stops when no authorized viewer remains. The
owner also rechecks live grant authority during lifecycle cleanup, not just when
the viewer sends requests. No frame is returned after a failed authorization check.
Origin checks include scheme and host. Across HTTP proxy hops behind HTTPS,
browser-set `Sec-Fetch-Site: same-origin` plus an exact HTTPS Origin/Host match
is accepted without trusting a rewritten forwarded scheme. Cross-site/same-site
metadata alone does not authorize access; clients without this browser metadata
still need the forwarded protocol to match. Responses use `Cache-Control: no-store`;
browser paths and payloads are excluded from request logging. Browser command
bodies are limited to 16 KiB and have a separate per-session production rate
limit of 6,000 requests/minute/user, with headroom for ten viewers' polling plus
input/control. Viewer admission remains bounded to 10/target and 100 globally.
Anonymous requests retain the general limiter.

## Routing And Lifetime

The browser UI uses session-authenticated HTTP commands, one-second
heartbeat/status polling, and latest-frame polling at up to five fps. This is
a low-bandwidth inspection view, not a video stream or audio player.

- **Eval agent:** an outbound authenticated WebSocket at `/ws/eval-browser`
  carries commands and transient frames. The registration token and current
  process lease authenticate it. Every operation also names the job and its
  `startedAt` claim identity. There is no inbound browser/debugging port.
- **Brokered login:** Core persists a random operation ID, broker ID and outer
  deadline on the existing mint row, fenced by `mintStartedAt`. The authenticated
  internal broker `/browser` endpoint reaches that operation's actual browser.
  It never returns raw login credentials to the eval agent. A ready/reclaimed/
  expired mint is not an active browser target.
- **Engine:** each process has a short, private Unix socket path in a mode-0700
  directory outside exported artifacts; the socket is mode 0600. A single reader
  demultiplexes replies and frames, including frames arriving before the open
  response. Only the latest frame is retained.

The owner-Core's modular capture coordinator owns one engine lease per target,
distinct from individual viewer grants. The engine expires it after five seconds
without frontend-originated heartbeats. Each viewer grant has a separate six-second
inactivity bound; one viewer's heartbeat cannot renew another viewer's grant or
control. Core/adapter upstream inactivity is also bounded to six seconds.
Status-only availability checks do not open capture or renew grants. Last-viewer
close/revocation uses immediate engine close. Connection loss cannot preserve
indefinite capture. Reconnect starts read-only and requires fresh explicit control.

Commands are serialized by the owner. Heartbeats have a separate, coalesced
liveness lane so a slow navigation/status request cannot let the engine lease
expire; each grant is still renewed only by its own authorized HTTP requests.
Per-viewer request/receipt IDs are translated
to unique engine IDs, so a viewer cannot query another viewer's action receipt.
Spectator requests are rejected before dispatch even if they supply a controller's
token. Shared frames are cached briefly (180 ms) and fanned out; polling by one
viewer cannot consume a frame before the others see it. Shared tab/document state
and monotonic response revisions keep spectators aligned with controller navigation.
Only the latest frame is retained, not a frame/event history. Uncertain mutations
or an unconfirmed control release fail closed and may require everyone to reopen.

Frame polling checks session/grant binding on the receiving Core and fresh
user/job/credential/target authority at the owner, including cached-frame reads.
A slow engine capture is checked again before its frame is returned. Authorization
is never cached with pixels. This avoids duplicate full receiving-Core checks and
controller reconciliation at frame rate; commands, heartbeats and one-second
maintenance retain their own checks and controller lifecycle work.

Input/navigation use unique opaque request IDs, ordered sequences, and page /
document / browser-generation fences. Input queues are bounded; move/wheel
traffic is limited rather than accumulated behind slow acknowledgements. A
transport timeout, expired lease, or `OUTCOME_UNKNOWN` never authorizes replay.
Request history is engine-local, not an exactly-once guarantee across crashes.

### Deadline Budget

The local assistance hold is **60 seconds per supported wait**, absolute and
non-renewable. Viewing alone does not start or extend it. Existing outer limits
remain in force: broker mint default 180 seconds, configured ceiling 200 seconds;
Core abort +15 seconds and stale reclaim +30 seconds; daemon mint poll 240
seconds. The earliest deadline wins. The UI shows the remaining local hold and
warns that job/login deadlines still apply. A ten-minute broker verification
window requires a separately coordinated deadline change; this release does
not promise one.

### One Core Or Multiple Replicas

An agent WebSocket and each broker's mint key remain in the memory of the Core
that accepted them. PostgreSQL stores a directory of their owners: resource,
Core boot ID, private origin, business lease, connection generation and expiry.
The owning process renews ownership every five seconds; ownership expires after
30 seconds and cannot be renewed after expiry. Publication is locked against
changes to the business lease. Old disconnects and renewals cannot remove or
overwrite a replacement connection on another Core.

Viewer grants live in PostgreSQL too, without frames, credentials or page
content. Admission allows up to **10 viewers per target**, with
a global **100-viewer bound** and six-second inactivity expiry. Every request still
checks the current user, job, credential permission, execution, and target
generation. Frames do not extend the viewer's heartbeat. Any Core can close or
expire a grant; its controller is released and capture stops only after the last
authorized grant leaves, or through the engine's own lease.

Concurrent viewers on different replicas are multiplexed by the **same owner-Core
coordinator**. Capture, frame cache and exclusive-controller state stay in that
process, fenced by the database-backed connection generation. They are not
duplicated on receiving replicas or resurrected after owner failure. No separate
gateway, media service, Redis dependency or sticky sessions are required. A failed
owner requires reopening read-only on the new connection generation, not replaying
old input or restoring an old controller.

With **one Core**, commands run locally without an internal HTTP hop and need
no new environment settings. With **multiple Cores**, configure every replica:

```dotenv
# Different on every replica: its own directly reachable private origin.
VOX_CORE_INTERNAL_URL=http://core-a:5000
# Same strong secret on all replicas; generate with: openssl rand -hex 32
VOX_CORE_ROUTING_SECRET=<shared-random-secret>
```

`core-a` must identify that individual container/pod, not a round-robin service
alias or the public load balancer. Another replica advertises, for example,
`http://core-b:5000`. Private IPv4 addresses, single-label container DNS names,
and `.internal` / `.local` names are accepted. Private HTTPS is supported using
normal certificate verification. The existing database, cookie-signing secret,
credential-encryption key, and plugin configuration must also be shared.

Any replica may receive an agent WebSocket, viewer HTTP request, broker
registration, or broker heartbeat. Browser operations, login mints and brokered
REST calls execute locally when this Core owns the connection/key; otherwise
Core forwards once to the registered owner. Broker heartbeats consult that
shared ownership instead of forcing re-registration on every load-balancer hop.
No browser/agent API changes or sticky cookies are needed.

Forwarding uses `/internal/core-routing`, bounded raw JSON, and an HMAC over the
exact envelope, timestamp and random nonce. The recipient rejects requests
older/newer than 30 seconds, wrong Core IDs, changed generations, and nonce
replays across replicas. It checks current ownership and execution/token leases
again before dispatch. No credentials or frames enter the directory or request
logs. Use a trusted isolated service network, or verified HTTPS: HMAC protects
authentication/integrity but does **not** encrypt plain HTTP traffic. Block the
internal endpoint at the public proxy and permit it only between Core replicas.
Keep replica clocks synchronized for the signed-request timestamp check. Finish
the Core rollout on all replicas before enabling load-balanced browser traffic;
older Core versions do not understand this internal routing protocol.

There is no forwarding retry, broadcast, or fallback execution on the wrong
Core. A lost response can mean an action already happened. When a Core dies,
agents reconnect to any surviving replica and publish a fresh generation;
viewers reopen read-only and old grants cannot control the new connection.
Broker keys are not replicated: if their owner dies, the broker re-registers
through its normal heartbeat recovery, and an in-flight mint may fail within
its existing deadline. Neither a Core restart nor routing guarantees a running
browser session survives an agent/broker process restart. Healthy replicas
continue serving their own live connections independently.

This routing supports browser assistance and broker execution. It does not
claim to make unrelated process-local features (such as Clash spectators,
rate-limit counters or upload concurrency) distributed.

## Active Web Job Cancellation

The job page separately offers confirmed cancellation for **unpaid** running web
jobs on updated agents. Active jobs carrying a marketplace settlement context are
not cancellable through this path until a mid-run settlement policy is defined;
their pending-job cancellation remains supported. Cancellation authority uses the existing job cancellation rule:
the job creator, flow controller, or admin moderator. It grants no browser access.

Core atomically changes only the current running claim to failed/cancelled.
Completion and cancellation serialize on the job row: a late
result cannot revive a cancelled execution. The reverse bridge requests process-
group termination immediately; authenticated heartbeats repeat an execution-
fenced cancellation directive if that channel is unavailable. The daemon also
checks cancellation while waiting for a broker session and between chunks.
Termination escalates to SIGKILL with bounded cleanup; timers are cleared when
the process settles so an old timer cannot kill a later run.

The response reports `cancellationDelivery: "acknowledged" | "pending"` after
awaiting the reverse-channel request. Acknowledgement confirms receipt of the
stop request, not that every browser process has exited. If delivery is pending,
authenticated heartbeats continue retrying the directive. Cancellation is not
instantaneous during a network partition: a disconnected agent may keep operating
until reconnect or its existing run deadline, while Core already refuses its
result. The confirmation and toast explicitly explain this distinction.
Cancelling one job does not cancel an account-shared broker mint used
by other jobs. Legacy pending-job cancellation endpoints remain unchanged.

## Measurements

An agent-side trial that was viewed records
`rawData.browser_observation.mode: "read_only"`; explicit control records
`"interactive"`. The strongest observation is retained across chunks and shown
as a factual badge. It may describe setup, not measured audio. Broker minting is
separate from the agent trial; a cached assisted login is not attributed as live
viewing of every later evaluation using that session.

This does **not** establish measurement validity, phase timing or zero rendering
overhead. It does not silently change Strict/network filtering or exclude results
from aggregates. A benchmark-assistance policy and active-viewer performance
budget require a separate explicit decision and measurement.

## Deploying

1. Back up the DB. Deploy Core; the normal migration runner applies schema 71
   (schema 69 adds mint-routing fields; schema 70 adds connection ownership,
   replay nonces and shared viewer grants; schema 71 removes exclusive-target
   grant admission and adds the target lookup index). No credentials/frames are backfilled.
2. Ensure the public proxy forwards `/ws/eval-browser` upgrades. With multiple
   replicas set each one's private origin and the shared routing secret above,
   permit internal Core-to-Core calls, and deny `/internal/core-routing` publicly.
   Keep the broker callback internal. Single-Core deployments need no new settings.
3. Deploy the broker Docker target and daemon target from this revision. Both
   include the pinned v0.4.4 binary/runtime assets. No new host privilege, public
   port, sound device, or persistent browser credential mount is introduced.
4. Verify personal owner-and-launcher access, denial of both parties in a borrowed
   personal run, exact-org manager access and member denial (even for a member
   launcher), role-revocation cleanup, two viewers through different replicas,
   exclusive explicit control, spectator mutation denial, controller release/expiry,
   shared-tab navigation, independent close/reconnect and cancellation against a test account.

Old daemons remain compatible for evaluations and pending cancellation; they do
not advertise `browserAssistance: "1"` and get no live-browser/active-cancel UI.
Old brokers may still mint but cannot serve inspection. Do not treat an absent
capability or unavailable endpoint as permission to expose raw credentials.

## Verification

Focused tests cover private JSONL framing, split UTF-8, interleaved/latest
frames, no automatic mutation replay, explicit close, inactivity expiry,
credential/organization authority, revocation, claim/lease fences, broker routing,
reverse-channel identity, packaged COPY/dependency boundaries, and active cancel
with heartbeat fallback and late completion. Browser tests cover read-only open,
explicit input, navigation, unknown outcomes, close-during-open and small screens.

The credential-free packaged-engine test uses real headless Chromium, with no
external network. It verifies socket permissions, decoded JPEG frames, denied
read-only input, two viewers sharing one capture/frame, exclusive control,
a same-context verification tab, exactly one
login submission, protected-target continuation and saved session cookies:

```bash
docker build --target daemon -f vox_eval_agentd/Dockerfile -t vox-browser-test .
npx esbuild scripts/test-browser-assistance-runtime.ts --bundle --platform=node \
  --format=esm --outfile=/tmp/vox-browser-runtime-smoke.mjs
docker run --rm --network none --entrypoint node \
  --mount type=bind,source=/tmp/vox-browser-runtime-smoke.mjs,target=/app/runtime-smoke.mjs,readonly \
  vox-browser-test /app/runtime-smoke.mjs
# Also run with --env BROWSER_TEST_RELEASE=1 to verify controller-disconnect
# release/resume and continued spectator capture against the real engine.
```

This fixture is not a real-provider login, an iPad-device test, or an
audio-latency/performance qualification. Separate multi-process tests exercise
the routing layer, shared sessions/viewers, real PostgreSQL ownership fences,
agent WebSockets and broker HTTP calls using credential-free stand-ins.

### Validated On 2026-11-13

- Isolated full gate: 3,810 unit/integration tests passed (84 skipped), all
  29 audio tests passed, and 280 end-to-end tests passed (35 skipped).
- Final focused reruns: all 59 broker tests and all six browser-assistance UI
  tests passed, including the rapid close/reopen lifecycle regression.
- Both daemon and broker Docker targets built and passed entry-point smoke
  checks. The packaged v0.4.4 binary passed the real-Chromium fixture above.
- Core/client and daemon TypeScript checks, lint for the new modules/tests,
  and the whitespace check passed.

These counts describe the initial single-Core gate before the routing changes.

### Owner-Routing Gate On 2026-11-13

- A fresh isolated database migrated through schema 70; the production build,
  Core/client and daemon TypeScript checks passed.
- Full gate: 3,828 unit/integration tests passed (84 skipped), all 29 audio
  tests passed, and 280 end-to-end tests passed (35 skipped).
- Final focused rerun: all 17 routing tests passed, including six tests using
  two independent Core processes and real PostgreSQL. They cover a cookie
  created on A and used on B, an agent connected to A, commands/frames/close
  through either replica, exclusive viewer admission, revocation, same-lease
  reconnects, stale-owner cleanup, broker mint/browser forwarding, expired
  grants/ownership, business-lease races, and shared nonce deduplication.
- New-module/test lint and whitespace checks passed. No additional agent-side
  protocol change is required for the routing layer.

The owner-routing gate ran on an isolated worktree branch. These checks do not
constitute a production deployment, throughput qualification or real-provider/
device qualification. The owner-routing counts above predate concurrent viewing;
concurrency has its own validation gate.

### Concurrent-Viewer Gate On 2026-11-13

- A fresh isolated database migrated through schema 71. The production build,
  Core/client and daemon type checks, new-module/test lint, and whitespace checks passed.
- Full gate against the final source: **3,840 unit/integration tests passed**
  (84 skipped), **29/29 audio tests passed**, and **282 end-to-end tests passed**
  (35 skipped). All eight browser-assistance UI tests passed, including the
  stalled-navigation/status heartbeat regression and small-screen text entry.
- Ten focused coordinator tests cover shared capture/frame fan-out, racing
  exclusive control, spectator mutation denial, explicit release, stale tokens,
  independent close, expiry/revocation, an already-ended native hold, scoped
  receipts, uncertain outcomes, failed release, and independent heartbeat liveness.
- Seven real two-process Core tests cover shared sessions, agent and broker
  capture across replicas, exclusive control, controller expiry, atomic viewer
  limits, revocation, generation changes, stale cleanup, and database ownership fences.
- Two credential-free real-Chromium fixtures passed against packaged aeval
  v0.4.4 through the actual coordinator and agent adapter. They verify one capture
  and identical frames for two viewers, exclusive input, tab/navigation fencing,
  single verification submission and saved cookies, native controller-disconnect
  release/resume, surviving spectator capture, and last-viewer cleanup.

### Browser-Access Policy Gate On 2026-11-13

- Personal admission now requires the same user to own the frozen flow/credential
  scope and launch the job. Team admission uses live owner/admin membership in
  the frozen organization, without a launcher requirement or global-admin bypass.
  The shared predicate controls job-detail capabilities, HTTP access and owner-Core
  grant authorization/maintenance. No new schema or agent protocol is required
  for this permission refinement.
- The full isolated gate passed: **3,845 unit/integration tests** (84 skipped),
  **29/29 audio checks**, and **282 end-to-end tests** (35 skipped), plus production
  build, schema-71 migration, Core/client and daemon types, focused lint and
  whitespace checks. All eight live-browser UI tests passed.
- Twelve HTTP/predicate tests cover personal ownership AND launching, missing
  launch identity, exact-org owner/admin access, ordinary-member/foreign-org
  denial, demotion, completed jobs, session-only access and existing execution
  fences. Nine real two-Core tests include an admitted borrowed personal trial:
  automatic credential use remains authorized, but neither party receives browser
  access, even through direct signed owner-Core requests with persisted grants.
- The real organization provider on a dedicated test database verifies management
  roles across independent Core processes. Demoting a controller prevents input,
  releases its hold and leaves an authorized manager's spectator capture alive.
  Job-result visibility and job-cancellation permissions remain unchanged.

No production deployment, real-provider login, physical iPad qualification or
multi-viewer throughput/audio-latency benchmark is implied by these results.

### PR Review Gate On 2026-11-13

- A fresh isolated build/schema-71 migration and Core/client/daemon type checks
  passed. Full unit/integration: **3,857 passed, 84 skipped**. Full browser suite:
  **284 passed, 35 skipped**, including all ten browser-assistance UI cases.
- Final focused regressions: **44 passed**, covering Runtime-trust admission,
  cached/slow-frame revocation, proxy-origin checks, disabled users and both
  PostgreSQL/Drizzle constraint names. Late cancellation failure reports return
  an idempotent acknowledgement without changing the cancelled execution.
- Audio: **29/29 passed** on both the cached test image and an independent fresh
  legacy-builder image. An earlier attempt failed during PipeWire startup; the
  fresh-image rerun did not reproduce it. This PR does not change the audio stack.
- Focused lint and whitespace passed. Fresh per-frame authorization remains
  intentional; the viewer/request limits are not a throughput qualification.
