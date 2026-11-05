# vox_eval_agentd

Distributed evaluation agent daemon for Vox. Registers with the Vox server, claims pending jobs, executes evaluations with aeval, reports results (MED/SD/P95), and uploads artifacts to S3-compatible storage.

## Architecture

```
Vox Server (API)
    |
    |  Register / Heartbeat / Claim / Complete / Artifacts
    v
vox-agentd.ts  (compiled to vox-agentd.js for Docker)
    |
    |-- aeval                        Single binary, JSON metrics output
    |
    |-- S3 Upload (idle time)        Zip + upload artifacts when no jobs pending
```

### Job Lifecycle

1. Daemon registers with Vox server using `AGENT_TOKEN`
2. Sends periodic heartbeats with state (`idle` / `occupied`)
3. Polls for pending jobs matching the agent's region
4. Claims a job (atomic, `FOR UPDATE SKIP LOCKED` on server)
5. Reads `job.config` for the scenario + Setup/Teardown YAML content
6. Resolves `${secrets.*}` placeholders with encrypted secrets from server
7. Writes YAML content to temp files, executes aeval
8. Parses `metrics.json` results including MED, SD, and P95 metrics
9. Reports results back via `POST /api/eval-agent/jobs/:id/complete`
10. Queues artifact upload (processed when daemon goes idle)
11. Cleans up temp files

### Network monitoring and strict benchmarks

Updated agents sample the local route/link every second and send network events
on the normal 30-second heartbeat. Acknowledged events are removed immediately;
unacknowledged details are bounded to two minutes/128 events. Whole-run change
and coverage summaries survive dropped details. Completion/failure flushes a
final sample. No extra attempt ID is used: Core's claim timestamp scopes events
alongside the existing job, agent and lease IDs and a lease-global sequence.

Valid heartbeats succeed independently of network-event rejection. Core returns
`networkReportStatus` separately from `networkAck`: accepted events are removed,
explicitly rejected sequence IDs are discarded only from the submitted batch,
and all other pending/in-flight observations are preserved for the next report.
Transient network-event storage failures request retry without discarding data.
A rejection or more than two minutes without delivery makes monitoring
incomplete for that execution, permanently excluding it from strict benchmarks
without failing an otherwise valid evaluation result. Authentication, lease and
execution-timestamp failures are still rejected. The existing five-minute
stale-agent recovery and 90-minute job deadline are unchanged.

Native Linux/macOS processes detect the default route, interface and source
address locally. Linux additionally uses `iw` for Wi-Fi BSSID when available.
Private topology is hashed locally; only coarse link type and change dimensions
are reported. Sampling is best effort: very short transitions or egress-only
changes between Core requests can be missed. Strict means fully monitored with
no **detected** changes, not proof that a network could never have changed.

Docker's veth and startup `VOX_LINK_TYPE`/`VOX_PUBLIC_IP_ON_IFACE` overrides are
not live host monitoring. Without fresh host observations, runs remain
unverified and appear only when unstable/unverified runs are included.

For Docker hosts, run the bundled, unprivileged sampler as a persistent host
service (Python 3; Linux requires `iproute2`, macOS uses built-in network tools):

```sh
python3 /opt/Vox/scripts/vox-network-monitor.py --output /var/lib/vox-network
```

Use a dedicated private output directory writable only by the service owner.
Run the command with the paths appropriate for your checkout/service account;
supervise it with systemd/launchd and restart it on failure. It uses no Vox
token, opens no listener, and writes only hashed topology/coarse status. It
retains two minutes/128 host transitions plus monotonic change/gap counters.

Set `VOX_NETWORK_STATUS_DIR=/var/lib/vox-network` when using `vox-upgrade.sh`.
The script mounts that directory read-only at `/run/vox-network` and sets
`VOX_NETWORK_STATUS_FILE=/run/vox-network/status.json`. For manual Docker
deployments, add the equivalent read-only directory mount and environment
variable; ensure the container UID can read the private status file. Mount the
directory, not the file, because writes replace `status.json` atomically.
Neither this upgrade nor the daemon automatically installs a host service.

Sampler death, missing routes, restart, missed history, or status older than
five seconds makes monitoring incomplete. The host's refreshed public-IPv4
signal supersedes the startup override while the live sampler is configured.
Core independently observes the request IP, without exposing it in events.

Deploy Core's schema-66 migration before rolling out this daemon. Old agents
continue to run; they do not qualify for the default strict dashboards. Use
the explicit Include unstable / unverified toggle to inspect older data.
Timestamp-less old daemons can complete a job's first execution, but cannot
complete a retried/reclaimed job: Core cannot distinguish their delayed result
from a successor on the same lease. Upgrade to echo the claim `startedAt`.

### Artifact Upload (S3)

After a job completes (success or failure), the output directory is queued for upload. **Uploads only happen when the daemon is idle** — no impact on eval job performance.

```
Job completes → queue upload task
Daemon idle (no pending jobs) → process upload queue:
  1. Zip output directory
  2. Upload individual files: metrics.json, report.json, recording.webm
  3. Upload artifacts.zip
  4. Report S3 keys to Vox server
  5. Clean up local zip
```

**S3 config resolution per job:**
1. Check if job creator has custom storage config (via `GET /api/eval-agent/jobs/:id/storage-config`)
2. If user has config → use their S3 bucket
3. If not → use system defaults from daemon ENV vars
4. If neither configured → skip upload, log warning

### Config Data Model

Jobs carry a merged config snapshot from the eval flow and eval set:

```
job.config = {
  framework: "aeval",
  scenario: "<YAML string>",       // Test steps to execute
  stepsPrefix: "<YAML step list>", // eval flow Setup Steps
  stepsSuffix: "<YAML step list>", // eval flow Teardown Steps
}
```

- **eval flow** provides `framework` + Setup/Teardown steps (how to reach the agent)
- **Eval Set** provides `scenario` (what test to run)
- Merging: eval set config spreads last (overrides eval flow fields)

### Framework

**aeval**:
- Single compiled binary downloaded from GitHub Releases
- Runtime data (config, examples, corpus) from `aeval-data/` submodule
- Runs with `cwd: /app/aeval-data` (platform configs resolve relative to this)
- Output: `metrics.json` with turn-level latency data, `report.json`, `recording.webm`
- Parses: response/interrupt latency (MED, SD, P95) from turn-level arrays
- Fallback chain: `turn_level` → `summary.p50/p95` → `aggregated_summary.avg` → stdout timestamps

### Output Directory

aeval writes to `/app/output` via a symlink:
- `/app/aeval-data/output` → `/app/output` (symlink in Dockerfile)

The `VOLUME /app/output` mount makes artifacts accessible on the host.

## Directory Structure

```
vox_eval_agentd/
  vox-agentd.ts          # Main daemon source (TypeScript)
  package.json           # Deps (@aws-sdk/client-s3) + esbuild build script
  Dockerfile             # Production Docker image
  aeval-data/            # Git submodule: Agora-Build/aeval (config, examples, corpus)
  scenarios/             # Scenario YAML files
    smoke_test_en_livekit.yaml      # LiveKit smoke test
    smoke_test_en_agora.yaml        # Agora ConvoAI smoke test
    smoke_test_en_elevenlabs.yaml   # ElevenLabs smoke test
    basic_conversation.yaml         # Basic VAT scenario
  assets/                # Audio files for test scenarios
```

## Running

### Docker (Production)

```bash
# Build (from repo root)
docker build -f vox_eval_agentd/Dockerfile -t vox_eval_agentd .

# Run
docker run \
  -e AGENT_TOKEN=<token> \
  -e VOX_SERVER=http://host.docker.internal:5000 \
  -v /tmp/vox-output:/app/output \
  vox_eval_agentd
```

### Local Development

```bash
# From project root — starts everything including eval agent
./scripts/dev-local-run.sh start

# Multi-region (NA + APAC + EU agents)
./scripts/dev-local-run.sh --multi-region start
```

Both Docker and local dev use the same source file (`vox-agentd.ts`). Docker compiles it to JS with esbuild; local dev runs it directly with `tsx`.

### Install aeval Binary

```bash
# macOS (Apple Silicon)
curl -fSL -o /usr/local/bin/aeval \
  https://github.com/Agora-Build/aeval/releases/latest/download/aeval-macos-arm64
chmod +x /usr/local/bin/aeval

# Linux (x86_64)
curl -fSL -o /usr/local/bin/aeval \
  https://github.com/Agora-Build/aeval/releases/latest/download/aeval-linux-x86_64
chmod +x /usr/local/bin/aeval
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_TOKEN` | (required) | Eval agent token from Vox server |
| `VOX_SERVER` | `http://localhost:5000` | Vox API server URL |
| `VOX_AGENT_NAME` | `eval-agent-<timestamp>` | Agent display name |
| `EVAL_FRAMEWORK` | `aeval` | Default eval framework — the extensibility seam; `aeval` is currently the only implementation. Jobs may override via `job.config.framework`; unsupported values fail loudly. |
| `HEADLESS` | `true` | Run browser in headless mode |
- **S3 config is fetched from the Vox server per job** — no S3 env vars needed on the daemon. Just upgrade to the latest version and it works. If the server has no S3 config, artifacts stay on local disk.
- **Artifact upload never impacts eval jobs** — uploads only happen when the daemon is idle (no pending jobs).
- **Crash-safe** — all upload operations are wrapped in try/catch. Network failures, S3 errors, zip timeouts, and bad configs are logged but never crash the daemon or block job execution.

## Startup Log

```
[Daemon] Starting vox_eval_agentd
  - Build: v0.17.0 (2026-04-25)
  - Server: http://vox.example.com
  - Agent Name: eval-agent-na
  - Headless: true
  - Eval Framework: aeval
  - S3 Artifacts: https://<account>.r2.cloudflarestorage.com/vox-artifacts
```

## Error Handling

- Failed jobs are reported back to the server with the error message
- Partial results are not reported — jobs are either fully complete or failed
- Heartbeat sends current state (`occupied` when running a job, `idle` when polling)
- Server marks agents as offline after 5 minutes without a heartbeat
- Temp YAML files are cleaned up in `finally` blocks even on failure
- Artifact upload failures are logged but don't affect job status
- Multiple agents in the same region safely compete for jobs via atomic claim
