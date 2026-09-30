# Tools → Analyze: analyze uploaded recordings

**Status:** implemented on `feat/tools-analyze` · 2026-09-30

## What and why

A new **Tools** section in the console, starting with one tool: **Analyze**. A user
uploads one or more stereo WAV recordings of a conversation with a voice agent
(left channel = user, right channel = agent), picks the provider and the region
each one was made with, and Vox runs the same analysis it runs on its own eval recordings.
The results show on the Analyze page and in **My Evals**, next to results from
real eval runs. They do not show under Eval Jobs.

This lets someone get Vox numbers for a conversation they already recorded,
without writing an eval flow or running an agent.

Nothing new is needed for the analysis itself. The phone path already writes one
stereo WAV (left = user, right = agent) into a session directory and runs
`aeval analyze` on it (`vox_eval_agentd/phone-eval.ts`, `buildSessionDir`). An
uploaded recording is that same input.

## Decisions (made in discussion)

| Question | Decision |
|---|---|
| Where does analysis run? | On **eval agents**, as a new job kind. Agents already have aeval and the analyze code; Core stays free of Python/ML dependencies. |
| Which My Evals view? | The user picks **Web** or **Phone** per file. Web and phone stay a hard split. |
| Several files at once? | **One result per file**, each with its own provider and region. |
| Region? | Picked per file at upload: **where the recording was made**. Any capable agent can run the analysis, since where it runs doesn't change the numbers. |
| Who can use it? | **Tools** shows for every signed-in user. **Analyze** works once the user has set their own storage on the Storage page (Premium and up, since Storage is hidden for Basic); until then the page says what to do. Daily cap applies. |
| Where do WAVs live? | In the **user's own bucket** from the Storage page. No system fallback: production Core has no S3 configured, and the audio is the user's. |
| Show under Eval Jobs? | **No.** Only on the Analyze page and in My Evals. |

## 1. What the user sees

**Sidebar.** A collapsible **Tools** group after Storage, open by default, that
remembers whether it was collapsed. It holds one entry, **Analyze**
(`/console/tools/analyze`), and is visible to every signed-in user.

**Analyze page** (`/console/tools/analyze`):

- **Upload card.**
  - Drop or pick one or more `.wav` files. Each file becomes a row with:
    - **Provider** (required): the provider list from `GET /api/providers`.
    - **Region** (required): where the recording was made, from the admin-managed
      region locations (`GET /api/region-locations`), e.g. `na-us-seattle`.
    - **Source** (required): Web or Phone. This decides which My Evals view the result lands in.
    - With several files, a "same for all files" option fills Provider, Region
      and Source for every row from the first.
  - Hint text: "Stereo WAV: left channel = user, right channel = agent."
  - The **Analyze** button stays disabled until every row has a provider, a region and a source.
  - The browser checks each file before upload (a WAV with 2 channels, within the limits below). The server checks again; the browser check is only for a quick message.
- **My analyses** list: file name, provider, region, source, status (Queued / Analyzing /
  Done / Failed + reason), submitted time. It polls while anything is queued or
  running. Each row can be deleted.

**Analysis detail** (`/console/tools/analyze/:id`): the shared result view, plus
a download link for the uploaded WAV.

- **The shared result view** is the results part of the eval job page
  (`console-eval-job-detail.tsx`): the Response Latency, Interrupt Latency, Turn
  Success Rate and Other Metrics cards, Per-Case Results, and the turn-level
  latency table.
- It is extracted into one component, used by both the eval job page and the
  analysis page, so the two never drift apart.

**My Evals.** Each finished analysis adds a result under the chosen provider and
region, in the Web or Phone view the user picked.

## 2. How an analysis runs

### Job row (hidden)

Each file becomes one `eval_jobs` row, so results, artifacts, the reapers and the
My Evals queries all keep working unchanged.

- **New column** `eval_jobs.kind`: `'eval'` (default, every existing row) or
  `'analyze'`. Hand-written migration, registered in `server/migrate.ts`.
- `eval_flow_id` and `eval_set_id` are NULL. The frozen `snapshot` carries the
  provider, the recording region, the source (`web`/`phone`), the file name, the S3 key, the file's
  SHA-256 and its size and duration, plus the creator's plan, as today.
- `eval_jobs.transport` is stamped from the source, so the existing transport
  split in the metrics queries needs no change.
- **Hidden from job lists.** The Eval Jobs list (`storage.evalJobConditions`) and
  the `/api/v1` job lists filter to `kind = 'eval'`.
- **Kept off the public boards.** The Mainline and Community conditions add
  `kind = 'eval'` explicitly. They would already exclude these rows (no public
  eval flow in the snapshot), but the tiers shouldn't rely on that by accident.
- **Added to My Evals.** `myEvalConditions` gets one more condition:
  `kind = 'analyze' AND created_by = <me>`.
- **Who can see it.** Only the creator. An admin may delete one (moderation), as
  with other resources. Deleting an analysis deletes the job (its result cascades)
  and the stored WAV.

### Marketplace agents, for credits (added after review)

The uploader can instead pick a marketplace (shared) agent from a "Run on"
choice (default: Vox agents, free). This is the existing paid-dispatch flow:

- The form lists marketplace agents that report `analyze`, with their price
  (`GET /api/tools/analyze/agents`), and shows the total: files × price.
- The uploader must tick consent: the agent is run by someone else, and its
  operator receives the recording. Recorded as `snapshot.recordingConsent`.
- Price: one unit at the agent's listed price per file (same as one eval run),
  held by `authorizeDispatch` at upload (402 when short), captured when a
  result comes back, refunded if the analysis fails or is deleted while queued.
- The job targets that token; only it may claim the analysis.

### Which agent runs it

Analysis doesn't depend on where the agent is, so an analyze job has no site and
no region. It can be claimed by an agent that:

1. declares a new **`analyze` capability** on register/heartbeat, like `phone`.
   The daemon declares it when the `aeval` binary is on its PATH, which is
   always true in the Docker image. An agent that doesn't declare it (an older
   daemon, or a host without aeval) never takes an analyze job.
2. is one the user is allowed to use: an **admin-operated public agent**, or one
   of the **user's own private/team agents**.
   - **Marketplace (shared) agents are never used.** The audio belongs to the
     user, and a shared agent is run by someone else.

**Who actually takes it.** Agents pull work: each agent polls Core for jobs,
and the first eligible agent to poll claims the analysis. There is no picker on
the upload form ("any eligible agent"). In practice the admin-operated public
agents take most analyses, since most users run no agent of their own.

- **Lower priority than eval runs.** Analyze jobs are created with
  `priority = -10` (eval jobs use 0). Both claim paths already order by
  `priority DESC, created_at ASC`, so an agent always takes a waiting eval run
  first. An upload never delays a scheduled eval, and a batch of 10 files
  doesn't hold up everyone's runs.
- **Agents need the new daemon.** The `analyze` capability ships in the daemon
  release that carries this feature. Until agents are upgraded
  (`vox-upgrade.sh`), nothing claims analyze jobs, and they fail after 24h with
  the reason. Upgrade the public agents in the same rollout.
- **Nobody is online.** The job stays Queued, and after 24h it fails with the
  existing backstop's reason.

This is a third claim rule, next to site-pinned and region-pooled. It goes into
both claim SQL paths (`claimEvalJob`, `getClaimableJobsForToken`) and into
`permissions.isClaimable`, kept in step as the codebase already requires.

### On the agent

1. Download the WAV through a new lease-checked endpoint,
   `GET /api/eval-agent/jobs/:jobId/upload`. Core streams it from S3, so the
   agent never gets bucket credentials.
2. Check it: a WAV with 2 channels, within the limits. Otherwise fail the job
   with the reason.
3. Lay out the session directory the way the phone path does
   (`recordings/recording.wav`).
4. Run `aeval analyze` with the existing phone preset
   (`analysis-presets/phone.yaml`). It already analyzes one mixed recording
   with no browser stages, which is exactly an upload.
   - Latency comes out as usual.
   - TSR and the three rates stay NA: they need the eval set's sample timeline,
     which a free-form recording doesn't have.
5. Report through the existing complete and artifacts endpoints.

The same failure rule applies: if aeval exits with an error, the job fails and no
partial results are kept. No secrets are involved, so the job-secrets path is not
used.

### Storage

- **The user's own bucket only.** Uploads go browser → Core → the bucket the
  user set on the Storage page (`user_storage_config`), under
  `vox-analyze/<userId>/<uuid>.wav`. There is no system fallback.
- **Without storage, no Analyze.** The page says "Set up your storage first",
  with a link to the Storage page. Basic users, who can't open that page, are
  told that Analyze needs Premium. The upload route refuses with 409 as well.
- **One file per request.** The browser sends each WAV as its own request with
  the raw file as the body (`Content-Type: audio/wav`), so no multipart library
  is needed. Core checks the WAV header, then writes the file to the bucket.
- **The agent never gets the bucket credentials for this.** Core streams the
  file to the claiming agent through the lease-checked `/upload` endpoint.
- **Kept until deleted.** The WAV stays with the result until the analysis is
  deleted. Deleting is soft (`deleted_at`): the result and the file go, the
  row stays so the daily cap still counts it.
- **Storage can change afterwards.** Each upload records where it went
  (endpoint and bucket, never credentials). If the user later changes or
  removes their storage, downloads refuse with that location, and delete
  removes the analysis from Vox and tells them where the file still is.
  Nothing is wrongly reported as deleted.
- **No artifacts.** Everything the pages show is in the result row, so the
  agent uploads nothing and deletes its work dir. `/storage-config` refuses
  analyze jobs: an agent the uploader doesn't run never gets their
  credentials, and nothing can fall back to another bucket.
- **Not through the job routes.** `canViewJob` / `canCancelJob` refuse
  analyze jobs for everyone, admins included. Only the Tools routes serve
  them, to their uploader.

### Region

The region picked at upload is **where the recording was made**, not where it
was analyzed. The analyzing agent's location says nothing about the
conversation, so it isn't recorded as the result's site.

- **New column** `eval_results.recording_region` (nullable, a region location
  base id such as `na-us-seattle`). It is set only for analyze results. The
  result's `site_id` stays NULL, because no Vox agent measured the conversation
  from that site.
- **My Evals region filter.** The region filter (`regionScopeCondition`) matches
  `site_id LIKE '<base>-%' OR recording_region = '<base>'`, so an analysis
  appears under the region the user picked. The Unverified bucket becomes
  `site_id IS NULL AND recording_region IS NULL`, so these results don't also
  show up there.
- **It's the user's own claim.** Vox can't verify where a recording was made.
  That's acceptable because analyze results only ever appear in their creator's
  My Evals, never on Mainline or Community, where region is trusted
  (zero-trust agent region).
- **Validated on upload.** The region must be an existing region location.

### Limits

| Limit | Value |
|---|---|
| Analyses per user per day | 50 |
| File size | 100 MB |
| Recording length | 30 min |
| Files per upload | 10 |
| Unclaimed | fails after 24h (existing backstop), with the reason. An analysis has no site, so the 15-minute no-agent reaper never applies: with no eligible agent it waits the full day, and the detail page says so |
| Uploads in flight | one per user, 3 in total (Core holds each file in memory while checking and storing it; per process, as Vox runs one Core) |

A running analysis is bounded by the existing 90-minute run limit.

## API

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/tools/analyze` | Multipart: files plus `{provider, region, source}` per file. Creates one job per file and returns them. |
| `GET` | `/api/tools/analyze` | The caller's analyses, newest first. |
| `GET` | `/api/tools/analyze/:id` | Status plus the result, if done. |
| `GET` | `/api/tools/analyze/:id/recording` | Download the uploaded WAV (owner only). |
| `DELETE` | `/api/tools/analyze/:id` | Deletes the job, its result and the stored WAV. |
| `GET` | `/api/eval-agent/jobs/:jobId/upload` | Agent side, lease-checked. |

## Testing

- **Priority:** with an eval job and an analyze job both waiting, an agent claims the eval job first.
- **Practical test** (real agent, real aeval, real bucket): upload a stereo WAV
  built from two corpus clips (user question on the left, reply 0.8 s after it
  on the right, a few turns), wait for the local agent to analyze it, then check:
  - the result has a response latency;
  - it's in My Evals under the chosen provider and region;
  - it isn't in the Eval Jobs list;
  - deleting it removes the object from the bucket.
- **Claim rule** on the real SQL, both paths plus `isClaimable`:
  - taken by an agent with `analyze` that the user may use (public, or their own);
  - refused by an agent without the capability, by a marketplace agent, and by someone else's private agent.
- **Visibility:**
  - analyze jobs are missing from the Eval Jobs list and `/api/v1` lists;
  - they appear in the creator's My Evals, in the chosen transport only;
  - they appear under the chosen region in the My Evals region filter, and not in Unverified;
  - they never appear on Mainline or Community;
  - another user can't see them.
- **Upload checks** (server): mono, not a WAV, too large or too long, over the daily cap, no provider, and a missing or unknown region are each refused.
- **Agent:**
  - the session directory is laid out the same as on the phone path;
  - a failed analyze fails the job, with no results reported.
- **E2E:**
  - upload a stereo WAV and pick a provider, a region and a source;
  - the row goes Queued → Done;
  - the detail page shows the result cards;
  - the result appears in My Evals.
- **Delete:** the job, its result and the S3 object are all gone.

## Not in this version

- Mono files, or a separate WAV per speaker.
- More tools. The Tools group is built to take more entries later.
- Choosing the agent ("my agents only" vs any), or preferring a user's own agent.
