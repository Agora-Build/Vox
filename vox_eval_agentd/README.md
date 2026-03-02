# vox_eval_agentd

Distributed evaluation agent daemon for Vox. Registers with the Vox server, claims pending jobs, executes evaluations using one of two frameworks, and reports results back.

## Architecture

```
Vox Server (API)
    |
    |  Register / Heartbeat / Claim / Complete
    v
vox-agentd.ts  (compiled to vox-agentd.js for Docker)
    |
    |-- aeval (default)              Single binary, JSON metrics output
    |-- voice-agent-tester           Node/Puppeteer, CSV report output
```

### Job Lifecycle

1. Daemon registers with Vox server using `AGENT_TOKEN`
2. Sends periodic heartbeats with state (`idle` / `occupied`)
3. Polls for pending jobs matching the agent's region
4. Claims a job (atomic, `FOR UPDATE SKIP LOCKED` on server)
5. Reads `job.config` to determine framework and YAML content
6. Writes YAML content to temp files, executes the framework
7. Parses results (JSON for aeval, CSV for VAT), reports back via `/complete`
8. Cleans up temp files

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
- When config fields are empty, the daemon falls back to local default files

### Frameworks

**aeval** (default):
- Single compiled binary downloaded from GitHub Releases
- Runtime data (config, examples, corpus) from `aeval-data/` submodule
- Output: `metrics.json` in output directory
- Parses: `response_latency.median_ms`, `interrupt_latency.median_ms`, etc.

**voice-agent-tester** (VAT):
- Node.js + Puppeteer browser automation
- App config YAML: URL + browser interaction steps (navigate, click, wait)
- Scenario YAML: voice interaction steps (speak, wait_for_voice, metrics)
- Output: CSV report with `elapsed_time` columns
- Parses: median/stddev of response and interrupt latencies

## Directory Structure

```
vox_eval_agentd/
  vox-agentd.ts          # Main daemon source (TypeScript)
  vox-agentd.js          # Compiled daemon (built by esbuild, Docker entrypoint)
  package.json           # Daemon metadata + esbuild build script
  Dockerfile             # Production Docker image
  aeval-data/            # Git submodule: Agora-Build/aeval (config, examples, corpus)
  voice-agent-tester/    # Git submodule: livetok-ai/voice-agent-tester
  applications/          # Default VAT app configs (fallback when job.config.app is empty)
    livekit.yaml         # LiveKit playground app config
  scenarios/             # Default VAT scenarios (fallback when job.config.scenario is empty)
    basic_conversation.yaml
  assets/                # Audio files for test scenarios
    hello_make_an_appointment.mp3
    appointment_data.mp3
    ...
```

## Running

### Docker (Production)

```bash
# Build (from vox_eval_agentd/ or via dev script)
docker build -t vox_eval_agentd .

# Run
docker run \
  -e AGENT_TOKEN=<token> \
  -e VOX_SERVER=http://host.docker.internal:5000 \
  -e EVAL_FRAMEWORK=aeval \
  vox_eval_agentd
```

The Dockerfile:
- Downloads `aeval` binary from GitHub Releases (multi-arch: x86_64/arm64)
- Copies `aeval-data/` submodule for runtime config/examples/corpus
- Copies and installs `voice-agent-tester/` submodule
- Installs Chromium for Puppeteer (VAT headless browser)

### Local Development

```bash
# From project root — starts everything including eval agent
./script/dev-local-run.sh start

# The script automatically:
# 1. Initializes git submodules (aeval-data + voice-agent-tester)
# 2. Downloads aeval binary if not installed
# 3. Starts the daemon via: npx tsx vox_eval_agentd/vox-agentd.ts --token <TOKEN>
```

Both Docker and local development use the same source file (`vox-agentd.ts`). Docker compiles it to JS with esbuild; local dev runs it directly with `tsx`.

### Build aeval Binary Separately

If the dev script can't auto-download aeval:

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
| `HEADLESS` | `true` | Run browser in headless mode (VAT) |
| `OPENAI_API_KEY` | (optional) | Required by voice-agent-tester for STT |

Note: `EVAL_FRAMEWORK` is the fallback default. Individual jobs can override the framework via `job.config.framework`.

## Error Handling

- Failed jobs are reported back to the server with zeroed metrics so they don't stay stuck in "running" state
- Heartbeat sends current state (`occupied` when running a job, `idle` when polling)
- Server marks agents as offline after 5 minutes without a heartbeat
- Temp YAML files are cleaned up in `finally` blocks even on failure
