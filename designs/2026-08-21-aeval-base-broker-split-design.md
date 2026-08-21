# aeval Base + Broker/Daemon Target Split — Design

**Date:** 2026-08-21
**Status:** Approved for planning
**Author:** Brent G (with SMT)

## Problem

`vox_eval_agentd/Dockerfile` builds a single image that serves two runtime roles:

1. **Eval-agent daemon** — `CMD ["node", "vox-agentd.js"]`, the default.
2. **Session broker** — the same image with a `command: ["node", "session-broker.js"]`
   override (see `docker-compose.yml`), a stateless sidecar that mints Playwright
   `storageState` by driving aeval's `setup:account` login flow.

The broker only needs the `aeval` binary, `aeval-data`, and Playwright Chromium.
But because it reuses the daemon image, it also carries things it never runs:

- the entire **voice-agent-tester** framework (`npm install` + a second Puppeteer
  Chrome download),
- the daemon code (`vox-agentd.js`) and its `shared/` sources,
- the daemon's `node_modules`.

For a service that handles **decrypted login credentials**, that unused payload is
both image bloat and avoidable attack surface. The two roles share ~90% of their
layers (OS + Node + Chromium deps + aeval + Playwright + aeval-data) and diverge
only at the very top.

## Goal

Split the single image into a shared internal `base` stage plus two thin target
stages, publishing **two** images from **one** Dockerfile:

- `vox-eval-agentd` (daemon target) — unchanged content.
- `vox-session-broker` (broker target) — new, lean: base + `session-broker.js` only.

The heavy `base` stage is an **internal build stage** — built, cached, and reused,
but never published. No third registry image, no base/child version pinning.

## Non-Goals

- No change to broker or daemon **runtime logic** (`session-broker.ts`,
  `vox-agentd.ts` are untouched).
- No Coolify resource creation or webhook wiring in this change (console + secret
  work; documented as a follow-up in §7).
- No trimming of `aeval-data` into subsets — both roles share the whole submodule
  via `base`.

## Constraints (verbatim, binding)

- **Base image:** `ubuntu:24.04` (GLIBC 2.39, required by aeval's bundled Python
  runtime). Do not change it.
- **aeval binary:** `ARG AEVAL_VERSION=v0.3.0`, downloaded per `TARGETARCH`.
- **Playwright Chromium:** `playwright==1.57.0`, installed into
  `/root/.cache/ms-playwright/` where the aeval binary expects it.
- **Daemon must remain the default target** (last stage), so
  `docker build -f vox_eval_agentd/Dockerfile .` with no `--target` still yields the
  daemon image — dev-local-run.sh and any plain build keep working unchanged.
- **Broker output name:** the compiled file MUST be `session-broker.js` — the
  entrypoint guard is `process.argv[1].endsWith('session-broker.js')`.
- **CI push guard:** every login/push step stays guarded on
  `github.event_name != 'pull_request'` (PRs build + smoke test, never publish).
- **Signatures:** commit ends with `🤖 Built with SMT <smt@agora.build>`; PR body
  ends with `Generated with SMT <smt@agora.build>`.

## Grounding facts (verified against source)

From `vox_eval_agentd/session-broker.ts`:
- Imports **only Node builtins**: `http`, `child_process` (`spawn`), `crypto`, `fs`,
  `os`, `path`, `url`. No `shared/`, no `@aws-sdk`, no `js-yaml`.
- `const AEVAL_DATA_PATH = path.resolve(__dirname, 'aeval-data')` → needs
  `/app/aeval-data` (provided by `base`); used as `cwd` for `spawn('aeval', ['run', …])`.
- Every mint uses a fresh `fs.mkdtempSync(os.tmpdir(), 'vox-mint-')` workdir for
  scenario/output/storage — the broker needs **no** `/app/output` symlinks.
- Because the esbuild bundle's only externals are Node builtins (the `@aws-sdk`
  external is a no-op — never imported), the broker needs **zero `node_modules` at
  runtime**.

From `vox_eval_agentd/Dockerfile` (current), the split points:

| Current lines | Content | New stage |
|---|---|---|
| 15–58 | OS + Node + Chromium deps + libsndfile1 + ffmpeg + wget/zip | `base` |
| 62–74 | aeval binary download | `base` |
| 76–83 | Playwright Chromium for aeval | `base` |
| 86 | `COPY aeval-data/` | `base` |
| 121–129 | build-metadata `ARG`/`ENV` | `base` |
| 88–93 | voice-agent-tester COPY + npm install + Puppeteer Chrome | `daemon` |
| 97–100,102–106 | applications/scenarios/assets + vox-agentd.ts + session-inject.ts + chunking.ts + package.json + shared/secrets.ts + shared/metrics.ts | `daemon` |
| 108–114 | daemon npm install + esbuild `vox-agentd.js` | `daemon` |
| 132–134 (VOX_SERVER, EVAL_FRAMEWORK) | daemon runtime env | `daemon` |
| 136–147 | output symlinks, VOLUME, EXPOSE 8099, daemon CMD | `daemon` |
| 101 | `COPY session-broker.ts` | `broker` (moved out of the daemon image) |
| 116–119 | esbuild `session-broker.js` | `broker` |

`HEADLESS=true` (currently line 133) moves to `base` — both roles drive Chromium
headless.

## Design

### Stage 1 — `base` (internal, not published)

```dockerfile
FROM ubuntu:24.04 AS base
```

Contains, in this order (unchanged commands, just relocated):

1. `ENV DEBIAN_FRONTEND=noninteractive`
2. The full apt layer: Node 22 + Chromium system libs + fonts + `libsndfile1` +
   `ffmpeg` + `wget` + `zip`.
3. `WORKDIR /app`
4. aeval binary download (`ARG TARGETARCH`, `ARG AEVAL_VERSION=v0.3.0`).
5. Playwright Chromium install (`playwright==1.57.0` → `playwright install chromium`
   → uninstall pip/playwright).
6. `COPY vox_eval_agentd/aeval-data/ /app/aeval-data/`
7. Build-metadata `ARG`/`ENV` (`BUILD_TAG`, `BUILD_DATE`, `AEVAL_DATA_COMMIT`,
   `AEVAL_DATA_DATE`) and `ENV HEADLESS=true`.

Both child stages `FROM base`, so both inherit these layers and the metadata.

### Stage 2 — `broker` (published as `vox-session-broker`)

```dockerfile
FROM base AS broker
WORKDIR /app
COPY vox_eval_agentd/session-broker.ts /app/
COPY vox_eval_agentd/package.json /app/
RUN npm install \
 && npx esbuild session-broker.ts --bundle --platform=node --format=esm \
      --outfile=session-broker.js \
      --external:child_process --external:fs --external:os --external:path \
      --external:url --external:http --external:@aws-sdk/client-s3 \
 && rm -rf node_modules
EXPOSE 8200
CMD ["node", "session-broker.js"]
```

- `npm install` is only for esbuild (a devDep); `rm -rf node_modules` after compile
  because the bundle needs none at runtime (verified above).
- esbuild externals kept **identical** to the current broker compile — the
  `@aws-sdk` external is an unused no-op but harmless, and matching the current
  command avoids a behavior change in the bundling.
- `EXPOSE 8200` is documentation of the default `BROKER_PORT` (the code reads
  `BROKER_PORT || 8200`); the compose network reaches it by service name.

### Stage 3 — `daemon` (published as `vox-eval-agentd`, DEFAULT target)

```dockerfile
FROM base AS daemon
```

Identical to the current image from line 88 onward, **minus** the
`COPY session-broker.ts` and its esbuild step (now in `broker`):

1. `COPY voice-agent-tester/` → `npm install && npx puppeteer browsers install chrome`.
2. `COPY` applications/, scenarios/, assets/, `vox-agentd.ts`, `session-inject.ts`,
   `chunking.ts`, `package.json`, `shared/secrets.ts`, `shared/metrics.ts`.
3. `npm install` → esbuild `vox-agentd.js` (unchanged externals).
4. `ENV VOX_SERVER=http://localhost:5000`, `ENV EVAL_FRAMEWORK=aeval`.
5. Output symlinks (`aeval-data/output`, `voice-agent-tester/output`), `VOLUME /app/output`,
   `EXPOSE 8099`, `CMD ["node", "vox-agentd.js"]`.

Because `daemon` is the **last** stage, it is the default `--target`.

### `docker-compose.yml`

The `session-broker` service moves to the real broker image and target:

```yaml
  session-broker:
    image: vox-session-broker:latest
    build:
      context: .
      dockerfile: vox_eval_agentd/Dockerfile
      target: broker
    container_name: vox-session-broker
    environment:
      SESSION_BROKER_SECRET: ${SESSION_BROKER_SECRET:-local-broker-secret-change-me}
      BROKER_PORT: 8200
      HEADLESS: "true"
      WEB_SESSION_MINT_TIMEOUT_SECONDS: ${WEB_SESSION_MINT_TIMEOUT_SECONDS:-180}
```

- `command:` override removed (the broker target's default CMD is `session-broker.js`).
- No published ports (unchanged) — internal network only.
- The commented-out `eval-agent` service block gets a one-line note that it uses the
  default target (`daemon`); no `target:` needed.

### `.github/workflows/docker.yml`

The existing `build-vox-eval-agentd` job builds **both** targets. `base` is built
once and reused for the broker target via the runner's BuildKit layer cache — the
same mechanism the file already relies on for its build-load-then-push pair.

Added to the job (daemon steps unchanged):

- A second `docker/metadata-action` step → `images: …/vox-session-broker`.
- Build `--target broker` with `load: true` and the same `build-args`.
- **Broker smoke test:**
  ```bash
  docker run --rm "$BROKER_IMAGE" bash -c "
    echo '=== Node ===' && node --version &&
    echo '=== aeval ===' && aeval --version &&
    echo '=== Broker syntax ===' && node --check /app/session-broker.js &&
    echo 'All smoke tests passed'
  "
  ```
  (No Puppeteer/Chrome check — the broker has neither.)
- Push `--target broker`, guarded on `github.event_name != 'pull_request'`.

The daemon build/push steps gain an explicit `target: daemon` for symmetry (the
default already resolves to daemon, but stating it prevents ambiguity). The
`changes` filter's `vox-eval-agentd` output now gates both images; both live under
`vox_eval_agentd/`, so over-triggering a rebuild is harmless and correct.

## Error / edge handling

- **Broker bundle needs no `node_modules`:** if a future broker edit adds a non-builtin
  import, the `rm -rf node_modules` would break it at runtime. The broker smoke test's
  `node --check` only catches syntax, not missing modules — so the implementation step
  that removes `node_modules` MUST re-verify the broker's import list is builtins-only
  at that time, and the plan calls that out.
- **Default target regression:** if stage order changed so `broker` were last, plain
  builds would silently produce the broker image. The plan verifies `daemon` is the
  final stage and that a no-`--target` build yields the daemon (contains
  `vox-agentd.js` and voice-agent-tester).
- **BuildKit cache reuse:** if the runner's builder did not persist `base` between the
  daemon and broker target builds, `base` would build twice (slower, still correct).
  Acceptable; not a failure.

## Testing

1. **Unit:** broker logic is untouched — the existing broker unit tests (which import
   `session-broker.ts` directly) must still pass. `npm run check` + `npm test`.
2. **Local docker build (both targets), matching CI** — repo-root context,
   `-f vox_eval_agentd/Dockerfile`:
   - `docker build --target daemon -t vox-eval-agentd:test -f vox_eval_agentd/Dockerfile .`
   - `docker build --target broker  -t vox-session-broker:test -f vox_eval_agentd/Dockerfile .`
   - Plain (no `--target`) build → confirm it equals the daemon image.
3. **Smoke both images** as CI does (aeval `--version`; daemon Puppeteer Chrome +
   `node --check vox-agentd.js`; broker `node --check session-broker.js`).
4. **Broker runtime:** `docker compose up`; `GET /health` on the broker returns
   `{status:"ok"}`; a login-class eval mints a session end-to-end.
5. **Size sanity:** `docker images` shows `vox-session-broker` materially smaller than
   `vox-eval-agentd` (no VAT, no Puppeteer Chrome, no `node_modules`).

## Follow-up (not in this change)

Production broker deployment on Coolify (console + secret work):

- Create a Coolify resource pulling `ghcr.io/agora-build/vox-session-broker:latest` on
  an **internal-only** network (no public ingress).
- Env: `SESSION_BROKER_SECRET` (must match Core's), `BROKER_PORT`, `HEADLESS=true`,
  `WEB_SESSION_MINT_TIMEOUT_SECONDS`.
- Point Core's `SESSION_BROKER_URL` at the resource's internal address.
- A redeploy webhook (`COOLIFY_BROKER_WEBHOOK_URL`) firing after the broker image
  publishes — CI scaffolding for this is deliberately deferred.

## Files touched

- `vox_eval_agentd/Dockerfile` — restructure into `base` / `broker` / `daemon` stages.
- `docker-compose.yml` — point `session-broker` at the broker image + target.
- `.github/workflows/docker.yml` — build/smoke/push the broker target alongside the daemon.
- `designs/2026-08-21-aeval-base-broker-split-design.md` — this doc.
