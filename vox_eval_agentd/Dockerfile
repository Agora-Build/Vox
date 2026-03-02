# vox_eval_agentd - Vox Evaluation Agent Daemon
#
# A Docker image that combines aeval and voice-agent-tester with Vox API
# integration for running automated voice agent evaluations.
#
# Build:
#   docker build -t vox_eval_agentd .
#
# Run:
#   docker run -e AGENT_TOKEN=xxx -e VOX_SERVER=http://host.docker.internal:5000 vox_eval_agentd

FROM node:20-slim

# Install Chrome dependencies and ca-certificates
RUN apt-get update && apt-get install -y \
    chromium \
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
    libasound2 \
    wget \
    curl \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Set Puppeteer to use system Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# --- aeval framework ---
# Download aeval binary from GitHub Release (multi-platform)
ARG TARGETARCH
ARG AEVAL_VERSION=latest
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

# Install voice-agent-tester dependencies
WORKDIR /app/voice-agent-tester
RUN npm install

# Copy vox integration files
WORKDIR /app
COPY applications/ /app/applications/
COPY scenarios/ /app/scenarios/
COPY assets/ /app/assets/
COPY vox-agent-daemon.js /app/
COPY package.json /app/

# Install daemon dependencies (none currently, but keep for future)
RUN npm install

# Environment variables (will be overridden at runtime)
ENV VOX_SERVER=http://localhost:5000
ENV VOX_AGENT_NAME="eval-agent"
ENV HEADLESS=true
ENV EVAL_FRAMEWORK=aeval

# Output directory for recordings
VOLUME /app/output

# Run the daemon
CMD ["node", "vox-agent-daemon.js"]
