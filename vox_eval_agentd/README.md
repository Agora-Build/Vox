# vox_eval_agentd

Distributed evaluation agent daemon for Vox. Registers with the Vox server, claims pending jobs, executes evaluations using one of two frameworks, reports results (MED/SD/P95), and uploads artifacts to S3-compatible storage.

## Architecture

```
Vox Server (API)
    |
    |  Register / Heartbeat / Claim / Complete / Artifacts
    v
vox-agentd.ts  (compiled to vox-agentd.js for Docker)
    |
    |-- aeval (default)              Single binary, JSON metrics output
    |-- voice-agent-tester           Node/Puppeteer, CSV report output
    |
    |-- S3 Upload (idle time)        Zip + upload artifacts when no jobs pending
```

### Job Lifecycle

1. Daemon registers with Vox server using `AGENT_TOKEN`
2. Sends periodic heartbeats with state (`idle` / `occupied`)
3. Polls for pending jobs matching the agent's region
4. Claims a job (atomic, `FOR UPDATE SKIP LOCKED` on server)
5. Reads `job.config` to determine framework and YAML content
6. Resolves `${secrets.*}` placeholders with encrypted secrets from server
7. Writes YAML content to temp files, executes the framework
8. Parses results (JSON for aeval, CSV for VAT) including MED, SD, and P95 metrics
9. Reports results back via `POST /api/eval-agent/jobs/:id/complete`
10. Queues artifact upload (processed when daemon goes idle)
11. Cleans up temp files

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

Jobs carry a merged config snapshot from the workflow and eval set:

```
job.config = {
  framework: "aeval" | "voice-agent-tester",
  app: "<YAML string>",       // VAT: product URL + browser setup steps
  scenario: "<YAML string>",  // Test steps to execute
}
```

- **Workflow** provides `framework` + `app` (what product to connect to)
- **Eval Set** provides `scenario` (what test to run)
- Merging: eval set config spreads last (overrides workflow fields)

### Frameworks

**aeval** (default):
- Single compiled binary downloaded from GitHub Releases
- Runtime data (config, examples, corpus) from `aeval-data/` submodule
- Runs with `cwd: /app/aeval-data` (platform configs resolve relative to this)
- Output: `metrics.json` with turn-level latency data, `report.json`, `recording.webm`
- Parses: response/interrupt latency (MED, SD, P95) from turn-level arrays
- Fallback chain: `turn_level` → `summary.p50/p95` → `aggregated_summary.avg` → stdout timestamps

**voice-agent-tester** (VAT):
- Node.js + Puppeteer browser automation
- App config YAML: URL + browser interaction steps (navigate, click, wait)
- Scenario YAML: voice interaction steps (speak, wait_for_voice, metrics)
- Output: CSV report with `elapsed_time` columns
- Parses: median/stddev/p95 of response and interrupt latencies

### Output Directory

Both frameworks write to `/app/output` via symlinks:
- `/app/aeval-data/output` → `/app/output` (symlink in Dockerfile)
- `/app/voice-agent-tester/output` → `/app/output` (symlink in Dockerfile)

The `VOLUME /app/output` mount makes artifacts accessible on the host.

## Directory Structure

```
vox_eval_agentd/
  vox-agentd.ts          # Main daemon source (TypeScript)
  package.json           # Deps (@aws-sdk/client-s3) + esbuild build script
  Dockerfile             # Production Docker image
  aeval-data/            # Git submodule: Agora-Build/aeval (config, examples, corpus)
  voice-agent-tester/    # Git submodule: voice-agent-tester
  applications/          # Default VAT app configs
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
  -e EVAL_FRAMEWORK=aeval \
  -v /tmp/vox-output:/app/output \
  vox_eval_agentd
```

### Local Development

```bash
# From project root — starts everything including eval agent
./script/dev-local-run.sh start

# Multi-region (NA + APAC + EU agents)
./script/dev-local-run.sh --multi-region start
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
| `EVAL_FRAMEWORK` | `aeval` | Default framework: `aeval` or `voice-agent-tester` |
| `HEADLESS` | `true` | Run browser in headless mode |
- `EVAL_FRAMEWORK` is the fallback default. Individual jobs can override via `job.config.framework`.
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
