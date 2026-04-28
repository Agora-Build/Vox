# vox_eval_agentd - Vox Evaluation Agent Daemon
#
# A Docker image that combines aeval and voice-agent-tester with Vox API
# integration for running automated voice agent evaluations.
#
# Base: Ubuntu 24.04 (GLIBC 2.39) — required by aeval's bundled Python runtime.
# Chromium: Puppeteer downloads its own (Ubuntu 24.04 only offers snap Chromium).
#
# Build (from repo root):
#   docker build -f vox_eval_agentd/Dockerfile -t vox_eval_agentd .
#
# Run:
#   docker run -e AGENT_TOKEN=xxx -e VOX_SERVER=http://host.docker.internal:5000 vox_eval_agentd

FROM ubuntu:24.04

# Prevent interactive prompts during apt install
ENV DEBIAN_FRONTEND=noninteractive

# Install Node.js 20 and Chromium system dependencies (Puppeteer downloads its own binary)
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    gnupg \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
       | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
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
ARG AEVAL_VERSION=v0.1.4
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

# --- voice-agent-tester framework ---
COPY vox_eval_agentd/voice-agent-tester/ /app/voice-agent-tester/

# Install voice-agent-tester dependencies and Puppeteer's Chrome
WORKDIR /app/voice-agent-tester
RUN npm install && npx puppeteer browsers install chrome

# Copy vox integration files
WORKDIR /app
COPY vox_eval_agentd/applications/ /app/applications/
COPY vox_eval_agentd/scenarios/ /app/scenarios/
COPY vox_eval_agentd/assets/ /app/assets/
COPY vox_eval_agentd/vox-agentd.ts /app/
COPY vox_eval_agentd/package.json /app/
COPY shared/secrets.ts /shared/secrets.ts

# Install daemon dependencies (esbuild for TS compilation)
RUN npm install

# Compile daemon TS → JS
RUN npx esbuild vox-agentd.ts --bundle --platform=node --format=esm --outfile=vox-agentd.js \
    --external:child_process --external:fs --external:os --external:path --external:url \
    --external:@aws-sdk/client-s3

# Build metadata (injected at build time via --build-arg)
ARG BUILD_TAG=dev
ARG BUILD_DATE=unknown
ARG AEVAL_DATA_COMMIT=unknown
ARG AEVAL_DATA_DATE=unknown
ENV BUILD_TAG=${BUILD_TAG}
ENV BUILD_DATE=${BUILD_DATE}
ENV AEVAL_DATA_COMMIT=${AEVAL_DATA_COMMIT}
ENV AEVAL_DATA_DATE=${AEVAL_DATA_DATE}

# Environment variables (will be overridden at runtime)
ENV VOX_SERVER=http://localhost:5000
ENV HEADLESS=true
ENV EVAL_FRAMEWORK=aeval

# Unified output directory. Both frameworks write to their own subdir by
# default (aeval → /app/aeval-data/output, VAT → /app/voice-agent-tester/output);
# symlink both to /app/output so sessions always land in one place regardless
# of framework choice at runtime.
RUN mkdir -p /app/output \
 && ln -sfn /app/output /app/aeval-data/output \
 && ln -sfn /app/output /app/voice-agent-tester/output
VOLUME /app/output
EXPOSE 8099

# Run the daemon
CMD ["node", "vox-agentd.js"]
