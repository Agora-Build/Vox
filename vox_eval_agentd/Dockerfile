# vox_eval_agentd - Vox Evaluation Agent Daemon
#
# A Docker image that combines aeval and voice-agent-tester with Vox API
# integration for running automated voice agent evaluations.
#
# Base: Ubuntu 24.04 (GLIBC 2.39) — required by aeval's bundled Python runtime.
# Chromium: Puppeteer downloads its own (Ubuntu 24.04 only offers snap Chromium).
#
# Build:
#   docker build -t vox_eval_agentd .
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
    wget \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# --- aeval framework ---
# Download aeval binary from GitHub Release (multi-platform)
ARG TARGETARCH
ARG AEVAL_VERSION=v0.1.1
RUN ARCH=$(case "${TARGETARCH}" in arm64) echo "arm64" ;; *) echo "x86_64" ;; esac) && \
    if [ "${AEVAL_VERSION}" = "latest" ]; then \
      DOWNLOAD_URL="https://github.com/Agora-Build/aeval/releases/latest/download/aeval-linux-${ARCH}"; \
    else \
      DOWNLOAD_URL="https://github.com/Agora-Build/aeval/releases/download/${AEVAL_VERSION}/aeval-linux-${ARCH}"; \
    fi && \
    echo "Downloading aeval from ${DOWNLOAD_URL}" && \
    curl -fSL -o /usr/local/bin/aeval "${DOWNLOAD_URL}" && \
    chmod +x /usr/local/bin/aeval

# Copy aeval runtime data from submodule: config/, examples/, corpus/
COPY aeval-data/ /app/aeval-data/

# --- voice-agent-tester framework ---
# Copy voice-agent-tester from build context
COPY voice-agent-tester/ /app/voice-agent-tester/

# Install voice-agent-tester dependencies and Puppeteer's Chrome
WORKDIR /app/voice-agent-tester
RUN npm install && npx puppeteer browsers install chrome

# Copy vox integration files
WORKDIR /app
COPY applications/ /app/applications/
COPY scenarios/ /app/scenarios/
COPY assets/ /app/assets/
COPY vox-agentd.ts /app/
COPY package.json /app/

# Install daemon dependencies (esbuild for TS compilation)
RUN npm install

# Compile daemon TS → JS
RUN npx esbuild vox-agentd.ts --bundle --platform=node --format=esm --outfile=vox-agentd.js \
    --external:child_process --external:fs --external:os --external:path --external:url

# Environment variables (will be overridden at runtime)
ENV VOX_SERVER=http://localhost:5000
ENV HEADLESS=true
ENV EVAL_FRAMEWORK=aeval

# Output directory for recordings
VOLUME /app/output

# Run the daemon
CMD ["node", "vox-agentd.js"]
