# aeval Base + Broker/Daemon Target Split — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `vox_eval_agentd/Dockerfile` into a shared internal `base` stage plus `broker` and `daemon` targets, publishing two images (`vox-eval-agentd` + a new lean `vox-session-broker`) from one Dockerfile.

**Architecture:** One multi-stage Dockerfile. `base` holds everything both roles share (Ubuntu + Node + Chromium deps + aeval binary + Playwright Chromium + aeval-data). `broker` (`FROM base`) adds only the compiled `session-broker.js` and drops `node_modules`. `daemon` (`FROM base`, the last/default stage) is the current image's content minus the broker. CI builds both targets from the one file, sharing the `base` layer via BuildKit cache.

**Tech Stack:** Docker multi-stage builds (BuildKit/buildx), GitHub Actions (`docker/build-push-action@v6`, `docker/metadata-action@v5`), docker-compose, esbuild.

**Spec:** `designs/2026-08-21-aeval-base-broker-split-design.md`

## Global Constraints

- **Base OS:** `ubuntu:24.04` (GLIBC 2.39, required by aeval's bundled Python runtime). Do not change it.
- **aeval binary:** `ARG AEVAL_VERSION=v0.3.0`, downloaded per `TARGETARCH`.
- **Playwright Chromium:** `playwright==1.57.0`, installed into `/root/.cache/ms-playwright/`.
- **Daemon MUST be the last stage** so `docker build -f vox_eval_agentd/Dockerfile .` with no `--target` yields the daemon image (dev-local-run.sh and plain builds must keep working unchanged).
- **Broker compiled output MUST be named `session-broker.js`** — the entrypoint guard is `process.argv[1].endsWith('session-broker.js')`.
- **Broker esbuild externals stay identical** to the current command: `child_process fs os path url http @aws-sdk/client-s3`.
- **CI push guard:** every login/push step stays guarded on `github.event_name != 'pull_request'`.
- **Image names:** daemon → `${REGISTRY}/${owner}/vox-eval-agentd` (unchanged); broker → `${REGISTRY}/${owner}/vox-session-broker` (new). Local/compose broker tag: `vox-session-broker:latest`.
- **Signatures:** every commit ends with `🤖 Built with SMT <smt@agora.build>`.
- **Docker verification:** builds run from the repo root with `-f vox_eval_agentd/Dockerfile` (matching CI); the aeval-data submodule must be checked out.

---

## File Structure

- `vox_eval_agentd/Dockerfile` — rewritten into three stages (`base`, `broker`, `daemon`). Sole source of both images.
- `vox_eval_agentd/session-broker.ts` — comment-only touch (header line describing how it's deployed).
- `docker-compose.yml` — `session-broker` service points at the broker image + `target: broker`, drops the CMD override.
- `scripts/dev-local-run.sh` — comment-only touch (docker-mode note about the broker image).
- `CLAUDE.md` — Session Broker section note: broker ships as its own image now.
- `.github/workflows/docker.yml` — the `build-vox-eval-agentd` job builds/smokes/pushes both targets.

---

## Task 1: Restructure the Dockerfile into base / broker / daemon stages

**Files:**
- Modify: `vox_eval_agentd/Dockerfile` (full rewrite, same commands regrouped into stages)
- Modify: `vox_eval_agentd/session-broker.ts:7` (comment only)
- Test: real local `docker build` (both targets) from repo root

**Interfaces:**
- Produces: stage names `base`, `broker`, `daemon` (consumed by Tasks 2 and 3); broker default `CMD ["node", "session-broker.js"]` and `EXPOSE 8200`; daemon default `CMD ["node", "vox-agentd.js"]` and `EXPOSE 8099`; `daemon` is the final (default) stage.

- [ ] **Step 1: Confirm the aeval-data submodule is present**

Run:
```bash
git -C "$(git rev-parse --show-toplevel)" submodule update --init --recursive vox_eval_agentd/aeval-data
ls vox_eval_agentd/aeval-data/config >/dev/null && echo "aeval-data present"
```
Expected: prints `aeval-data present`. (The `COPY vox_eval_agentd/aeval-data/` layer fails without it.)

- [ ] **Step 2: Verify the broker target does not exist yet (red)**

Run:
```bash
docker build --target broker -f vox_eval_agentd/Dockerfile -t vox-session-broker:test . 2>&1 | tail -5
```
Expected: FAIL — `target stage "broker" could not be found` (the current Dockerfile is single-stage).

- [ ] **Step 3: Write the new multi-stage Dockerfile**

Replace the entire contents of `vox_eval_agentd/Dockerfile` with:

```dockerfile
# vox_eval_agentd — Vox Evaluation Agent Daemon + Session Broker
#
# One Dockerfile, three stages:
#   base   — shared: Ubuntu + Node + Chromium deps + aeval + Playwright + aeval-data
#   broker — FROM base: session-broker.js only  (published as vox-session-broker)
#   daemon — FROM base: voice-agent-tester + vox-agentd.js  (published as vox-eval-agentd)
#
# `daemon` is the LAST stage, so it is the default --target:
#   docker build -f vox_eval_agentd/Dockerfile -t vox_eval_agentd .                       # → daemon
#   docker build --target broker -f vox_eval_agentd/Dockerfile -t vox-session-broker .    # → broker
#
# Base: Ubuntu 24.04 (GLIBC 2.39) — required by aeval's bundled Python runtime.
# Chromium: Puppeteer/Playwright download their own (Ubuntu 24.04 only offers snap Chromium).

# ============================================================================
# Stage: base — everything both roles share (~all the image weight)
# ============================================================================
FROM ubuntu:24.04 AS base

# Prevent interactive prompts during apt install
ENV DEBIAN_FRONTEND=noninteractive

# Install Node.js 22 and Chromium system dependencies (browser binaries downloaded per-target)
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    gnupg \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
       | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
       > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update && apt-get install -y \
    nodejs \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
    libxss1 \
    libxtst6 \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxkbcommon0 \
    libgbm1 \
    libasound2t64 \
    libxdamage1 \
    libxrandr2 \
    libxcomposite1 \
    libxfixes3 \
    libcups2t64 \
    libpango-1.0-0 \
    libcairo2 \
    libatspi2.0-0t64 \
    libsndfile1 \
    ffmpeg \
    wget \
    zip \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# --- aeval framework ---
# Download aeval binary from GitHub Release (multi-platform)
ARG TARGETARCH
ARG AEVAL_VERSION=v0.3.0
RUN ARCH=$(case "${TARGETARCH}" in arm64) echo "arm64" ;; *) echo "x86_64" ;; esac) && \
    if [ "${AEVAL_VERSION}" = "latest" ]; then \
      DOWNLOAD_URL="https://github.com/Agora-Build/aeval/releases/latest/download/aeval-linux-${ARCH}"; \
    else \
      DOWNLOAD_URL="https://github.com/Agora-Build/aeval/releases/download/${AEVAL_VERSION}/aeval-linux-${ARCH}"; \
    fi && \
    echo "Downloading aeval from ${DOWNLOAD_URL}" && \
    curl -fSL -o /usr/local/bin/aeval "${DOWNLOAD_URL}" && \
    chmod +x /usr/local/bin/aeval

# Install Playwright Chromium for aeval (Python Playwright 1.57.x = chromium-1200)
# aeval is a bundled Python binary that expects browsers at /root/.cache/ms-playwright/
RUN apt-get update && apt-get install -y python3-pip --no-install-recommends \
    && pip3 install --break-system-packages playwright==1.57.0 \
    && playwright install chromium \
    && pip3 uninstall -y playwright --break-system-packages \
    && apt-get purge -y python3-pip && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Copy aeval runtime data from submodule: config/, examples/, corpus/
COPY vox_eval_agentd/aeval-data/ /app/aeval-data/

# Build metadata (injected at build time via --build-arg), shared by both targets
ARG BUILD_TAG=dev
ARG BUILD_DATE=unknown
ARG AEVAL_DATA_COMMIT=unknown
ARG AEVAL_DATA_DATE=unknown
ENV BUILD_TAG=${BUILD_TAG}
ENV BUILD_DATE=${BUILD_DATE}
ENV AEVAL_DATA_COMMIT=${AEVAL_DATA_COMMIT}
ENV AEVAL_DATA_DATE=${AEVAL_DATA_DATE}

# Both roles drive Chromium headless by default
ENV HEADLESS=true

# ============================================================================
# Stage: broker — trusted login sidecar (published as vox-session-broker)
# Lean tip: session-broker.js only. No voice-agent-tester, no daemon code,
# no shared/, no node_modules at runtime (esbuild bundles builtins-only).
# ============================================================================
FROM base AS broker
WORKDIR /app

COPY vox_eval_agentd/session-broker.ts /app/
COPY vox_eval_agentd/package.json /app/

# npm install only to obtain esbuild (a devDep). session-broker.ts imports only
# Node builtins, so the bundle needs no node_modules at runtime — drop it after compile.
RUN npm install \
    && npx esbuild session-broker.ts --bundle --platform=node --format=esm --outfile=session-broker.js \
       --external:child_process --external:fs --external:os --external:path --external:url --external:http \
       --external:@aws-sdk/client-s3 \
    && rm -rf node_modules

EXPOSE 8200

# Run the session broker
CMD ["node", "session-broker.js"]

# ============================================================================
# Stage: daemon — eval-agent daemon (published as vox-eval-agentd)
# LAST stage → the default --target. Current image content, minus the broker.
# ============================================================================
FROM base AS daemon
WORKDIR /app

# --- voice-agent-tester framework (daemon-only) ---
COPY vox_eval_agentd/voice-agent-tester/ /app/voice-agent-tester/
WORKDIR /app/voice-agent-tester
RUN npm install && npx puppeteer browsers install chrome

# --- vox integration files ---
WORKDIR /app
COPY vox_eval_agentd/applications/ /app/applications/
COPY vox_eval_agentd/scenarios/ /app/scenarios/
COPY vox_eval_agentd/assets/ /app/assets/
COPY vox_eval_agentd/vox-agentd.ts /app/
COPY vox_eval_agentd/session-inject.ts /app/
COPY vox_eval_agentd/chunking.ts /app/
COPY vox_eval_agentd/package.json /app/
COPY shared/secrets.ts /shared/secrets.ts
COPY shared/metrics.ts /shared/metrics.ts

# Install daemon dependencies (esbuild for TS compilation)
RUN npm install

# Compile daemon TS → JS
RUN npx esbuild vox-agentd.ts --bundle --platform=node --format=esm --outfile=vox-agentd.js \
    --external:child_process --external:fs --external:os --external:path --external:url --external:http \
    --external:@aws-sdk/client-s3

# Daemon runtime env (overridden at runtime)
ENV VOX_SERVER=http://localhost:5000
ENV EVAL_FRAMEWORK=aeval

# Unified output directory. Both frameworks write to their own subdir by default
# (aeval → /app/aeval-data/output, VAT → /app/voice-agent-tester/output); symlink
# both to /app/output so sessions always land in one place.
RUN mkdir -p /app/output \
 && ln -sfn /app/output /app/aeval-data/output \
 && ln -sfn /app/output /app/voice-agent-tester/output
VOLUME /app/output
EXPOSE 8099

# Run the daemon
CMD ["node", "vox-agentd.js"]
```

- [ ] **Step 4: Update the deploy comment in session-broker.ts**

In `vox_eval_agentd/session-broker.ts`, change line 7 from:
```
 * Deployed from the vox_eval_agentd image with CMD ["node", "session-broker.js"].
```
to:
```
 * Shipped as its own image (vox-session-broker, the Dockerfile's `broker` target).
```

- [ ] **Step 5: Build the daemon (default target) and confirm it is the default (green)**

Run:
```bash
docker build -f vox_eval_agentd/Dockerfile -t vox-eval-agentd:test .
```
Expected: build SUCCEEDS. A no-`--target` build resolves to the last stage (`daemon`).

- [ ] **Step 6: Smoke-test the daemon image**

Run:
```bash
docker run --rm vox-eval-agentd:test bash -c "
  node --version &&
  aeval --version &&
  cd /app/voice-agent-tester &&
    node -e \"const p=require('puppeteer'); const b=p.executablePath();
    require('child_process').execSync(b+' --version --no-sandbox',{stdio:'inherit'})\" &&
  node --check /app/vox-agentd.js &&
  echo 'daemon OK'
"
```
Expected: prints versions and `daemon OK`. Confirms the default build is the daemon (has `vox-agentd.js` + voice-agent-tester).

- [ ] **Step 7: Build and smoke-test the broker target (green)**

Run:
```bash
docker build --target broker -f vox_eval_agentd/Dockerfile -t vox-session-broker:test .
docker run --rm vox-session-broker:test bash -c "
  node --version &&
  aeval --version &&
  node --check /app/session-broker.js &&
  echo 'broker OK'
"
```
Expected: build SUCCEEDS (Step 2's red is now green) and prints `broker OK`.

- [ ] **Step 8: Verify the broker is lean (no VAT, no node_modules)**

Run:
```bash
docker run --rm vox-session-broker:test bash -c '
  test ! -e /app/voice-agent-tester && echo "no voice-agent-tester: OK";
  test ! -e /app/node_modules && echo "no node_modules: OK";
  test ! -e /app/vox-agentd.js && echo "no daemon code: OK"
'
docker images --format '{{.Repository}}:{{.Tag}} {{.Size}}' | grep -E 'vox-(eval-agentd|session-broker):test'
```
Expected: three `... OK` lines, and `vox-session-broker:test` is visibly smaller than `vox-eval-agentd:test`.

- [ ] **Step 9: Commit**

```bash
git add vox_eval_agentd/Dockerfile vox_eval_agentd/session-broker.ts
git commit -m "$(printf 'refactor(agentd): split Dockerfile into base/broker/daemon stages\n\nbase holds the shared aeval+Chromium+aeval-data layers; broker (FROM base)\nships only session-broker.js with no node_modules; daemon (FROM base, last\nstage) is the prior image minus the broker and stays the default target.\n\n\xF0\x9F\xA4\x96 Built with SMT <smt@agora.build>')"
```

---

## Task 2: Point docker-compose (and dev docs) at the broker image + target

**Files:**
- Modify: `docker-compose.yml` (the `session-broker` service + its comment, ~lines 53–71)
- Modify: `scripts/dev-local-run.sh` (docker-mode comment, ~lines 249–252)
- Modify: `CLAUDE.md` (Session Broker section, the broker-sidecar bullet)
- Test: `docker compose config` + `docker compose build session-broker`

**Interfaces:**
- Consumes: the `broker` stage and `vox-session-broker:latest` image name from Task 1.

- [ ] **Step 1: Verify compose still references the old image (red)**

Run:
```bash
grep -n 'vox_eval_agentd:latest\|command: \["node", "session-broker.js"\]' docker-compose.yml
```
Expected: matches on the `image:` line and the `command:` override (the pre-change state).

- [ ] **Step 2: Update the `session-broker` service**

In `docker-compose.yml`, replace the service definition (the comment block plus the service, currently lines 53–71) with:

```yaml
  # Session broker — stateless trusted sidecar, its own lean image built from the
  # Dockerfile's `broker` target (aeval + aeval-data + Chromium only; no
  # voice-agent-tester, no daemon code). It mints a Playwright storageState by
  # driving aeval's `setup:account` flow with the login credential Core passes
  # over the internal network. NO ports are published: only vox-service (same
  # compose network) may reach it.
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

Then, in the commented-out `eval-agent` service block just below, add one line under its `build:` note so a future reader knows it uses the default target:
```yaml
  #     dockerfile: vox_eval_agentd/Dockerfile
  #     target: daemon   # default (last) stage; explicit for clarity
```
(Only add these as comments consistent with that block's existing comment style; do not uncomment the service.)

- [ ] **Step 3: Validate the compose file**

Run:
```bash
docker compose config >/dev/null && echo "compose config valid"
```
Expected: prints `compose config valid` (no YAML/schema error).

- [ ] **Step 4: Build the broker via compose**

Run:
```bash
docker compose build session-broker
```
Expected: builds the `broker` target and tags `vox-session-broker:latest`. SUCCEEDS.

- [ ] **Step 5: Update the dev-local-run.sh docker-mode comment**

In `scripts/dev-local-run.sh`, replace the comment at ~lines 249–252 that reads:
```
    # Bring up the session broker sidecar. No --build: it shares the
    # vox_eval_agentd:latest image with the eval agent, so compose only builds
    # it when that image is absent (a subsequent `docker rmi vox_eval_agentd`
    # forces a rebuild). Started here so a login-class eval can mint a session.
```
with:
```
    # Bring up the session broker sidecar. It builds the Dockerfile's `broker`
    # target into vox-session-broker:latest on first use (compose only rebuilds
    # when the image is absent; `docker rmi vox-session-broker` forces a rebuild).
    # Started here so a login-class eval can mint a session.
```

- [ ] **Step 6: Update the Session Broker note in CLAUDE.md**

In `CLAUDE.md`, in the Session Broker section, change the broker-sidecar bullet's opening from:
```
- **Broker sidecar**: a stateless service built from the agentd image (`vox_eval_agentd/`, CMD override `node session-broker.js`) that mints a `storageState`
```
to:
```
- **Broker sidecar**: a stateless service shipped as its own lean image (`vox-session-broker`, the Dockerfile's `broker` target — aeval + aeval-data + Chromium, no voice-agent-tester or daemon code) that mints a `storageState`
```

- [ ] **Step 7: Commit**

```bash
git add docker-compose.yml scripts/dev-local-run.sh CLAUDE.md
git commit -m "$(printf 'chore(compose): run session-broker from its own vox-session-broker image\n\nCompose now builds the Dockerfile broker target (image vox-session-broker),\ndropping the CMD override on the fat daemon image. Dev-run and CLAUDE.md\nnotes updated to match.\n\n\xF0\x9F\xA4\x96 Built with SMT <smt@agora.build>')"
```

---

## Task 3: Build, smoke, and push the broker target in CI

**Files:**
- Modify: `.github/workflows/docker.yml` (the `build-vox-eval-agentd` job)
- Test: `docker compose config`-style YAML validation + local reproduction of the two target builds

**Interfaces:**
- Consumes: stage names `broker`/`daemon` and image names `vox-eval-agentd`/`vox-session-broker` from Task 1.

- [ ] **Step 1: Add `target: daemon` to the existing daemon build and push steps**

In `.github/workflows/docker.yml`, in the `build-vox-eval-agentd` job, add `target: daemon` under `with:` on BOTH the `Build image` step and the `Push image` step (alongside `context:`/`file:`). Leave everything else on those steps unchanged.

- [ ] **Step 2: Add the broker metadata step**

Immediately after the daemon `Extract metadata` step (`id: meta`), insert:

```yaml
      - name: Extract broker metadata
        id: meta-broker
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ github.repository_owner }}/vox-session-broker
          tags: |
            type=sha,prefix=
            type=raw,value=latest
```

- [ ] **Step 3: Add the broker build + smoke steps**

Immediately after the daemon `Smoke test eval agent image` step, insert:

```yaml
      - name: Build broker image
        uses: docker/build-push-action@v6
        with:
          context: .
          file: ./vox_eval_agentd/Dockerfile
          target: broker
          load: true
          tags: ${{ steps.meta-broker.outputs.tags }}
          labels: ${{ steps.meta-broker.outputs.labels }}
          build-args: |
            BUILD_TAG=${{ github.ref_name }}/${{ github.sha }}
            BUILD_DATE=${{ github.event.head_commit.timestamp }}
            AEVAL_DATA_COMMIT=${{ steps.aeval.outputs.commit }}
            AEVAL_DATA_DATE=${{ steps.aeval.outputs.date }}

      - name: Smoke test broker image
        run: |
          IMAGE_TAG=$(echo '${{ steps.meta-broker.outputs.tags }}' | head -n1)
          docker run --rm "$IMAGE_TAG" bash -c "
            echo '=== Node ===' && node --version &&
            echo '=== aeval ===' && aeval --version &&
            echo '=== Broker syntax ===' && node --check /app/session-broker.js &&
            echo 'All smoke tests passed'
          "
```

- [ ] **Step 4: Add the broker push step**

Immediately after the daemon `Push image` step, insert:

```yaml
      - name: Push broker image
        if: github.event_name != 'pull_request'
        uses: docker/build-push-action@v6
        with:
          context: .
          file: ./vox_eval_agentd/Dockerfile
          target: broker
          push: true
          tags: ${{ steps.meta-broker.outputs.tags }}
          labels: ${{ steps.meta-broker.outputs.labels }}
          build-args: |
            BUILD_TAG=${{ github.ref_name }}/${{ github.sha }}
            BUILD_DATE=${{ github.event.head_commit.timestamp }}
            AEVAL_DATA_COMMIT=${{ steps.aeval.outputs.commit }}
            AEVAL_DATA_DATE=${{ steps.aeval.outputs.date }}
```

- [ ] **Step 5: Validate the workflow YAML**

Run (uses `actionlint` if installed; always runs a YAML parse):
```bash
command -v actionlint >/dev/null && actionlint .github/workflows/docker.yml || echo "actionlint not installed, skipping"
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/docker.yml')); print('docker.yml YAML valid')"
```
Expected: `docker.yml YAML valid` (and no actionlint errors if installed).

- [ ] **Step 6: Confirm CI target names match the Dockerfile stages**

Run:
```bash
grep -n 'target: broker\|target: daemon' .github/workflows/docker.yml
grep -n 'AS broker\|AS daemon' vox_eval_agentd/Dockerfile
```
Expected: the CI `target:` values (`broker`, `daemon`) exactly match the Dockerfile `AS <stage>` names. (The two target builds were already reproduced locally in Task 1, Steps 5–7.)

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/docker.yml
git commit -m "$(printf 'ci(docker): build, smoke, and push the vox-session-broker target\n\nThe build-vox-eval-agentd job now builds both --target daemon\n(vox-eval-agentd) and --target broker (vox-session-broker) from the one\nDockerfile, each smoke-tested, pushed on main only. base layer is reused\nfrom BuildKit cache across the two target builds.\n\n\xF0\x9F\xA4\x96 Built with SMT <smt@agora.build>')"
```

---

## Task 4: Whole-change verification

**Files:** none (verification only)

- [ ] **Step 1: Type-check and unit tests (broker logic must stay green)**

Run:
```bash
npm run check && npm test 2>&1 | tail -20
```
Expected: `npm run check` passes; the broker unit tests (which import `session-broker.ts` directly) pass. Note any pre-existing unrelated failures from the known drift baseline (do not attribute them to this change).

- [ ] **Step 2: Clean-cache build of both targets (matches CI cold build)**

Run:
```bash
docker build --no-cache --target broker -f vox_eval_agentd/Dockerfile -t vox-session-broker:verify .
docker build --target daemon -f vox_eval_agentd/Dockerfile -t vox-eval-agentd:verify .
```
Expected: both succeed. (The daemon build reuses the freshly-cached `base` from the broker build — proof the shared base is built once and reused.)

- [ ] **Step 3: Broker runtime health check via compose**

Run:
```bash
SESSION_BROKER_SECRET=local-broker-secret-change-me docker compose up -d session-broker
sleep 3
docker exec vox-session-broker node -e "require('http').get('http://127.0.0.1:8200/health',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{console.log(r.statusCode,d)})})"
docker compose down
```
Expected: prints `200 {"status":"ok"}`.

- [ ] **Step 4: Record image sizes for the PR description**

Run:
```bash
docker images --format '{{.Repository}}:{{.Tag}} {{.Size}}' | grep -E 'vox-(eval-agentd|session-broker):verify'
```
Expected: `vox-session-broker:verify` materially smaller than `vox-eval-agentd:verify`. Capture both numbers for the PR body.

- [ ] **Step 5: Pre-merge gate**

Per project convention, before opening the PR for merge run the full suite:
```bash
./scripts/full-tests-run.sh
```
Expected: unit + audio + E2E pass (start local services first with `./scripts/dev-local-run.sh start` if needed). This change is Docker-only, so no app-level regressions are expected.

---

## Self-Review

- **Spec coverage:** base/broker/daemon stages (Task 1) ✓; daemon-is-default-target constraint verified (Task 1 Steps 5–6) ✓; broker leanness incl. no-node_modules (Task 1 Step 8) ✓; compose points at broker image+target (Task 2) ✓; doc stragglers dev-local-run.sh + CLAUDE.md + session-broker.ts comment (Tasks 1–2) ✓; CI two-target build/smoke/push with PR push-guard (Task 3) ✓; deploy follow-up is explicitly out of scope (design §7) — no task, correct ✓; testing incl. real local builds, health check, size sanity (Tasks 1 & 4) ✓.
- **Placeholder scan:** no TBD/TODO; every code/edit step carries exact content.
- **Type/name consistency:** stage names `base`/`broker`/`daemon`, image names `vox-eval-agentd`/`vox-session-broker`, output name `session-broker.js`, and esbuild externals are identical everywhere they appear across Tasks 1–3.
- **Risk called out:** `rm -rf node_modules` depends on the broker importing only Node builtins — verified in the spec's grounding section against `session-broker.ts`; if a future edit adds a non-builtin import, Task 1 Step 7's smoke `node --check` catches syntax but not missing modules, so the broker runtime health check (Task 4 Step 3) is the backstop.
